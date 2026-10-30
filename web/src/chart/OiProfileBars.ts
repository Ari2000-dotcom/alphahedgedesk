import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from "openalgo-charts";

/**
 * The OI profile on the price axis, QuantDesk's way (chart/candle/engine.ts there, "Bars hung off
 * the price axis at fixed prices"): each strike gets one bar just above it (call OI) and one just
 * below (put OI), reaching left from the right axis, their length the value's share of the
 * largest on screen. A negative value (OI shed, in the change view) draws hollow.
 *
 * The largest reaches across the whole plot, so the profile reads at full length; the fills are
 * translucent and drawn behind the candles (`zOrder: "bottom"`), so the price action stays legible
 * over it. A bar is never thicker than its strike's share of the height allows, so neighbouring
 * strikes never run into each other however far the price scale is zoomed out.
 */
export interface OiBarLevel {
  price: number;
  /** NaN = no reading yet. */
  call: number;
  put: number;
  /** Today's change (`oi - poi`); NaN = unknown. Read only in `mode: "change"`. */
  callChange: number;
  putChange: number;
}

export interface OiProfileBarsOptions {
  levels: readonly OiBarLevel[];
  mode: "oi" | "change";
  callColor: string;
  putColor: string;
  /** The longest bar, as a share of the plot's width. */
  share?: number;
}

/** Each side's bar thickness at most, CSS px. */
const BAR_H = 6;
/** Gap between the call bar (above) and the put bar (below) at a strike, CSS px. */
const GAP = 1;
/** The longest bar spans the whole plot. */
const DEFAULT_SHARE = 1;
/** A filled bar's opacity, and a hollow one's outline: the candles over them stay the subject. */
const FILL_ALPHA = 0.5;
const STROKE_ALPHA = 0.8;
/** Below this many device px per strike, a strike's call and put bars meet at the strike. */
const ROOMY_STRIKE = 16;

/** The smallest step between two neighbouring strikes, or 0 for fewer than two. */
function strikeStep(levels: readonly OiBarLevel[]): number {
  const prices = levels.map((l) => l.price).sort((a, b) => a - b);
  let step = 0;
  for (let i = 1; i < prices.length; i++) {
    const d = prices[i]! - prices[i - 1]!;
    if (d > 0 && (step === 0 || d < step)) step = d;
  }
  return step;
}

function sideValue(level: OiBarLevel, side: "call" | "put", mode: "oi" | "change"): number {
  if (mode === "oi") return side === "call" ? level.call : level.put;
  return side === "call" ? level.callChange : level.putChange;
}

export class OiProfileBars implements IPrimitive {
  private opts: OiProfileBarsOptions;
  private host: PrimitiveHost | null = null;

  constructor(opts: OiProfileBarsOptions) {
    this.opts = opts;
  }

  attached(host: PrimitiveHost): void {
    this.host = host;
  }

  detached(): void {
    this.host = null;
  }

  /** Restyle or re-level in place; repaints. */
  setOptions(patch: Partial<OiProfileBarsOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.host?.requestUpdate();
  }

  zOrder(): ZOrder {
    return "bottom";
  }

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const { levels, mode, callColor, putColor, share = DEFAULT_SHARE } = this.opts;
    if (levels.length === 0) return;
    const max = this.largest(levels, mode);
    if (max <= 0) return;

    const dpr = rc.dpr;
    const xEnd = Math.round(rc.plotWidth * dpr);
    const maxLenPx = rc.plotWidth * share * dpr;
    // A strike's band is the height between it and the next: its call bar takes the upper half and
    // its put bar the lower, with a device pixel left clear between one strike's and the next's.
    // Zoomed out, the two halves meet at the strike rather than thin to a hairline.
    const step = strikeStep(levels);
    const stepPx = step > 0 ? Math.abs(rc.priceScale.priceToY(levels[0]!.price + step) - rc.priceScale.priceToY(levels[0]!.price)) * dpr : Infinity;
    const gap = stepPx >= ROOMY_STRIKE * dpr ? Math.max(1, Math.round(GAP * dpr)) : 0;
    const barH = Math.max(1, Math.min(Math.round(BAR_H * dpr), Math.floor((stepPx - 2 * gap - 1) / 2)));

    ctx.save();
    for (const level of levels) {
      const y = rc.priceScale.priceToY(level.price) * dpr;
      if (!Number.isFinite(y) || y < -barH || y > rc.plotHeight * dpr + barH) continue;
      const call = sideValue(level, "call", mode);
      const put = sideValue(level, "put", mode);
      this.bar(ctx, xEnd, Math.round(y - gap - barH), barH, maxLenPx, max, call, callColor);
      this.bar(ctx, xEnd, Math.round(y + gap), barH, maxLenPx, max, put, putColor);
    }
    ctx.restore();
  }

  private largest(levels: readonly OiBarLevel[], mode: "oi" | "change"): number {
    let max = 0;
    for (const level of levels) {
      const call = Math.abs(sideValue(level, "call", mode));
      const put = Math.abs(sideValue(level, "put", mode));
      if (Number.isFinite(call) && call > max) max = call;
      if (Number.isFinite(put) && put > max) max = put;
    }
    return max;
  }

  /** One side's bar at `y`: filled, or hollow (an outline only) for a negative value — OI shed. */
  private bar(ctx: CanvasRenderingContext2D, xEnd: number, y: number, h: number, maxLenPx: number, max: number, value: number, color: string): void {
    if (!Number.isFinite(value) || value === 0) return;
    const len = Math.round((Math.abs(value) / max) * maxLenPx);
    if (len <= 0) return;
    const x = xEnd - len;
    if (value < 0) {
      ctx.globalAlpha = STROKE_ALPHA;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, len - 1), Math.max(0, h - 1));
    } else {
      ctx.globalAlpha = FILL_ALPHA;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, len, h);
    }
  }
}
