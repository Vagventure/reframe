"use client";

import { useMemo } from "react";
import { Smile, Trash2 } from "lucide-react";
import { EMOJI_CATEGORIES } from "@/lib/emojis";
import { OverlayElement } from "@/lib/types";

interface Props {
  overlayElements: OverlayElement[];
  onAdd: (unicode: string) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

export default function Elements({ overlayElements, onAdd, onRemove, onClearAll }: Props) {
  // Mobile Keypad Flattening: Merge all category arrays into one single flat list
  const flatEmojis = useMemo(() => {
    return Object.values(EMOJI_CATEGORIES).flat();
  }, []);

  return (
    <div className="space-y-3 w-full">
      {/* Clean Section Subheading */}
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="text-[10px] font-heading font-bold uppercase tracking-wider text-[var(--muted)]">
          Emoji Stickers
        </span>
      </div>

      {/* 🗚 High-Density Viewport Content Box */}
      <div className="bg-[var(--bg)] border border-[var(--border)] rounded-lg p-2 min-h-[140px] max-h-[200px] overflow-y-auto elements-blended-scrollbar">
        
        {/* 💉 Pure CSS Injection to make a thin, transparent-blended scrollbar */}
        <style>{`
          .elements-blended-scrollbar::-webkit-scrollbar {
            width: 5px !important;
          }
          .elements-blended-scrollbar::-webkit-scrollbar-track {
            background: transparent !important;
          }
          .elements-blended-scrollbar::-webkit-scrollbar-thumb {
            background-color: var(--border, #334155) !important;
            border-radius: 9999px !important;
          }
          .elements-blended-scrollbar::-webkit-scrollbar-thumb:hover {
            background-color: var(--muted, #64748b) !important;
          }
          .elements-blended-scrollbar {
            scrollbar-width: thin !important;
            scrollbar-color: var(--border, #334155) transparent !important;
          }
        `}</style>

        {/* Dense Mobile Keypad Emoji Layout Grid */}
        <div className="flex flex-wrap gap-1.5 justify-center">
          {flatEmojis.map((emoji) => (
            <button
              key={emoji.unicode}
              type="button"
              title={emoji.name}
              aria-label={`Add ${emoji.name} sticker`}
              onClick={() => onAdd(emoji.unicode)}
              className="w-8 h-8 flex items-center justify-center rounded bg-[var(--surface)] border border-[var(--border)] hover:border-film-400 hover:bg-film-50/20 active:scale-90 text-base transition-all cursor-pointer flex-shrink-0"
            >
              {emoji.char}
            </button>
          ))}
        </div>
      </div>

      {/* Active Layer Controls Management Section */}
      {overlayElements.length > 0 ? (
        <div className="space-y-1.5 pt-2 border-t border-[var(--border)]">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-heading font-semibold uppercase tracking-wider text-[var(--muted)] flex items-center gap-1">
              <Smile size={10} />
              Active elements ({overlayElements.length})
            </span>
            <button
              type="button"
              onClick={onClearAll}
              className="text-[10px] text-red-400 hover:text-red-300 font-heading font-semibold uppercase tracking-wider transition-colors cursor-pointer"
            >
              Clear all
            </button>
          </div>

          <ul className="space-y-1 max-h-24 overflow-y-auto pr-0.5 elements-blended-scrollbar">
            {overlayElements.map((el) => (
              <li
                key={el.id}
                className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-[var(--surface)] border border-[var(--border)]"
              >
                <img src={el.src} alt="" aria-hidden="true" className="w-4 h-4 object-contain flex-shrink-0" />
                <span className="text-[10px] text-[var(--muted)] font-heading truncate flex-1">
                  {el.unicode
                    ? (flatEmojis.find((e) => e.unicode === el.unicode)?.name ?? el.unicode)
                    : "Custom Layer"}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(el.id)}
                  aria-label="Remove element layer"
                  className="text-[var(--muted)] hover:text-red-400 transition-colors flex-shrink-0 cursor-pointer"
                >
                  <Trash2 size={11} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[9px] text-[var(--muted)] text-center py-0.5 font-heading opacity-60">
          Click an element above to mount it to the video canvas
        </p>
      )}
    </div>
  );
}