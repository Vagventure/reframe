"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { EditRecipe } from "@/lib/types";

interface Props {
  recipe: EditRecipe;
  duration: number;
  onChange: (patch: Partial<EditRecipe>) => void;
  videoRef: React.RefObject<HTMLVideoElement>;
}

const MIN_GAP = 0.5; // minimum seconds between handles

type DragTarget = "start" | "end" | "region" | null;

export default function TrimSlider({ recipe, duration, onChange, videoRef }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<DragTarget>(null);
  const dragStartX = useRef(0);
  const dragStartValues = useRef({ start: 0, end: 0 });
  const [activeHandle, setActiveHandle] = useState<DragTarget>(null);

  const trimStart = recipe.trimStart;
  const trimEnd = recipe.trimEnd ?? duration;

  const startPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const endPct = duration > 0 ? (trimEnd / duration) * 100 : 100;

  const clamp = (val: number, min: number, max: number) =>
    Math.max(min, Math.min(max, val));

  const pxToTime = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (!track || duration === 0) return 0;
      const { left, width } = track.getBoundingClientRect();
      const pct = clamp((clientX - left) / width, 0, 1);
      return pct * duration;
    },
    [duration]
  );

  const scrub = useCallback(
    (time: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = clamp(time, 0, duration);
      }
    },
    [videoRef, duration]
  );

  const onPointerDown = useCallback(
    (target: DragTarget) => (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = target;
      dragStartX.current = e.clientX;
      dragStartValues.current = { start: trimStart, end: trimEnd };
      setActiveHandle(target);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [trimStart, trimEnd]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current || duration === 0) return;

      const target = dragging.current;

      if (target === "start") {
        const time = clamp(pxToTime(e.clientX), 0, trimEnd - MIN_GAP);
        onChange({ trimStart: parseFloat(time.toFixed(2)) });
        scrub(time);
      } else if (target === "end") {
        const time = clamp(pxToTime(e.clientX), trimStart + MIN_GAP, duration);
        onChange({ trimEnd: parseFloat(time.toFixed(2)) });
        scrub(time);
      } else if (target === "region") {
        const track = trackRef.current;
        if (!track) return;
        const { width } = track.getBoundingClientRect();
        const deltaPx = e.clientX - dragStartX.current;
        const deltaTime = (deltaPx / width) * duration;
        const { start, end } = dragStartValues.current;
        const regionLen = end - start;
        const newStart = clamp(start + deltaTime, 0, duration - regionLen);
        const newEnd = newStart + regionLen;
        onChange({
          trimStart: parseFloat(newStart.toFixed(2)),
          trimEnd: parseFloat(newEnd.toFixed(2)),
        });
        scrub(newStart);
      }
    };

    const onUp = () => {
      dragging.current = null;
      setActiveHandle(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [duration, trimStart, trimEnd, onChange, pxToTime, scrub]);

  // Click on track to seek (not on handles)
  const onTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (dragging.current) return;
      const time = pxToTime(e.clientX);
      scrub(time);
    },
    [pxToTime, scrub]
  );

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1).padStart(4, "0");
    return `${m}:${sec}`;
  };

  if (duration === 0) return null;

  return (
    <div className="space-y-2 select-none">
      {/* Track */}
      <div
        ref={trackRef}
        className="relative h-10 rounded-lg overflow-hidden cursor-pointer"
        onClick={onTrackClick}
        aria-label="Trim timeline"
        role="group"
      >
        {/* Full background */}
        <div className="absolute inset-0 bg-[var(--border)]" />

        {/* Left discard mask */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-black/70 z-10"
          style={{ width: `${startPct}%` }}
        />

        {/* Active region tint */}
        <div
          className="absolute top-0 bottom-0 z-10 bg-film-500/20 border-x-2 border-film-500 cursor-grab active:cursor-grabbing"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          onPointerDown={onPointerDown("region")}
        />

        {/* Right discard mask */}
        <div
          className="absolute top-0 bottom-0 right-0 bg-black/70 z-10"
          style={{ width: `${100 - endPct}%` }}
        />

        {/* Start handle */}
        <div
          className={`absolute top-0 bottom-0 z-20 flex items-center justify-center
            w-4 -translate-x-1/2 cursor-ew-resize group
            ${activeHandle === "start" ? "opacity-100" : ""}`}
          style={{ left: `${startPct}%` }}
          onPointerDown={onPointerDown("start")}
          role="slider"
          aria-label="Trim start"
          aria-valuenow={trimStart}
          aria-valuemin={0}
          aria-valuemax={trimEnd - MIN_GAP}
          tabIndex={0}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 1 : 0.1;
            if (e.key === "ArrowLeft") {
              const t = clamp(trimStart - step, 0, trimEnd - MIN_GAP);
              onChange({ trimStart: parseFloat(t.toFixed(2)) });
              scrub(t);
            } else if (e.key === "ArrowRight") {
              const t = clamp(trimStart + step, 0, trimEnd - MIN_GAP);
              onChange({ trimStart: parseFloat(t.toFixed(2)) });
              scrub(t);
            }
          }}
        >
          <div className={`w-4 h-full rounded-l-md flex flex-col items-center justify-center gap-0.5
            bg-film-500 hover:bg-film-400 transition-colors shadow-lg
            ${activeHandle === "start" ? "bg-film-400 scale-x-110" : ""}`}
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="w-0.5 h-2.5 bg-white/70 rounded-full" />
            ))}
          </div>
        </div>

        {/* End handle */}
        <div
          className={`absolute top-0 bottom-0 z-20 flex items-center justify-center
            w-4 -translate-x-1/2 cursor-ew-resize
            ${activeHandle === "end" ? "opacity-100" : ""}`}
          style={{ left: `${endPct}%` }}
          onPointerDown={onPointerDown("end")}
          role="slider"
          aria-label="Trim end"
          aria-valuenow={trimEnd}
          aria-valuemin={trimStart + MIN_GAP}
          aria-valuemax={duration}
          tabIndex={0}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 1 : 0.1;
            if (e.key === "ArrowLeft") {
              const t = clamp(trimEnd - step, trimStart + MIN_GAP, duration);
              onChange({ trimEnd: parseFloat(t.toFixed(2)) });
              scrub(t);
            } else if (e.key === "ArrowRight") {
              const t = clamp(trimEnd + step, trimStart + MIN_GAP, duration);
              onChange({ trimEnd: parseFloat(t.toFixed(2)) });
              scrub(t);
            }
          }}
        >
          <div className={`w-4 h-full rounded-r-md flex flex-col items-center justify-center gap-0.5
            bg-film-500 hover:bg-film-400 transition-colors shadow-lg
            ${activeHandle === "end" ? "bg-film-400 scale-x-110" : ""}`}
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="w-0.5 h-2.5 bg-white/70 rounded-full" />
            ))}
          </div>
        </div>
      </div>

      {/* Timestamps below track */}
      <div className="flex justify-between text-[10px] font-heading font-semibold text-[var(--muted)] tabular-nums px-0.5">
        <span className="text-film-400">{formatTime(trimStart)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
