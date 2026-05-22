"use client";

import { EditRecipe } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import { useAudioWaveform } from "@/hooks/useAudioWaveform";
import WaveformCanvas from "@/components/WaveformCanvas";
import TrimSlider from "@/components/TrimSlider";

interface Props {
  recipe: EditRecipe;
  onChange: (patch: Partial<EditRecipe>) => void;
  duration: number;
  file: File | null;
  videoRef: React.RefObject<HTMLVideoElement>;
}

export default function TrimControl({ recipe, onChange, duration, file, videoRef }: Props) {
  const { waveform, isLoading: waveformLoading } = useAudioWaveform(file);
  const hasAudio = waveform.length > 0;

  const clipLength = (recipe.trimEnd ?? duration) - recipe.trimStart;

  return (
    <div id="trim-control" className="space-y-3">

      {/* Interactive trim slider */}
      {duration > 0 && (
        <TrimSlider
          recipe={recipe}
          duration={duration}
          onChange={onChange}
          videoRef={videoRef}
        />
      )}

      {/* Waveform — shown while loading or when file has audio */}
      {file && (waveformLoading || hasAudio) && (
        <div className="relative w-full rounded-md overflow-hidden bg-[var(--surface)]">
          <WaveformCanvas
            samples={waveform}
            loading={waveformLoading}
            hasAudio={hasAudio}
          />
        </div>
      )}

      {duration > 0 && (
        <p className="text-sm text-[var(--muted)] font-heading mt-1">
          Clip: {formatDuration(clipLength)} of {formatDuration(duration)}
        </p>
      )}
    </div>
  );
}