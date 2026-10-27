/**
 * Colour arithmetic the canvas charts share: reading a resolved token back as
 * red, green and blue, and picking the tag ink that reads best on a fill.
 * Pure — no canvas, no DOM.
 */

/** The red, green and blue of a hex or rgb() colour; mid-grey when it cannot be read. */
export function rgbOf(colour: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const h = hex[1]!;
    const n = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(colour);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [128, 128, 128];
}

/** Relative luminance (WCAG) of a hex or rgb() colour, 0–1. */
export function luminance(colour: string): number {
  const [r, g, b] = rgbOf(colour);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The WCAG contrast ratio of two luminances, 1–21. */
export function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Whichever of `dark` and `light` reads best on `fill`: dark on a light green, light on a deep red. */
export function readableInk(fill: string, dark: string, light: string): string {
  const l = luminance(fill);
  return contrast(l, luminance(dark)) >= contrast(l, luminance(light)) ? dark : light;
}

/**
 * Text written straight on a chart — a legend floating over the plot — reads
 * over the lines behind it through a 1px outline in the chart's own ground:
 * four zero-blur offsets, never a blurred shadow (UI rule 5a, sharp at 4K).
 */
export const CHART_TEXT_HALO =
  "1px 0 0 var(--qd-chart-bg), -1px 0 0 var(--qd-chart-bg), 0 1px 0 var(--qd-chart-bg), 0 -1px 0 var(--qd-chart-bg)";
