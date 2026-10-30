import type { IPrimitive, PrimitiveRenderContext, ZOrder } from "openalgo-charts";

import { token } from "./chartTheme";

/**
 * The edge between two panes, made readable: a clear rule, a soft shade that falls away under it,
 * and a small grip pill in the middle, so it reads as something to take hold of and drag. It sits
 * at the top of the lower pane, drawn over what the pane holds, and follows the pane as the edge is
 * dragged. The drag itself is the chart's own.
 */
const SHADE_H = 9;
const PILL_W = 34;
const PILL_H = 3;

/** `#rrggbb` at an opacity, for a canvas fill; any other form is used as it is. */
function tint(colour: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (!m) return colour;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class PaneGrip implements IPrimitive {
  zOrder(): ZOrder {
    return "top";
  }

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const d = rc.dpr;
    const w = rc.plotWidth * d;
    const line = token("--mh-line-strong") || "#3a3f4b";
    const ink = token("--mh-text-tertiary") || "#8a8f9c";
    ctx.save();
    // The soft shade under the edge.
    const shade = ctx.createLinearGradient(0, 0, 0, SHADE_H * d);
    shade.addColorStop(0, tint(ink, 0.16));
    shade.addColorStop(1, tint(ink, 0));
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, w, SHADE_H * d);
    // The rule itself, a touch stronger than the chart's hairline.
    ctx.fillStyle = line;
    ctx.fillRect(0, 0, w, Math.max(1, Math.round(d)));
    // The grip.
    const pw = PILL_W * d;
    const ph = PILL_H * d;
    const x = (w - pw) / 2;
    const y = 3 * d;
    ctx.fillStyle = tint(ink, 0.55);
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, ph / 2);
    ctx.fill();
    ctx.restore();
  }
}
