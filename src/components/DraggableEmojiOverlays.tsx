"use client";

import { useRef, useCallback, useState } from "react";
import { OverlayElement } from "@/lib/types";
import { X, RotateCcw } from "lucide-react";

interface Props {
  elements: OverlayElement[];
  containerWidth?: number;
  containerHeight?: number;
  onUpdate: (id: string, patch: Partial<OverlayElement>) => void;
  onRemove: (id: string) => void;
}

const EMOJI_BASE_SIZE = 64; // px at scale 1.0
const DRAG_THRESHOLD = 4;   // px — movement below this is treated as a click, not a drag
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export default function DraggableEmojiOverlays({ elements, onUpdate, onRemove }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deselect when clicking the container background
  const handleContainerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target === containerRef.current) {
      setSelectedId(null);
    }
  }, []);

  const startDrag = useCallback(
    (id: string, startX: number, startY: number, startPctX: number, startPctY: number) => {
      const container = containerRef.current;
      if (!container) return;

      const { width, height } = container.getBoundingClientRect();
      let hasMoved = false;

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        // Only start moving after threshold so click-to-select still works
        if (!hasMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        hasMoved = true;
        onUpdate(id, {
          x: clamp(startPctX + (dx / width) * 100, 0, 100),
          y: clamp(startPctY + (dy / height) * 100, 0, 100),
        });
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onUpdate]
  );

  const startScale = useCallback(
    (id: string, el: OverlayElement, startY: number) => {
      const initialScale = el.scale;

      const onMove = (e: PointerEvent) => {
        const dy = startY - e.clientY; // drag up = bigger
        const newScale = clamp(initialScale + dy * 0.01, 0.3, 5);
        onUpdate(id, { scale: parseFloat(newScale.toFixed(2)) });
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onUpdate]
  );

  const startRotate = useCallback(
    (id: string, el: OverlayElement) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cx = rect.left + (el.x / 100) * rect.width;
      const cy = rect.top + (el.y / 100) * rect.height;

      const onMove = (e: PointerEvent) => {
        const angle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI) + 90;
        onUpdate(id, { rotation: parseFloat(angle.toFixed(1)) });
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onUpdate]
  );

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      aria-label="Emoji sticker overlays"
      onPointerDown={handleContainerPointerDown}
    >
      {elements.map((el) => {
        const size = EMOJI_BASE_SIZE * el.scale;
        const isSelected = selectedId === el.id;

        return (
          <div
            key={el.id}
            className="absolute pointer-events-auto"
            style={{
              left: `${el.x}%`,
              top: `${el.y}%`,
              transform: `translate(-50%, -50%) rotate(${el.rotation}deg)`,
              width: size,
              height: size,
              zIndex: isSelected ? 30 : 20,
            }}
          >
            {/* Main emoji — pointerDown selects + starts drag */}
            <img
              src={el.src}
              alt=""
              aria-label={`Emoji sticker at ${Math.round(el.x)}% ${Math.round(el.y)}%`}
              draggable={false}
              className="w-full h-full select-none drop-shadow-lg"
              style={{ cursor: isSelected ? "grab" : "pointer" }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Select immediately on pointer down — controls appear right away
                setSelectedId(el.id);
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                // Start drag — won't actually move until past DRAG_THRESHOLD
                startDrag(el.id, e.clientX, e.clientY, el.x, el.y);
              }}
            />

            {/* Controls — only shown when selected */}
            {isSelected && (
              <>
                {/* Selection ring */}
                <div className="absolute inset-0 rounded border-2 border-white/70 border-dashed pointer-events-none" />

                {/* Remove — top right */}
                <button
                  type="button"
                  aria-label="Remove sticker"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(el.id);
                    setSelectedId(null);
                  }}
                  className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center shadow-md hover:bg-red-400 transition-colors"
                  style={{ transform: `rotate(${-el.rotation}deg)`, zIndex: 10 }}
                >
                  <X size={11} />
                </button>

                {/* Scale handle — bottom right, drag up/down */}
                <div
                  role="slider"
                  aria-label="Scale sticker (drag up to enlarge, down to shrink)"
                  aria-valuenow={el.scale}
                  aria-valuemin={0.3}
                  aria-valuemax={5}
                  tabIndex={0}
                  className="absolute -bottom-3 -right-3 w-6 h-6 rounded-full bg-blue-500 cursor-ns-resize flex items-center justify-center shadow-md hover:bg-blue-400 transition-colors"
                  style={{ transform: `rotate(${-el.rotation}deg)`, zIndex: 10 }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    startScale(el.id, el, e.clientY);
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 8L8 2M5 8L8 5M2 5L5 2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>

                {/* Rotate handle — bottom left */}
                <div
                  role="button"
                  aria-label="Rotate sticker (drag to rotate)"
                  tabIndex={0}
                  className="absolute -bottom-3 -left-3 w-6 h-6 rounded-full bg-amber-500 cursor-crosshair flex items-center justify-center shadow-md hover:bg-amber-400 transition-colors"
                  style={{ transform: `rotate(${-el.rotation}deg)`, zIndex: 10 }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    startRotate(el.id, el);
                  }}
                >
                  <RotateCcw size={10} color="white" />
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}