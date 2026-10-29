import { CHART_FONT_FAMILY, type IPrimitive, type PrimitiveHost, type PrimitiveRenderContext, type ZOrder } from "openalgo-charts";

import { fmt0 } from "../core/format";

/**
 * The OI profile on the price axis, QuantDesk's way (chart/candle/engine.ts there, "Bars hung off
 * the price axis at fixed prices"): each strike gets one bar just above it (call OI) and one just
 * below (put OI), reaching left from the right axis, their length the value's share of the
 * largest on screen.
 *
 * - `oi`: total open interest, solid.
 * - `change`: today's change alone; a negative value (OI shed) draws hollow.
 * - `both`: total OI dimmed, with today's addition highlighted solid at its outer end, and OI shed
 *   today as an outline beyond it (where the bar stood at yesterday's close). The strikes that
 *   added the most call and put OI are named beside their bars.
 *
 * Drawn behind the candles (`zOrder: "bottom"`), so the price action stays legible over it.
 */
export interface OiBarLevel {
  price: number;
  /** NaN = no reading yet. */
  call: number;
  put: number;
  /** Today's change (`oi - poi`); NaN = unknown. Read in `change` and `both`. */
  callChange: number;
  putChange: number;
}

export type OiBarsMode = "oi" | "change" | "both";

export interface OiProfileBarsOptions {
  levels: readonly OiBarLevel[];
  mode: OiBarsMode;
  callColor: string;
  putColor: string;
  /** The longest bar, as a share of the plot's width. */
  share?: number;
}

/** Each side's bar thickness, CSS px. */
const BAR_H = 6;
/** Gap between the call bar (above) and the put bar (below) at a strike, CSS px. */
const GAP = 1;
const DEFAULT_SHARE = 0.35;
/** How strongly total OI shows under today's highlighted change in `both`. */
const TOTAL_ALPHA = 0.35;
const LABEL_FONT = 11;
/** Today's change in `both`: a little under full strength, washed with grey, so it marks the bar
 *  without shouting over the candles. */
const CHANGE_ALPHA = 0.8;
const CHANGE_GREY = "rgba(120, 123, 134, 0.35)";
/** How far outside a bar the pointer still counts as on it, CSS px. */
const HIT_SLOP = 2;

/** A drawn bar, CSS px from the pane's top-left: what `levelAt` finds under the pointer. */
interface Hit {
  left: number;
  top: number;
  bottom: number;
  level: OiBarLevel;
}

type Side = "call" | "put";

const total = (level: OiBarLevel, side: Side) => (side === "call" ? level.call : level.put);
const change = (level: OiBarLevel, side: Side) => (side === "call" ? level.callChange : level.putChange);

/** How far one side's bar reaches, in the units it is scaled by, for `mode`. */
function extent(level: OiBarLevel, side: Side, mode: OiBarsMode): number {
  const t = total(level, side);
  const c = change(level, side);
  if (mode === "oi") return Math.abs(t);
  if (mode === "change") return Math.abs(c);
  // OI shed today draws beyond the total, out to yesterday's level.
  return Number.isFinite(c) && c < 0 ? t - c : t;
}

export class OiProfileBars implements IPrimitive {
  private opts: OiProfileBarsOptions;
  private host: PrimitiveHost | null = null;
  private hits: Hit[] = [];
  private plotWidth = 0;

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

  /** The strike whose bar is under (x, y), CSS px from the price pane's top-left; null off them. */
  levelAt(x: number, y: number): OiBarLevel | null {
    if (x > this.plotWidth) return null;
    for (const h of this.hits) {
      if (x >= h.left - HIT_SLOP && y >= h.top - HIT_SLOP && y <= h.bottom + HIT_SLOP) return h.level;
    }
    return null;
  }

  zOrder(): ZOrder {
    return "bottom";
  }

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const { levels, mode, callColor, putColor, share = DEFAULT_SHARE } = this.opts;
    this.hits = [];
    this.plotWidth = rc.plotWidth;
    if (levels.length === 0) return;
    const max = this.largest(levels, mode);
    if (max <= 0) return;

    const dpr = rc.dpr;
    const xEnd = Math.round(rc.plotWidth * dpr);
    const scale = (rc.plotWidth * share * dpr) / max;
    const barH = Math.max(1, Math.round(BAR_H * dpr));
    const gap = Math.max(1, Math.round(GAP * dpr));
    const bottom = rc.plotHeight * dpr + barH;

    // The strikes that added the most today, for `both`'s labels: only among those on screen.
    let topCall: { level: OiBarLevel; y: number } | null = null;
    let topPut: { level: OiBarLevel; y: number } | null = null;

    for (const level of levels) {
      const y = rc.priceScale.priceToY(level.price) * dpr;
      if (!Number.isFinite(y) || y < -barH || y > bottom) continue;
      const yCall = Math.round(y - gap - barH);
      const yPut = Math.round(y + gap);
      const reach = Math.max(extent(level, "call", mode), extent(level, "put", mode));
      if (Number.isFinite(reach) && reach > 0) {
        this.hits.push({ left: (xEnd - reach * scale) / dpr, top: yCall / dpr, bottom: (yPut + barH) / dpr, level });
      }
      if (mode === "both") {
        this.layered(ctx, xEnd, yCall, barH, scale, level, "call", callColor);
        this.layered(ctx, xEnd, yPut, barH, scale, level, "put", putColor);
        if (level.callChange > 0 && (!topCall || level.callChange > topCall.level.callChange)) topCall = { level, y: yCall };
        if (level.putChange > 0 && (!topPut || level.putChange > topPut.level.putChange)) topPut = { level, y: yPut };
      } else {
        const pick = mode === "oi" ? total : change;
        this.bar(ctx, xEnd, yCall, barH, scale, pick(level, "call"), callColor);
        this.bar(ctx, xEnd, yPut, barH, scale, pick(level, "put"), putColor);
      }
    }

    if (topCall) this.label(ctx, xEnd, topCall.y, barH, scale, topCall.level, "call", callColor, dpr);
    if (topPut) this.label(ctx, xEnd, topPut.y, barH, scale, topPut.level, "put", putColor, dpr);
  }

  private largest(levels: readonly OiBarLevel[], mode: OiBarsMode): number {
    let max = 0;
    for (const level of levels) {
      for (const side of ["call", "put"] as const) {
        const v = extent(level, side, mode);
        if (Number.isFinite(v) && v > max) max = v;
      }
    }
    return max;
  }

  /** One side's bar at `y`: filled, or hollow (an outline only) for a negative value — OI shed. */
  private bar(ctx: CanvasRenderingContext2D, xEnd: number, y: number, h: number, scale: number, value: number, color: string): void {
    if (!Number.isFinite(value) || value === 0) return;
    const len = Math.round(Math.abs(value) * scale);
    if (len <= 0) return;
    const x = xEnd - len;
    if (value < 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, len - 1), Math.max(0, h - 1));
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, len, h);
    }
  }

  /** `both`: total OI dimmed, today's addition solid at its outer end, OI shed outlined beyond it. */
  private layered(ctx: CanvasRenderingContext2D, xEnd: number, y: number, h: number, scale: number, level: OiBarLevel, side: Side, color: string): void {
    const t = total(level, side);
    if (!Number.isFinite(t) || t <= 0) return;
    const c = change(level, side);
    const len = Math.round(t * scale);
    if (len <= 0) return;
    const x = xEnd - len;
    ctx.globalAlpha = TOTAL_ALPHA;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, len, h);
    ctx.globalAlpha = 1;
    if (!Number.isFinite(c) || c === 0) return;
    const cLen = Math.round(Math.abs(c) * scale);
    if (cLen <= 0) return;
    if (c > 0) {
      const w = Math.min(cLen, len);
      ctx.globalAlpha = CHANGE_ALPHA;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = CHANGE_GREY;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - cLen + 0.5, y + 0.5, Math.max(0, cLen - 1), Math.max(0, h - 1));
    }
  }

  /** "Call OI added +48,230" to the left of the bar. */
  private label(ctx: CanvasRenderingContext2D, xEnd: number, y: number, h: number, scale: number, level: OiBarLevel, side: Side, color: string, dpr: number): void {
    const len = Math.round(total(level, side) * scale);
    const added = change(level, side);
    ctx.font = `${Math.round(LABEL_FONT * dpr)}px ${CHART_FONT_FAMILY}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(`${side === "call" ? "Call" : "Put"} OI added +${fmt0(added)}`, xEnd - len - Math.round(6 * dpr), y + h / 2);
  }
}
