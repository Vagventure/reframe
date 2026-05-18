import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { EditRecipe, ExportResult, BackgroundMusicOptions, ImageOverlayOptions } from "./types";
import { getPresetById } from "./presets";
import { simd } from "wasm-feature-detect";

const CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegInstance: FFmpeg | null = null;

export class FFmpegLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FFmpegLoadError";
  }
}

export async function loadFFmpeg(signal?: AbortSignal): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;

  const ffmpeg = ffmpegInstance ?? new FFmpeg();
  ffmpegInstance = ffmpeg;

  try {
    const isSimdSupported = await simd();
    const coreName = "ffmpeg-core";

    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE_URL}/${coreName}.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE_URL}/${coreName}.wasm`, "application/wasm"),
    }, { signal });

    return ffmpeg;
  } catch (err) {
    if (ffmpegInstance === ffmpeg) {
      ffmpegInstance = null;
    }
    throw new FFmpegLoadError("The ffmpeg cdn could not load. Please check your internet connection.");
  }
}

export function terminateFFmpeg() {
  ffmpegInstance?.terminate();
  ffmpegInstance = null;
}

function buildVideoFilter(recipe: EditRecipe, targetW: number, targetH: number): string {
  const filters: string[] = [];

  if (recipe.trimStart > 0 || recipe.trimEnd !== null) {
    const end = recipe.trimEnd !== null ? recipe.trimEnd : 999999;
    filters.push(`trim=start=${recipe.trimStart}:end=${end}`);
    filters.push("setpts=PTS-STARTPTS");
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
  filters.push(
    `eq=brightness=${recipe.brightness}:contrast=${recipe.contrast}:saturation=${recipe.saturation}`
  );
  return filters.join(",");
}

function buildAudioFilter(speed: number): string {
  if (speed === 1) return "";
  if (speed === 0.25) return "atempo=0.5,atempo=0.5";
  if (speed === 4) return "atempo=2.0,atempo=2.0";
  return `atempo=${speed}`;
}

function buildAudioTrimFilter(recipe: EditRecipe): string {
  if (recipe.trimStart === 0 && recipe.trimEnd === null) return "";
  const end = recipe.trimEnd !== null ? recipe.trimEnd : 999999;
  return `atrim=start=${recipe.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
}

/**
 * Constructs the compilation arguments dynamically based on whether an original audio stream exists.
 */
function buildArguments(
  recipe: EditRecipe,
  format: "mp4" | "webm" | "mkv",
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
  hasOriginalAudio: boolean
): string[] {
  const vf = buildVideoFilter(recipe, targetW, targetH);
  const audioTrim = hasOriginalAudio ? buildAudioTrimFilter(recipe) : "";
  const audioSpeed = hasOriginalAudio ? buildAudioFilter(recipe.speed) : "";
  const afParts = [audioTrim, audioSpeed].filter(Boolean);
  const af = afParts.join(",");

  const musicIdx = 1;
  const overlayIdx = hasMusicTrack ? 2 : 1;

  const args: string[] = [];
  args.push("-i", inputName);
  if (hasMusicTrack) {
    if (musicOptions!.loopMusic) args.push("-stream_loop", "-1");
    args.push("-i", musicInputName);
  }
  if (hasOverlay) {
    args.push("-i", overlayInputName);
  }

  const needsFilterComplex = hasOverlay || hasMusicTrack;
  const shouldKeepAudio = recipe.keepAudio && (hasOriginalAudio || hasMusicTrack);

  if (needsFilterComplex) {
    const filterParts: string[] = [];
    let videoOut = "[0:v]";

    if (vf) {
      filterParts.push(`[0:v]${vf}[vbase]`);
      videoOut = "[vbase]";
    }

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
      filterParts.push(`${videoOut}[logo]overlay=${pos}[vout]`);
      videoOut = "[vout]";
    }

    let audioOut = "";
    if (shouldKeepAudio) {
      if (hasMusicTrack) {
        const musicVol = (musicOptions!.musicVolume / 100).toFixed(2);
        if (hasOriginalAudio) {
          const origVol  = (musicOptions!.originalAudioVolume / 100).toFixed(2);
          const origChain = afParts.length > 0
            ? `[0:a]${afParts.join(",")},volume=${origVol}[orig]`
            : `[0:a]volume=${origVol}[orig]`;
          filterParts.push(origChain);
          filterParts.push(`[${musicIdx}:a]volume=${musicVol}[music]`);
          filterParts.push(`[orig][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
          audioOut = "[aout]";
        } else {
          // If video has no audio track but a track is provided, process music stream directly
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
    args.push("-map", videoOut === "[0:v]" ? "0:v" : videoOut);

    if (!shouldKeepAudio) {
      args.push("-an");
    } else if (audioOut) {
      args.push("-map", audioOut);
    } else if (hasOriginalAudio) {
      args.push("-map", "0:a");
    }
  } else {
    if (vf) args.push("-vf", vf);
    if (!shouldKeepAudio) {
      args.push("-an");
    } else if (af && hasOriginalAudio) {
      args.push("-af", af);
    }
  }

  if (format === "webm") {
    args.push("-c:v", "libvpx-vp9", "-crf", String(recipe.quality));
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

export async function exportVideo(
  ffmpeg: FFmpeg,
  file: File,
  recipe: EditRecipe,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
  musicOptions?: BackgroundMusicOptions,
  overlayOptions?: ImageOverlayOptions
): Promise<ExportResult> {
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
  const inputName = `input.${ext}`;

  const getOutputConfig = (format: string) => {
    switch (format) {
      case "webm":
        return { filename: "output.webm", mimeType: "video/webm" };
      case "mkv":
        return { filename: "output.mkv", mimeType: "video/x-matroska" };
      default:
        return { filename: "output.mp4", mimeType: "video/mp4" };
    }
  };

  const { filename: outputName, mimeType } = getOutputConfig(recipe.format);

  await ffmpeg.writeFile(inputName, await fetchFile(file), { signal });

  const hasMusicTrack = !!(musicOptions?.file && recipe.keepAudio);
  const musicInputName = "music_input.mp3";
  if (hasMusicTrack) {
    await ffmpeg.writeFile(musicInputName, await fetchFile(musicOptions!.file!), { signal });
  }

  const hasOverlay = !!(overlayOptions?.file);
  const overlayExt = overlayOptions?.file?.name.split(".").pop() ?? "png";
  const overlayInputName = `overlay.${overlayExt}`;
  if (hasOverlay) {
    await ffmpeg.writeFile(overlayInputName, await fetchFile(overlayOptions!.file!), { signal });
  }

  ffmpeg.on("progress", ({ progress }) => {
    onProgress(Math.min(99, Math.round(progress * 100)));
  });

  // Track if FFmpeg logs indicate a missing audio stream
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

  // Attempt 1: Assume audio exists
  let args = buildArguments(
    recipe, recipe.format, outputName, inputName, targetW, targetH,
    hasMusicTrack, musicInputName, musicOptions,
    hasOverlay, overlayInputName, overlayOptions, true
  );

  let exitCode = await ffmpeg.exec(args, undefined, { signal });

  // Attempt 2: Auto-retry without source audio if stream execution panics
  if (exitCode !== 0 && missingAudioDetected) {
    missingAudioDetected = false;
    args = buildArguments(
      recipe, recipe.format, outputName, inputName, targetW, targetH,
      hasMusicTrack, musicInputName, musicOptions,
      hasOverlay, overlayInputName, overlayOptions, false
    );
    exitCode = await ffmpeg.exec(args, undefined, { signal });
  }

  // Fallback Attempt 3: Switch codecs entirely to WebM if container restrictions error out
  if (exitCode !== 0) {
    const webmOutput = "output.webm";
    args = buildArguments(
      recipe, "webm", webmOutput, inputName, targetW, targetH,
      hasMusicTrack, musicInputName, musicOptions,
      hasOverlay, overlayInputName, overlayOptions, !missingAudioDetected
    );

    const fallbackCode = await ffmpeg.exec(args, undefined, { signal });
    if (fallbackCode !== 0) throw new Error("Export failed");

    const data = await ffmpeg.readFile(webmOutput, undefined, { signal });
    const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: "video/webm" });
    
    await ffmpeg.deleteFile(inputName, { signal });
    await ffmpeg.deleteFile(webmOutput, { signal });
    if (hasMusicTrack) await ffmpeg.deleteFile(musicInputName, { signal });
    if (hasOverlay) await ffmpeg.deleteFile(overlayInputName, { signal });
    ffmpeg.off("log", logListener);

    onProgress(100);
    return {
      blobUrl: URL.createObjectURL(blob),
      size: blob.size,
      width: targetW,
      height: targetH,
      format: "webm",
    };
  }

  const data = await ffmpeg.readFile(outputName, undefined, { signal });
  const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: mimeType });
  
  await ffmpeg.deleteFile(inputName, { signal });
  await ffmpeg.deleteFile(outputName, { signal });
  if (hasMusicTrack) await ffmpeg.deleteFile(musicInputName, { signal });
  if (hasOverlay) await ffmpeg.deleteFile(overlayInputName, { signal });
  ffmpeg.off("log", logListener);

  onProgress(100);
  return {
    blobUrl: URL.createObjectURL(blob),
    size: blob.size,
    width: targetW,
    height: targetH,
    format: recipe.format as "mp4" | "webm" | "mkv",
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}