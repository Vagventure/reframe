// ffmpeg.ts — Main-thread coordinator for the FFmpeg Web Worker.
// Emoji SVGs are rasterised here (canvas API unavailable in workers),
// then transferred as pre-rendered PNG ArrayBuffers.

import { EditRecipe, ExportResult, BackgroundMusicOptions, ImageOverlayOptions, OverlayElement } from "./types";
import { getPresetById } from "./presets";
import { buildTextFilter } from "./text-overlay";

export class FFmpegLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FFmpegLoadError";
  }
}

const EMOJI_RENDER_SIZE = 128; // px — rasterised here, worker scales per element.scale

// ─── Worker message types ─────────────────────────────────────────────────────

type SerializedFile = { name: string; type: string; data: ArrayBuffer };

export type SerializedEmoji = {
  pngData: ArrayBuffer;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  unicode: string;
};

type WorkerExportRequest = {
  type: "export";
  id: string;
  file: SerializedFile;
  recipe: EditRecipe;
  videoDuration: number;
  musicFile?: SerializedFile;
  musicOptions?: BackgroundMusicOptions;
  overlayFile?: SerializedFile;
  overlayOptions?: ImageOverlayOptions;
  emojiOverlays?: SerializedEmoji[];
};

type WorkerLoadResponse     = { type: "ready" };
type WorkerProgressResponse = { type: "progress"; percent: number };
type WorkerResultResponse   = {
  type: "result"; id: string; data: ArrayBuffer;
  mimeType: string; size: number; width: number; height: number;
  format: "mp4" | "webm" | "mkv" | "gif";
};
type WorkerErrorResponse     = { type: "error"; id?: string; message: string };
type WorkerCancelledResponse = { type: "cancelled"; id?: string };

type WorkerResponse =
  | WorkerLoadResponse | WorkerProgressResponse | WorkerResultResponse
  | WorkerErrorResponse | WorkerCancelledResponse;

// ─── Worker singleton ─────────────────────────────────────────────────────────

let ffmpegWorker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let workerReadyResolve: (() => void) | null = null;
let workerReadyReject: ((reason?: unknown) => void) | null = null;
let pendingExport: {
  id: string;
  resolve: (result: ExportResult) => void;
  reject: (reason: unknown) => void;
} | null = null;
let pendingProgress: ((percent: number) => void) | null = null;

function handleWorkerMessage(event: MessageEvent<WorkerResponse>) {
  const data = event.data;

  if (data.type === "ready") {
    workerReadyResolve?.();
    workerReadyResolve = null;
    workerReadyReject = null;
    pendingProgress?.(100);
    return;
  }
  if (data.type === "progress") {
    pendingProgress?.(data.percent);
    return;
  }
  if (data.type === "result") {
    if (pendingExport?.id !== data.id) return;
    const blob = new Blob([data.data], { type: data.mimeType });
    pendingExport.resolve({
      blobUrl: URL.createObjectURL(blob),
      blob,
      size: data.size,
      width: data.width,
      height: data.height,
      format: data.format,
    });
    pendingExport = null;
    pendingProgress = null;
    return;
  }
  if (data.type === "error") {
    if (data.id && pendingExport?.id === data.id) {
      pendingExport.reject(new Error(data.message));
      pendingExport = null;
      pendingProgress = null;
      return;
    }
    workerReadyReject?.(new FFmpegLoadError(data.message));
    workerReady = null;
    workerReadyResolve = null;
    workerReadyReject = null;
    resetWorker();
    return;
  }
  if (data.type === "cancelled") {
    if (data.id && pendingExport?.id === data.id) {
      pendingExport.reject(new DOMException("Export cancelled", "AbortError"));
      pendingExport = null;
      pendingProgress = null;
    }
    return;
  }
}

function createWorker(): Worker {
  if (typeof window === "undefined") {
    throw new Error("Web Workers are not available in this environment.");
  }
  // MUST be strictly inline for Next.js/Webpack to detect and compile the worker chunk
  ffmpegWorker = new Worker(new URL("./ffmpeg.worker.ts", import.meta.url), { type: "module" });
  ffmpegWorker.onmessage = handleWorkerMessage;
  ffmpegWorker.onerror = (event) => {
    const error = new FFmpegLoadError(event.message || "FFmpeg worker error");
    workerReadyReject?.(error);
    pendingExport?.reject(error);
    resetWorker();
  };
  workerReady = new Promise((resolve, reject) => {
    workerReadyResolve = resolve;
    workerReadyReject = reject;
  });
  return ffmpegWorker;
}

function resetWorker() {
  ffmpegWorker = null;
  workerReady = null;
  workerReadyResolve = null;
  workerReadyReject = null;
  pendingExport = null;
  pendingProgress = null;
}

function cancelPendingExport(reason?: unknown) {
  if (pendingExport) {
    pendingExport.reject(reason ?? new DOMException("Export cancelled", "AbortError"));
    pendingExport = null;
  }
  pendingProgress = null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadFFmpeg(
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<void> {
  const isFirstLoad = !ffmpegWorker;
  if (!ffmpegWorker) createWorker();

  if (workerReady && workerReadyResolve === null) {
    onProgress?.(100);
    return;
  }

  if (isFirstLoad) {
    ffmpegWorker!.postMessage({ type: "load" });
  }

  pendingProgress = onProgress ?? null;

  if (signal?.aborted) {
    ffmpegWorker?.postMessage({ type: "cancel" });
    throw new DOMException("Aborted", "AbortError");
  }

  const onAbort = () => {
    ffmpegWorker?.postMessage({ type: "cancel" });
    workerReadyReject?.(new DOMException("Aborted", "AbortError"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await workerReady;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Rasterises an emoji SVG to PNG ArrayBuffer using canvas (main thread only).
 * Falls back to drawing the unicode char as text if SVG fetch fails.
 */
async function rasteriseEmojiToPng(svgUrl: string, size: number, unicode: string): Promise<ArrayBuffer> {
  const canvasToBuffer = (canvas: HTMLCanvasElement): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("toBlob failed")); return; }
        blob.arrayBuffer().then(resolve).catch(reject);
      }, "image/png");
    });

  // Attempt 1: fetch SVG → blob URL → draw via Image
  try {
    const res = await fetch(svgUrl, { mode: "cors" });
    if (!res.ok) throw new Error(`SVG fetch ${res.status}`);
    const svgText = await res.text();
    const objectUrl = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) { URL.revokeObjectURL(objectUrl); reject(new Error("No 2D ctx")); return; }
        ctx.drawImage(img, 0, 0, size, size);
        URL.revokeObjectURL(objectUrl);
        canvasToBuffer(canvas).then(resolve).catch(reject);
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("img load failed")); };
      img.src = objectUrl;
    });
    return buf;
  } catch (e) {
    console.warn(`[emoji] SVG fetch failed for ${unicode}, using text fallback:`, e);
  }

  // Attempt 2: draw unicode char as text on canvas (no network needed)
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${Math.round(size * 0.8)}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(unicode, size / 2, size / 2);
  return canvasToBuffer(canvas);
}

export async function exportVideo(
  file: File,
  recipe: EditRecipe,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
  musicOptions?: BackgroundMusicOptions,
  overlayOptions?: ImageOverlayOptions,
  overlayElements?: OverlayElement[]
): Promise<ExportResult> {
  await loadFFmpeg(signal, onProgress);
  if (!ffmpegWorker) throw new Error("FFmpeg worker is not available.");

  const sessionId = buildSessionId();

  const arrayBuffer = await file.arrayBuffer();
  const filePayload: SerializedFile = { name: file.name, type: file.type || "video/mp4", data: arrayBuffer };

  const musicFilePayload = musicOptions?.file
    ? { name: musicOptions.file.name, type: musicOptions.file.type || "audio/mpeg", data: await musicOptions.file.arrayBuffer() }
    : undefined;

  const overlayFilePayload = overlayOptions?.file
    ? { name: overlayOptions.file.name, type: overlayOptions.file.type || "image/png", data: await overlayOptions.file.arrayBuffer() }
    : undefined;

  // Rasterise emojis on main thread — canvas not available in workers
  const emojiOverlays: SerializedEmoji[] = [];
  for (const el of overlayElements ?? []) {
    try {
      const pngData = await rasteriseEmojiToPng(el.src, EMOJI_RENDER_SIZE, el.unicode ?? el.src);
      emojiOverlays.push({ pngData, x: el.x, y: el.y, scale: el.scale, rotation: el.rotation, unicode: el.unicode ?? "" });
      console.log(`[emoji] ✓ rasterised ${el.unicode}`);
    } catch (e) {
      console.error(`[emoji] ✗ failed ${el.unicode}`, e);
    }
  }

  const sanitizedMusicOptions   = musicOptions   ? { ...musicOptions,   file: null } : undefined;
  const sanitizedOverlayOptions = overlayOptions ? { ...overlayOptions, file: null } : undefined;

  pendingProgress = onProgress;
  const exportPromise = new Promise<ExportResult>((resolve, reject) => {
    pendingExport = { id: sessionId, resolve, reject };
  });

  if (signal?.aborted) {
    ffmpegWorker.postMessage({ type: "cancel" });
    cancelPendingExport(new DOMException("Aborted", "AbortError"));
    throw new DOMException("Aborted", "AbortError");
  }

  const onAbort = () => {
    ffmpegWorker?.postMessage({ type: "cancel" });
    cancelPendingExport(new DOMException("Aborted", "AbortError"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // Collect all transferable ArrayBuffers for zero-copy transfer to worker
  const transfers: Transferable[] = [arrayBuffer];
  if (musicFilePayload)   transfers.push(musicFilePayload.data);
  if (overlayFilePayload) transfers.push(overlayFilePayload.data);
  for (const em of emojiOverlays) transfers.push(em.pngData);

  ffmpegWorker.postMessage(
    {
      type: "export",
      id: sessionId,
      file: filePayload,
      recipe,
      videoDuration: await getVideoDuration(file),
      musicFile: musicFilePayload,
      musicOptions: sanitizedMusicOptions,
      overlayFile: overlayFilePayload,
      overlayOptions: sanitizedOverlayOptions,
      emojiOverlays,
    } as WorkerExportRequest,
    transfers
  );

  try {
    return await exportPromise;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => { URL.revokeObjectURL(video.src); resolve(video.duration); };
    video.onerror = () => resolve(0);
    video.src = URL.createObjectURL(file);
  });
}

export function terminateFFmpeg() {
  if (ffmpegWorker) {
    ffmpegWorker.postMessage({ type: "terminate" });
    ffmpegWorker.terminate();
  }
  cancelPendingExport(new DOMException("Export cancelled", "AbortError"));
  resetWorker();
}

function buildSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ─── Re-exported filter builders (used by other modules) ──────────────────────

export function buildVideoFilter(recipe: EditRecipe, targetW: number, targetH: number): string {
  const filters: string[] = [];
  if (recipe.trimStart > 0 || recipe.trimEnd !== null) {
    const end = recipe.trimEnd !== null ? recipe.trimEnd : 999999;
    filters.push(`trim=start=${recipe.trimStart}:end=${end}`);
  }
  if (recipe.stabilization) filters.push("deshake");
  if (recipe.rotate === 90)       filters.push("transpose=1");
  else if (recipe.rotate === 180) filters.push("transpose=1,transpose=1");
  else if (recipe.rotate === 270) filters.push("transpose=2");
  if (recipe.framing === "fit") {
    filters.push(
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black`
    );
  } else {
    filters.push(
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase`,
      `crop=${targetW}:${targetH}`
    );
  }
  if (recipe.trimStart > 0 || recipe.trimEnd !== null || recipe.speed !== 1) filters.push("setpts=PTS-STARTPTS");
  if (recipe.speed !== 1) filters.push(`setpts=${(1 / recipe.speed).toFixed(4)}*PTS`);
  if (recipe.denoise) filters.push("hqdn3d=1.5:1.5:6:6");
  const needsEq = recipe.brightness !== 0 || recipe.contrast !== 1 || recipe.saturation !== 1;
  if (needsEq) filters.push(`eq=brightness=${recipe.brightness}:contrast=${recipe.contrast}:saturation=${recipe.saturation}`);
  (recipe.textOverlays ?? []).forEach((o) => filters.push(buildTextFilter(o, targetW, targetH)));
  return filters.join(",");
}

export function buildAudioFilter(speed: number, normalizeAudio: boolean): string {
  if (speed <= 0) return "";
  const filters: string[] = [];
  let remaining = speed;
  while (remaining < 0.5)  { filters.push("atempo=0.5"); remaining /= 0.5; }
  while (remaining > 2.0)  { filters.push("atempo=2.0"); remaining /= 2.0; }
  if (Math.abs(remaining - 1.0) > 0.001) filters.push(`atempo=${Number(remaining.toFixed(4))}`);
  if (normalizeAudio) filters.push("loudnorm=I=-14:TP=-1.5:LRA=11");
  return filters.join(",");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}