/**
 * The page's canvas tone: which ground everything sits on.
 *
 * The tones live in `theme/tokens.css` under `[data-canvas="…"]`; this file
 * carries only the list the picker shows and owns the `data-canvas` attribute
 * on <html>. No colour values here: the picker's swatches set `data-canvas` on
 * themselves and the same stylesheet paints them.
 */

export type CanvasId = "neutral" | "tradingview" | "charcoal";

// The ids are what a saved choice holds, so "tradingview" keeps its id under its new name.
export const CANVAS_TONES: readonly { id: CanvasId; name: string; note: string }[] = [
  { id: "neutral", name: "Neutral", note: "Flat grey, no hue" },
  { id: "tradingview", name: "Navy", note: "Navy chart, black frame" },
  { id: "charcoal", name: "Charcoal", note: "Light grey ground, dark containers" },
];

// A new key, so everyone starts on the new default instead of a tone saved before it existed.
const STORAGE_KEY = "mh.canvas.v4";
const DEFAULT: CanvasId = "neutral";

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
  // The installed app's own title bar takes the tone's frame colour, so it runs on into ours.
  const chrome = getComputedStyle(html).getPropertyValue("--mh-chrome").trim();
  if (chrome) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", chrome);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A per-viewer convenience only.
  }
}
