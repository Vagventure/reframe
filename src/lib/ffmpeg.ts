import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { EditRecipe, ExportResult, BackgroundMusicOptions, ImageOverlayOptions } from "./types";
import { getPresetById } from "./presets";
import { simd } from "wasm-feature-detect";

const CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegInstance: FFmpeg | null = null;

/**
 * Error thrown when the FFmpeg WebAssembly core fails to load.
 * This typically happens when the user is offline, the CDN is unreachable (or if the url is wrong),
 * or there are network interruptions during the initialization phase.
 */
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
    // Check if the user's browser supports WebAssembly SIMD
    const isSimdSupported = await simd();

    // Dynamically set the core filename
    const coreName =  "ffmpeg-core";

    // Load FFmpeg using the dynamic URLs + the new signal parameter
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

  // dimensions must be even for libx264
  targetW = Math.round(targetW / 2) * 2;
  targetH = Math.round(targetH / 2) * 2;

  const ext = file.name.split(".").pop() ?? "mp4";
  const inputName = `input.${ext}`;

  // Determine output filename and MIME type based on format
  const getOutputConfig = (format: string) => {
    switch (format) {
      case "webm":
        return { filename: "output.webm", mimeType: "video/webm" };
      case "mkv":
        return { filename: "output.mkv", mimeType: "video/x-matroska" };
      default: // mp4
        return { filename: "output.mp4", mimeType: "video/mp4" };
    }
  };

  const { filename: outputName, mimeType } = getOutputConfig(recipe.format);

  await ffmpeg.writeFile(inputName, await fetchFile(file), { signal });

  // Write music file into FFmpeg FS if provided
  const hasMusicTrack = !!(musicOptions?.file && recipe.keepAudio);
  const musicInputName = "music_input.mp3";
  if (hasMusicTrack) {
    await ffmpeg.writeFile(musicInputName, await fetchFile(musicOptions!.file!), { signal });
  }

  // Write overlay image into FFmpeg FS if provided
  const hasOverlay = !!(overlayOptions?.file);
  const overlayExt = overlayOptions?.file?.name.split(".").pop() ?? "png";
  const overlayInputName = `overlay.${overlayExt}`;
  if (hasOverlay) {
    await ffmpeg.writeFile(overlayInputName, await fetchFile(overlayOptions!.file!), { signal });
  }

  ffmpeg.on("progress", ({ progress }) => {
    onProgress(Math.min(99, Math.round(progress * 100)));
  });

  const vf = buildVideoFilter(recipe, targetW, targetH);
  const audioTrim = buildAudioTrimFilter(recipe);
  const audioSpeed = buildAudioFilter(recipe.speed);
  const afParts = [audioTrim, audioSpeed].filter(Boolean);
  const af = afParts.join(",");

  // Input indices: video=0, music=1 (if present), overlay=1 or 2 depending on music
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

  // Use filter_complex whenever we have overlay or music — -vf and -filter_complex are mutually exclusive
  const needsFilterComplex = hasOverlay || hasMusicTrack;

  if (needsFilterComplex) {
    const filterParts: string[] = [];
    let videoOut = "[0:v]";

    // Base video filters
    if (vf) {
      filterParts.push(`[0:v]${vf}[vbase]`);
      videoOut = "[vbase]";
    }

    // Overlay: scale + opacity + position
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
      filterParts.push(`[${overlayIdx}:v]scale=${scaledW}:-1,colorchannelmixer=aa=${alpha}[logo]`);
      filterParts.push(`${videoOut}[logo]overlay=${pos}[vout]`);
      videoOut = "[vout]";
    }

    // Audio: mix original + music, or pass through with speed/trim
    let audioOut = "";
    if (recipe.keepAudio && hasMusicTrack) {
      const musicVol = (musicOptions!.musicVolume / 100).toFixed(2);
      const origVol  = (musicOptions!.originalAudioVolume / 100).toFixed(2);
      const origChain = afParts.length > 0
        ? `[0:a]${afParts.join(",")},volume=${origVol}[orig]`
        : `[0:a]volume=${origVol}[orig]`;
      filterParts.push(origChain);
      filterParts.push(`[${musicIdx}:a]volume=${musicVol}[music]`);
      filterParts.push(`[orig][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      audioOut = "[aout]";
    }

    args.push("-filter_complex", filterParts.join(";"));
    args.push("-map", videoOut);

    if (!recipe.keepAudio) {
      args.push("-an");
    } else if (audioOut) {
      args.push("-map", audioOut);
    } else {
      // Overlay only, no music — pass original audio, apply speed/trim if needed
      args.push("-map", "0:a");
      if (af) args.push("-af", af);
    }
  } else {
    // Simple path — no filter_complex needed, existing behaviour unchanged
    if (vf) args.push("-vf", vf);
    if (!recipe.keepAudio) {
      args.push("-an");
    } else if (af) {
      args.push("-af", af);
    }
  }

  // Add codec-specific arguments based on selected format
  if (recipe.format === "webm") {
    args.push(
      "-c:v", "libvpx-vp9",
      "-crf", String(recipe.quality)
    );
    if (recipe.keepAudio) {
      args.push("-c:a", "libopus");
    }
  } else if (recipe.format === "mkv") {
    args.push(
      "-c:v", "libx264",
      "-crf", String(recipe.quality),
      "-preset", "medium"
    );
    if (recipe.keepAudio) {
      args.push("-c:a", "aac", "-b:a", "128k");
    }
  } else {
    // MP4 (default)
    args.push(
      "-c:v", "libx264",
      "-crf", String(recipe.quality),
      "-preset", "medium",
      "-movflags", "+faststart"
    );
    if (recipe.keepAudio) {
      args.push("-c:a", "aac", "-b:a", "128k");
    }
  }

  args.push(outputName);

  const exitCode = await ffmpeg.exec(args, undefined, { signal });

  // If the requested format fails, try WebM as fallback
  if (exitCode !== 0) {
    const webmOutput = "output.webm";

    const fallbackArgs: string[] = [];
    fallbackArgs.push("-i", inputName);
    if (hasMusicTrack) {
      if (musicOptions!.loopMusic) fallbackArgs.push("-stream_loop", "-1");
      fallbackArgs.push("-i", musicInputName);
    }
    if (hasOverlay) fallbackArgs.push("-i", overlayInputName);

    if (needsFilterComplex) {
      const fbParts: string[] = [];
      let fbVideoOut = "[0:v]";

      if (vf) {
        fbParts.push(`[0:v]${vf}[vbase]`);
        fbVideoOut = "[vbase]";
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
        fbParts.push(`[${overlayIdx}:v]scale=${scaledW}:-1,colorchannelmixer=aa=${alpha}[logo]`);
        fbParts.push(`${fbVideoOut}[logo]overlay=${pos}[vout]`);
        fbVideoOut = "[vout]";
      }

      let fbAudioOut = "";
      if (recipe.keepAudio && hasMusicTrack) {
        const musicVol = (musicOptions!.musicVolume / 100).toFixed(2);
        const origVol  = (musicOptions!.originalAudioVolume / 100).toFixed(2);
        const origChain = afParts.length > 0
          ? `[0:a]${afParts.join(",")},volume=${origVol}[orig]`
          : `[0:a]volume=${origVol}[orig]`;
        fbParts.push(origChain);
        fbParts.push(`[${musicIdx}:a]volume=${musicVol}[music]`);
        fbParts.push(`[orig][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
        fbAudioOut = "[aout]";
      }

      fallbackArgs.push("-filter_complex", fbParts.join(";"));
      fallbackArgs.push("-map", fbVideoOut);
      if (!recipe.keepAudio) {
        fallbackArgs.push("-an");
      } else if (fbAudioOut) {
        fallbackArgs.push("-map", fbAudioOut);
      } else {
        fallbackArgs.push("-map", "0:a");
        if (af) fallbackArgs.push("-af", af);
      }
    } else {
      if (vf) fallbackArgs.push("-vf", vf);
      if (!recipe.keepAudio) fallbackArgs.push("-an");
      else if (af) fallbackArgs.push("-af", af);
    }

    fallbackArgs.push(
      "-c:v", "libvpx-vp9",
      "-crf", String(recipe.quality),
      ...(recipe.keepAudio ? ["-c:a", "libopus"] : []),
      webmOutput,
    );

    const fallbackCode = await ffmpeg.exec(fallbackArgs, undefined, { signal });
    if (fallbackCode !== 0) throw new Error("Export failed");

    const data = await ffmpeg.readFile(webmOutput, undefined, { signal });
    const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: "video/webm" });
    await ffmpeg.deleteFile(inputName, { signal });
    await ffmpeg.deleteFile(webmOutput, { signal });
    if (hasMusicTrack) await ffmpeg.deleteFile(musicInputName, { signal });
    if (hasOverlay) await ffmpeg.deleteFile(overlayInputName, { signal });

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