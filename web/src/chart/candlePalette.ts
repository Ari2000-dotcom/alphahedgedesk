import { useState } from "react";

import { token } from "./chartTheme";

/**
 * The scrip chart's candle colours: a few presets, the pick kept on this computer. The OI
 * profile's call and put bars take the same pair, so a call reads like an up candle.
 */
export type CandlePaletteId = "theme" | "tv" | "classic" | "blue" | "mono";

export const CANDLE_PALETTES: readonly { id: CandlePaletteId; name: string; up: string; down: string }[] = [
  // The app's own pair, which follows the light and dark themes (resolved when drawn).
  { id: "theme", name: "Desk", up: "--mh-up", down: "--mh-down" },
  { id: "tv", name: "TradingView", up: "#089981", down: "#f23645" },
  { id: "classic", name: "Classic", up: "#26a69a", down: "#ef5350" },
  // For red-green colour blindness.
  { id: "blue", name: "Blue / orange", up: "#2962ff", down: "#ff9800" },
  { id: "mono", name: "Mono", up: "#d1d4dc", down: "#787b86" },
];

const KEY = "mh.scrip.candles";

/** A preset's colours, with the theme's tokens resolved: the canvas cannot read `var(--x)`. */
export function paletteColors(id: CandlePaletteId): { up: string; down: string } {
  const p = CANDLE_PALETTES.find((x) => x.id === id) ?? CANDLE_PALETTES[0]!;
  const resolve = (c: string) => (c.startsWith("--") ? token(c) : c);
  return { up: resolve(p.up), down: resolve(p.down) };
}

function readPalette(): CandlePaletteId {
  try {
    const v = localStorage.getItem(KEY);
    return CANDLE_PALETTES.some((p) => p.id === v) ? (v as CandlePaletteId) : "theme";
  } catch {
    return "theme";
  }
}

export function useCandlePalette(): [CandlePaletteId, (id: CandlePaletteId) => void] {
  const [id, setId] = useState<CandlePaletteId>(readPalette);
  const set = (next: CandlePaletteId) => {
    setId(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A per-viewer convenience only.
    }
  };
  return [id, set];
}
