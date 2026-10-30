import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from "openalgo-charts";

/**
 * The live end of a line, TradingView's way: a solid dot on the latest value with soft rings
 * drizzling out from it and fading, so the eye finds where the session is right now. It is drawn
 * over the lines (`zOrder: "top"`), repaints itself while there is a live dot to draw, and stands
 * still (just the dot) for a viewer who asks for reduced motion.
 */
export interface PulseDot {
  /** Epoch seconds of the minute the line ends on, and its value there. */
  time: number;
  value: number;
  colour: string;
  /** Maps the value to a y in the pane (the line's own price scale). */
  toY: (value: number) => number;
  /** 0..1: a faded line's dot and rings are as faded. */
  strength: number;
}

export interface LivePulseOptions {
  read: () => readonly PulseDot[];
}

/** Dot radius, and how far a ring spreads before it is gone, CSS px. */
const DOT_R = 3.5;
const RING_R = 15;
/** One ring's life, ms, and how many follow each other. */
const RING_MS = 2200;
const RINGS = 2;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export class LivePulse implements IPrimitive {
  private host: PrimitiveHost | null = null;
  private raf = 0;
  private opts: LivePulseOptions;

  constructor(opts: LivePulseOptions) {
    this.opts = opts;
  }

  attached(host: PrimitiveHost): void {
    this.host = host;
    this.tick();
  }

  detached(): void {
    this.host = null;
    cancelAnimationFrame(this.raf);
  }

  zOrder(): ZOrder {
    return "top";
  }

  /** The next frame, for as long as the primitive is on a chart and motion is welcome. */
  private tick = () => {
    if (!this.host) return;
    this.host.requestUpdate();
    if (!reduced()) this.raf = requestAnimationFrame(this.tick);
  };

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const dots = this.opts.read();
    if (dots.length === 0) return;
    const d = rc.dpr;
    const now = performance.now();
    const animate = !reduced();
    ctx.save();
    for (const dot of dots) {
      const x = rc.timeScale.indexToX(rc.dataLayer.timeToIndexFloat(dot.time)) * d;
      const y = dot.toY(dot.value) * d;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > rc.plotWidth * d || y < 0 || y > rc.plotHeight * d) continue;
      ctx.strokeStyle = dot.colour;
      ctx.fillStyle = dot.colour;
      if (animate) {
        for (let i = 0; i < RINGS; i++) {
          // Each ring starts a share of its life after the last; the spread eases out.
          const t = ((now + (i * RING_MS) / RINGS) % RING_MS) / RING_MS;
          const eased = 1 - (1 - t) * (1 - t);
          ctx.globalAlpha = 0.5 * (1 - t) * dot.strength;
          ctx.lineWidth = Math.max(1, (1.6 - t) * d);
          ctx.beginPath();
          ctx.arc(x, y, (DOT_R + (RING_R - DOT_R) * eased) * d, 0, Math.PI * 2);
          ctx.stroke();
        }
        // A soft halo that breathes under the dot.
        ctx.globalAlpha = (0.14 + 0.1 * Math.sin(now / 420)) * dot.strength;
        ctx.beginPath();
        ctx.arc(x, y, (DOT_R + 3) * d, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = Math.max(0.6, dot.strength);
      ctx.beginPath();
      ctx.arc(x, y, DOT_R * d, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
