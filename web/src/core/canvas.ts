/**
 * The page's canvas tone (AlphaHedge's idea): which ground everything sits on.
 *
 * The tones live in `theme/tokens.css` under `[data-canvas="…"]`; this file
 * carries only the list the picker shows and owns the `data-canvas` attribute
 * on <html>. No colour values here: the picker's swatches set `data-canvas` on
 * themselves and the same stylesheet paints them.
 */

export type CanvasId = "charcoal" | "openalgo" | "quantdesk" | "graphite" | "neutral" | "slate" | "ink" | "moss" | "plum";

export const CANVAS_TONES: readonly { id: CanvasId; name: string; note: string }[] = [
  { id: "charcoal", name: "Charcoal", note: "Light grey ground, dark containers" },
  { id: "openalgo", name: "OpenAlgo", note: "Near-black, navy grid" },
  { id: "quantdesk", name: "QuantDesk", note: "Kite's neutral grey" },
  { id: "graphite", name: "Graphite", note: "Warm charcoal" },
  { id: "neutral", name: "Neutral", note: "Flat grey, no hue" },
  { id: "slate", name: "Slate", note: "Blue-grey" },
  { id: "ink", name: "Ink", note: "Deep navy" },
  { id: "moss", name: "Moss", note: "Green-grey" },
  { id: "plum", name: "Plum", note: "Violet-charcoal" },
];

// A new key, so everyone starts on the new default instead of a tone saved before it existed.
const STORAGE_KEY = "mh.canvas.v2";
const DEFAULT: CanvasId = "charcoal";

/** Anything unrecognised falls back to the default. */
export function loadCanvas(): CanvasId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return CANVAS_TONES.some((t) => t.id === stored) ? (stored as CanvasId) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

let switching = 0;

/** Puts `id` on <html> in one step (no half-faded hovers) and remembers it. */
export function applyCanvas(id: CanvasId): void {
  const html = document.documentElement;
  html.setAttribute("data-canvas-switching", "");
  html.setAttribute("data-canvas", id);
  window.clearTimeout(switching);
  switching = window.setTimeout(() => {
    void getComputedStyle(html).color;
    html.removeAttribute("data-canvas-switching");
  }, 150);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A per-viewer convenience only.
  }
}
