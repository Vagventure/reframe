import { useRef } from "react";

interface BackgroundMusicPanelProps {
  musicFile: File | null;
  setMusicFile: (file: File | null) => void;
  musicVolume: number;
  setMusicVolume: (v: number) => void;
  originalAudioVolume: number;
  setOriginalAudioVolume: (v: number) => void;
  loopMusic: boolean;
  setLoopMusic: (v: boolean) => void;
}

export default function BackgroundMusicPanel({
  musicFile,
  setMusicFile,
  musicVolume,
  setMusicVolume,
  originalAudioVolume,
  setOriginalAudioVolume,
  loopMusic,
  setLoopMusic,
}: BackgroundMusicPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAudioUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setMusicFile(file);
    // Reset input so re-uploading the same file fires onChange again
    if (inputRef.current) inputRef.current.value = "";
  };

  const removeAudioFile = () => {
    setMusicFile(null);
  };

  return (
    <div className="w-full rounded-2xl text-white shadow-md backdrop-blur-md">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Background Music</h2>
          <p className="text-xs text-[#8fa6cc]">
            Add music to exported video
          </p>
        </div>

        <label className="cursor-pointer rounded-lg border border-[#2d4266] bg-transparent px-3 py-1.5 text-xs text-[#c7d8f7] transition hover:bg-white/5">
          Upload Audio

          <input
            ref={inputRef}
            type="file"
            accept="audio/mp3,audio/wav,audio/mpeg,audio/x-m4a"
            onChange={handleAudioUpload}
            className="hidden"
          />
        </label>
      </div>

      {/* Selected File */}
      {musicFile && (
        <div className="rounded-xl border border-[#2a3d5f] bg-transparent p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {musicFile.name}
              </p>
              <p className="text-xs text-[#8fa6cc]">{(musicFile.size / (1024 * 1024)).toFixed(2)} MB</p>
            </div>

            <button
              onClick={removeAudioFile}
              className="text-xs text-[#8fa6cc] transition hover:text-white"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {/* Volume Sliders */}
      <div className="mt-4 space-y-4 rounded-xl">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-[#d7e3f7]">Music Volume</span>
            <span className="text-[#6e84aa]">{musicVolume}%</span>
          </div>

          <input
            type="range"
            min="0"
            max="100"
            value={musicVolume}
            onChange={(e) => setMusicVolume(Number(e.target.value))}
            className="w-full h-11 accent-film-600 cursor-pointer"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-[#d7e3f7]">Original Audio</span>
            <span className="text-[#6e84aa]">{originalAudioVolume}%</span>
          </div>

          <input
            type="range"
            min="0"
            max="100"
            value={originalAudioVolume}
            onChange={(e) => setMusicVolume(Number(e.target.value))}
            className="w-full h-11 accent-film-600 cursor-pointer"
          />
        </div>
      </div>

      {/* Options */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => setLoopMusic(!loopMusic)}
          className={`rounded-lg border px-3 py-1.5 text-xs transition hover:bg-white/5 ${loopMusic
            ? "border-[#1d8cf8] text-white shadow-[0_0_0_1px_#1d8cf8]"
            : "border-[#2d4266] text-[#c7d8f7]"
            }`}
        >
          Loop Music
        </button>
      </div>
    </div>
  );
}