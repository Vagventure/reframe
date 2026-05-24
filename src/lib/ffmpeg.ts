import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { EditRecipe, ExportResult, BackgroundMusicOptions, ImageOverlayOptions, OverlayElement } from "./types";
import { getPresetById } from "./presets";
import { buildTextFilter } from "./text-overlay";

const EMOJI_RENDER_SIZE = 128; // px — SVGs rasterised at this size, scaled per element.scale


let ffmpegInstance: FFmpeg | null = null;

/**
 * Error thrown when the FFmpeg WebAssembly core fails to load.
 */
export class FFmpegLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FFmpegLoadError";
  }
}

export async function loadFFmpeg(
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    onProgress?.(100);
    return ffmpegInstance;
  }

  const ffmpeg = ffmpegInstance ?? new FFmpeg();
  ffmpegInstance = ffmpeg;

  const handleProgress = ({ progress }: { progress: number }) => {
    onProgress?.(Math.round(progress * 100));
  };

  try {
    ffmpeg.on("progress", handleProgress);

    // CDN fallback chain — try jsDelivr first (most reliable behind proxies/firewalls),
    // then unpkg. Both serve the same single-threaded @ffmpeg/core@0.12.6 ESM build.
    // Single-threaded is intentional: the multi-thread build needs COOP/COEP headers
    // (crossOriginIsolated) which most dev servers and many hosts do not set.
    const CDN_CANDIDATES = [
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd",
      "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd",
    ];

    let lastErr: unknown;
    for (const baseURL of CDN_CANDIDATES) {
      try {
        const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript");
        const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm");
        await ffmpeg.load({ coreURL, wasmURL }, { signal });
        // Success — break out of loop
        onProgress?.(100);
        return ffmpeg;
      } catch (e) {
        lastErr = e;
        // This CDN failed — loop will try the next one
      }
    }
    // All CDNs failed
    throw lastErr;
  } catch (err) {
    if (ffmpegInstance === ffmpeg) {
      ffmpegInstance = null;
    }
    throw new FFmpegLoadError("Failed to load the FFmpeg engine. Check your internet connection.");
  } finally {
    ffmpeg.off("progress", handleProgress);
  }
}

export function terminateFFmpeg() {
  ffmpegInstance?.terminate();
  ffmpegInstance = null;
}

function buildSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildVideoFilter(recipe: EditRecipe, targetW: number, targetH: number): string {
  const filters: string[] = [];

  if (recipe.trimStart > 0 || recipe.trimEnd !== null) {
    const end = recipe.trimEnd !== null ? recipe.trimEnd : 999999;
    filters.push(`trim=start=${recipe.trimStart}:end=${end}`);
    filters.push("setpts=PTS-STARTPTS");
  }


  if (recipe.stabilization) {
    filters.push("deshake");
  }

  if (recipe.rotate === 90) {
    filters.push("transpose=1");
  } else if (recipe.rotate === 180) {
    filters.push("transpose=1,transpose=1");
  } else if (recipe.rotate === 270) {
    filters.push("transpose=2");
  }

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

  if (recipe.speed !== 1) {
  const pts = (1 / recipe.speed).toFixed(4);
  filters.push(`setpts=${pts}*PTS`);
  }

  if (recipe.denoise) {
    filters.push("hqdn3d=1.5:1.5:6:6");
  }

  filters.push(
    `eq=brightness=${recipe.brightness}:contrast=${recipe.contrast}:saturation=${recipe.saturation}`
  );

  // Add text overlays
  const textOverlays = recipe.textOverlays || [];
  textOverlays.forEach((overlay) => {
    filters.push(buildTextFilter(overlay, targetW, targetH));
  });

  return filters.join(",");
}

 export function buildAudioFilter(speed: number, normalizeAudio: boolean): string {
  if (speed <= 0) return "";
  const filters: string[] = [];

  let remaining = speed;
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }

  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }

 if (Math.abs(remaining - 1.0) > 0.001) {
    filters.push(`atempo=${Number(remaining.toFixed(4))}`);
  }

  if (normalizeAudio) filters.push("loudnorm=I=-14:TP=-1.5:LRA=11");

  return filters.join(",");
}

function buildAudioTrimFilter(recipe: EditRecipe): string {
  if (recipe.trimStart === 0 && recipe.trimEnd === null) return "";
  const end = recipe.trimEnd !== null ? recipe.trimEnd : 999999;
  return `atrim=start=${recipe.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
}

function buildArguments(
  recipe: EditRecipe,
  format: "mp4" | "webm" | "mkv" | "gif",
  outputName: string,
  inputName: string,
  targetW: number,
  targetH: number,
  hasMusicTrack: boolean,
  musicInputName: string,
  musicOptions: BackgroundMusicOptions | undefined,
  hasOverlay: boolean,
  overlayInputName: string,
  overlayOptions: ImageOverlayOptions | undefined,
  hasOriginalAudio: boolean,
  // Emoji stickers: parallel arrays — filenames already written to FFmpeg VFS
  emojiInputNames: string[] = [],
  emojiElements: OverlayElement[] = [],
): string[] {
  const vf = buildVideoFilter(recipe, targetW, targetH);
  const audioTrim = hasOriginalAudio ? buildAudioTrimFilter(recipe) : "";
  const audioSpeed = hasOriginalAudio ? buildAudioFilter(recipe.speed, recipe.normalizeAudio ?? false) : "";
  const afParts = [audioTrim, audioSpeed].filter(Boolean);
  const af = afParts.join(",");

  const hasEmojis = emojiInputNames.length > 0;

  // Input index bookkeeping
  // 0 = video, 1 = music (if any), next = imageOverlay (if any), then emojis
  const musicIdx = 1;
  const overlayIdx = hasMusicTrack ? 2 : 1;
  const emojiStartIdx = 1 + (hasMusicTrack ? 1 : 0) + (hasOverlay ? 1 : 0);

  const args: string[] = [];
  args.push("-i", inputName);
  if (hasMusicTrack) {
    if (musicOptions!.loopMusic) args.push("-stream_loop", "-1");
    args.push("-i", musicInputName);
  }
  if (hasOverlay) {
    args.push("-i", overlayInputName);
  }
  // Add emoji PNG inputs
  for (const name of emojiInputNames) {
    args.push("-i", name);
  }

  // filter_complex is required whenever we have overlay, music, or emojis
  const needsFilterComplex = hasOverlay || hasMusicTrack || hasEmojis;
  const shouldKeepAudio = recipe.keepAudio && (hasOriginalAudio || hasMusicTrack);

  if (needsFilterComplex) {
    const filterParts: string[] = [];
    let videoOut = "[0:v]";

    // Apply video filters first (scale, eq, text, etc.)
    if (vf) {
      filterParts.push(`[0:v]${vf}[vbase]`);
      videoOut = "[vbase]";
    }

    // Apply image overlay (logo/watermark)
    if (hasOverlay) {
      const scaledW = overlayOptions!.size;
      const alpha = (overlayOptions!.opacity / 100).toFixed(2);
      const posMap: Record<string, string> = {
        "top-left":     "20:20",
        "top-right":    "W-w-20:20",
        "bottom-left":  "20:H-h-20",
        "bottom-right": "W-w-20:H-h-20",
      };
      const pos = posMap[overlayOptions!.position] ?? "W-w-20:H-h-20";
      filterParts.push(`[${overlayIdx}:v]scale=${scaledW}:-2,format=rgba,colorchannelmixer=aa=${alpha}[logo]`);
      filterParts.push(`${videoOut}[logo]overlay=${pos}[vafter_logo]`);
      videoOut = "[vafter_logo]";
    }

    // Daisy-chain each emoji sticker as an overlay
    if (hasEmojis) {
      emojiElements.forEach((el, i) => {
        const inputLabel = `[${emojiStartIdx + i}:v]`;
        const scaledSize = Math.round(EMOJI_RENDER_SIZE * el.scale);
        // Centre the emoji on its (x%, y%) position
        const pixelX = Math.round((el.x / 100) * targetW) - Math.round(scaledSize / 2);
        const pixelY = Math.round((el.y / 100) * targetH) - Math.round(scaledSize / 2);
        const emojiLabel = `[em${i}]`;
        const outLabel = `[vem${i}]`;

        if (el.rotation !== 0) {
          // Scale + rotate into a labelled pad, then overlay
          filterParts.push(
            `${inputLabel}scale=${scaledSize}:${scaledSize},rotate=${el.rotation}*PI/180:c=none:ow=rotw(${el.rotation}*PI/180):oh=roth(${el.rotation}*PI/180)${emojiLabel}`
          );
        } else {
          filterParts.push(`${inputLabel}scale=${scaledSize}:${scaledSize}${emojiLabel}`);
        }
        filterParts.push(`${videoOut}${emojiLabel}overlay=${pixelX}:${pixelY}${outLabel}`);
        videoOut = outLabel;
      });
    }

    // Audio mixing
    let audioOut = "";
    if (shouldKeepAudio) {
      if (hasMusicTrack) {
        const musicVol = (musicOptions!.musicVolume / 100).toFixed(2);
        if (hasOriginalAudio) {
          const origVol = (musicOptions!.originalAudioVolume / 100).toFixed(2);
          const origChain = afParts.length > 0
            ? `[0:a]${afParts.join(",")},volume=${origVol}[orig]`
            : `[0:a]volume=${origVol}[orig]`;
          filterParts.push(origChain);
          filterParts.push(`[${musicIdx}:a]volume=${musicVol}[music]`);
          filterParts.push(`[orig][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
          audioOut = "[aout]";
        } else {
          filterParts.push(`[${musicIdx}:a]volume=${musicVol}[aout]`);
          audioOut = "[aout]";
        }
      } else if (hasOriginalAudio && af) {
        filterParts.push(`[0:a]${af}[aout]`);
        audioOut = "[aout]";
      }
    }

    if (filterParts.length > 0) {
      args.push("-filter_complex", filterParts.join(";"));
    }
    // Map the final video label (strip brackets for plain stream specifiers)
    args.push("-map", videoOut === "[0:v]" ? "0:v" : videoOut);

    if (!shouldKeepAudio) {
      args.push("-an");
    } else if (audioOut) {
      args.push("-map", audioOut);
    } else if (hasOriginalAudio) {
      args.push("-map", "0:a");
    }
  } else {
    // Simple path: no filter_complex needed
    if (vf) args.push("-vf", vf);
    if (!shouldKeepAudio) {
      args.push("-an");
    } else if (af && hasOriginalAudio) {
      args.push("-af", af);
    }
  }

  if (format === "webm") {
    args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(recipe.quality));
    if (shouldKeepAudio) args.push("-c:a", "libopus");
  } else if (format === "mkv") {
    args.push("-c:v", "libx264", "-crf", String(recipe.quality), "-preset", "medium");
    if (shouldKeepAudio) args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-c:v", "libx264", "-crf", String(recipe.quality), "-preset", "medium", "-movflags", "+faststart");
    if (shouldKeepAudio) args.push("-c:a", "aac", "-b:a", "128k");
  }

  args.push(outputName);
  return args;
}

/**
 * Rasterises an emoji SVG URL to a PNG Uint8Array for FFmpeg.
 *
 * Strategy:
 * 1. Fetch SVG text, blob-URL it, draw onto canvas (works when CORS allows).
 * 2. If fetch/draw fails, fall back to drawing the unicode character as text
 *    on a canvas — guaranteed to work offline / behind CORS restrictions.
 */
async function rasteriseSvgToPng(svgUrl: string, size: number, unicodeFallback?: string): Promise<Uint8Array> {
  const canvasToUint8Array = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) { reject(new Error("Canvas toBlob failed")); return; }
        pngBlob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      }, "image/png");
    });

  // Attempt 1: fetch SVG and draw via Image element
  try {
    const res = await fetch(svgUrl, { mode: "cors" });
    if (!res.ok) throw new Error(`SVG fetch ${res.status}`);
    const svgText = await res.text();
    const blob = new Blob([svgText], { type: "image/svg+xml" });
    const objectUrl = URL.createObjectURL(blob);

    const pngData = await new Promise<Uint8Array>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) { URL.revokeObjectURL(objectUrl); reject(new Error("No 2D context")); return; }
        ctx.drawImage(img, 0, 0, size, size);
        URL.revokeObjectURL(objectUrl);
        canvasToUint8Array(canvas).then(resolve).catch(reject);
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("SVG img load failed")); };
      img.src = objectUrl;
    });
    return pngData;
  } catch (svgErr) {
    console.warn("[emoji export] SVG fetch/draw failed, using text fallback:", svgErr);
  }

  // Attempt 2: draw unicode emoji as text on canvas (no network needed)
  if (unicodeFallback) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const fontSize = Math.round(size * 0.8);
      ctx.font = `${fontSize}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(unicodeFallback, size / 2, size / 2);
      return canvasToUint8Array(canvas);
    }
  }

  throw new Error(`Failed to rasterise emoji: ${svgUrl}`);
}

export async function exportVideo(
  ffmpeg: FFmpeg,
  file: File,
  recipe: EditRecipe,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
  musicOptions?: BackgroundMusicOptions,
  overlayOptions?: ImageOverlayOptions,
  overlayElements?: OverlayElement[]
): Promise<ExportResult> {
  const sessionId = buildSessionId();
  let targetW: number, targetH: number;
  if (recipe.preset === "custom") {
    targetW = recipe.customWidth;
    targetH = recipe.customHeight;
  } else {
    const preset = getPresetById(recipe.preset);
    targetW = preset?.width ?? 1920;
    targetH = preset?.height ?? 1080;
  }

  targetW = Math.round(targetW / 2) * 2;
  targetH = Math.round(targetH / 2) * 2;

  const ext = file.name.split(".").pop() ?? "mp4";
  const inputName = `input_${sessionId}.${ext}`;

  const getOutputConfig = (format: string) => {
    switch (format) {
      case "webm":
        return { filename: `output_${sessionId}.webm`, mimeType: "video/webm" };
      case "mkv":
        return { filename: `output_${sessionId}.mkv`, mimeType: "video/x-matroska" };
      case "gif":
        return { filename: `output_${sessionId}.gif`, mimeType: "image/gif" };
      default:
        return { filename: `output_${sessionId}.mp4`, mimeType: "video/mp4" };
    }
  };

  const { filename: outputName, mimeType } = getOutputConfig(recipe.format);
  const fallbackOutputName = `fallback_${sessionId}.webm`;
  const paletteName = `palette_${sessionId}.png`;
  const cleanupFiles = new Set<string>([inputName, outputName, fallbackOutputName, paletteName]);

  const handleProgress = ({ progress }: { progress: number }) => {
    onProgress(Math.min(99, Math.round(progress * 100)));
  };


  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file), { signal });

    const vf = buildVideoFilter(recipe, targetW, targetH);
  const audioTrim = buildAudioTrimFilter(recipe);
  const audioSpeed = buildAudioFilter(recipe.speed, recipe.normalizeAudio ?? false);

  const afParts = [audioTrim, audioSpeed].filter(Boolean);
  const af = afParts.join(",");
    const hasMusicTrack = !!(musicOptions?.file && recipe.keepAudio);
    const musicInputName = `music_input_${sessionId}.mp3`;
    if (hasMusicTrack) {
      await ffmpeg.writeFile(musicInputName, await fetchFile(musicOptions!.file!), { signal });
      cleanupFiles.add(musicInputName);
    }

    const hasOverlay = !!(overlayOptions?.file);
    const overlayExt = overlayOptions?.file?.name.split(".").pop() ?? "png";
    const overlayInputName = `overlay_${sessionId}.${overlayExt}`;
    if (hasOverlay) {
      await ffmpeg.writeFile(overlayInputName, await fetchFile(overlayOptions!.file!), { signal });
      cleanupFiles.add(overlayInputName);
    }

    // ── Emoji sticker overlays — rasterise SVGs to PNG and write to VFS ────
    const activeEmojis = (overlayElements ?? []);
    const EMOJI_RENDER_SIZE = 128; // px — rasterise at 128px, FFmpeg will scale per element.scale
    const emojiInputNames: string[] = [];

    for (let i = 0; i < activeEmojis.length; i++) {
      const el = activeEmojis[i]!;
      const emojiName = `emoji_${sessionId}_${i}.png`;
      try {
        // Pass unicode as fallback so canvas text-draw works if SVG fetch fails
        const pngData = await rasteriseSvgToPng(el.src, EMOJI_RENDER_SIZE, el.unicode);
        await ffmpeg.writeFile(emojiName, pngData, { signal });
        cleanupFiles.add(emojiName);
        emojiInputNames.push(emojiName);
        console.log(`[emoji export] ✓ rasterised emoji ${i}: ${el.unicode}`);
      } catch (e) {
        console.error(`[emoji export] ✗ failed emoji ${i}: ${el.unicode}`, e);
        emojiInputNames.push(""); // skip failed emojis
      }
    }

    ffmpeg.on("progress", handleProgress);

    // ── Two-pass GIF export ──────────────────────────────────────────────────
    if (recipe.format === "gif") {
      const vf = buildVideoFilter(recipe, targetW, targetH);
      const vfWithPalette = vf ? `${vf},palettegen` : "palettegen";
      const vfWithPaletteUse = vf
        ? `[0:v]${vf}[x];[x][1:v]paletteuse`
        : "[0:v][1:v]paletteuse";

      // Pass 1: generate colour palette
      const pass1Code = await ffmpeg.exec(
        ["-i", inputName, "-vf", vfWithPalette, "-y", paletteName],
        undefined,
        { signal }
      );
      if (pass1Code !== 0) throw new Error("GIF palette generation failed");

      // Pass 2: render GIF using the palette
      const pass2Code = await ffmpeg.exec(
        ["-i", inputName, "-i", paletteName, "-lavfi", vfWithPaletteUse, "-y", outputName],
        undefined,
        { signal }
      );
      if (pass2Code !== 0) throw new Error("GIF export failed");

      const data = await ffmpeg.readFile(outputName, undefined, { signal });
      const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: "image/gif" });

      ffmpeg.off("progress", handleProgress);
      onProgress(100);
      return {
        blobUrl: URL.createObjectURL(blob),
        blob,
        size: blob.size,
        width: targetW,
        height: targetH,
        format: "gif" as const,
      };
    }
    // ────────────────────────────────────────────────────────────────────────

    let missingAudioDetected = false;
    const logListener = ({ message }: { message: string }) => {
      const msg = message.toLowerCase();
      if (
        msg.includes("matches no streams") ||
        msg.includes("specifier '0:a'") ||
        msg.includes("input pad 0 on filter src")
      ) {
        missingAudioDetected = true;
      }
    };
    ffmpeg.on("log", logListener);

    // Build the valid emoji lists (skip any that failed to rasterise)
    const validEmojiNames: string[] = [];
    const validEmojiEls: OverlayElement[] = [];
    activeEmojis.forEach((el, i) => {
      if (emojiInputNames[i]) {
        validEmojiNames.push(emojiInputNames[i]!);
        validEmojiEls.push(el);
      }
    });

    // Attempt 1: Process with standard audio streams
    let args = buildArguments(
      recipe, recipe.format, outputName, inputName, targetW, targetH,
      hasMusicTrack, musicInputName, musicOptions,
      hasOverlay, overlayInputName, overlayOptions, true,
      validEmojiNames, validEmojiEls,
    );

    let exitCode = await ffmpeg.exec(args, undefined, { signal });

    // Attempt 2: Auto-recover if the file has no original audio track
    if (exitCode !== 0 && missingAudioDetected) {
      missingAudioDetected = false;
      args = buildArguments(
        recipe, recipe.format, outputName, inputName, targetW, targetH,
        hasMusicTrack, musicInputName, musicOptions,
        hasOverlay, overlayInputName, overlayOptions, false,
        validEmojiNames, validEmojiEls,
      );
      exitCode = await ffmpeg.exec(args, undefined, { signal });
    }

    // Fallback Attempt 3: Switch codecs to WebM if container errors happen
    if (exitCode !== 0) {
      args = buildArguments(
        recipe, "webm", fallbackOutputName, inputName, targetW, targetH,
        hasMusicTrack, musicInputName, musicOptions,
        hasOverlay, overlayInputName, overlayOptions, !missingAudioDetected,
        validEmojiNames, validEmojiEls,
      );

      const fallbackCode = await ffmpeg.exec(args, undefined, { signal });
      if (fallbackCode !== 0) throw new Error("Export failed");

      const data = await ffmpeg.readFile(fallbackOutputName, undefined, { signal });
      const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: "video/webm" });

      ffmpeg.off("log", logListener);
      onProgress(100);
      return {
        blobUrl: URL.createObjectURL(blob),
        blob,
        size: blob.size,
        width: targetW,
        height: targetH,
        format: "webm",
      };
    }

    const data = await ffmpeg.readFile(outputName, undefined, { signal });
    const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: mimeType });

    ffmpeg.off("log", logListener);
    onProgress(100);
    return {
      blobUrl: URL.createObjectURL(blob),
      blob,
      size: blob.size,
      width: targetW,
      height: targetH,
      format: recipe.format as "mp4" | "webm" | "mkv",
    };
  } finally {
    ffmpeg.off("progress", handleProgress);
    for (const path of cleanupFiles) {
      try {
        await ffmpeg.deleteFile(path);
      } catch {}
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}