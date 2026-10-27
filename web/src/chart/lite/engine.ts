import { isMajorTick } from "../candle/axis";
import { candleWidth } from "../candle/width";
import { readableInk } from "../ink";
import { fitWord } from "../tagWord";
import { onWindowHidden, watchDocument } from "../../core/windowHidden";
import {
  compactNumber,
  istDayMonth,
  istDayNumber,
  istHhMm,
  istMinuteOfDay,
  niceStep,
  niceTicks,
  timeLabelStep,
} from "./ticks";

/**
 * The lite chart: a small, dependency-free canvas chart for intraday series on
 * a slot (bar-index) time axis — grouped columns and lines, a left and a right
 * value scale, x-axis zoom and pan, a crosshair that picks a whole slot, and an
 * optional overview strip ("navigator") showing the whole session.
 *
 * Why its own engine rather than `lightweight-charts`: this is a few KB, draws
 * grouped columns natively (the library needs a custom series for that), and
 * owns the interaction model the OI panels want — a comfortable default window
 * instead of the whole day squeezed to hairlines, and a hover that selects one
 * slot's bars and hands its index to the host for a tooltip.
 *
 * Framework-free on purpose: React wraps it (`LiteChartView.tsx`), but the
 * engine only knows a host element. Data goes in with `setData`; the engine
 * never holds React state, and redraws are coalesced to one per frame.
 *
 * Drawn the way the candle chart (`../candle/engine.ts`) is, so every chart in
 * the app reads alike: type set in device px on an opaque canvas, rules and
 * columns on whole device pixels (UI-RULES §5a), quiet seams at the plot's
 * edges rather than white axis lines, two-tier labels, and the candle chart's
 * notched value tags.
 *
 * Panes: several plots stacked on one time axis, each with its own scales,
 * split by the candle chart's seam (drag it to resize). A series names its
 * pane; the crosshair runs through all of them, its value tag only in the one
 * under the pointer.
 */

export type ScaleId = "left" | "right";

export interface LiteSeries {
  id: string;
  type: "bars" | "line" | "candles";
  scale: ScaleId;
  /** The pane it is drawn in, top to bottom (0 by default). */
  pane?: number;
  /** One array of values per member, one value per slot (null = no value).
   *  Bars draw a slot's members side by side; a line uses the first member;
   *  candles take four: open, high, low, close. */
  members: ReadonlyArray<ReadonlyArray<number | null>>;
  /** One colour per member: a literal, or `var(--token)` resolved from the host.
   *  Candles: the rising colour, then the falling one. */
  colors: readonly string[];
  visible?: boolean;
  lineWidth?: number;
  dash?: readonly number[];
  /** Line only: join across a slot with no value instead of breaking — several
   *  series on one time axis, where one has no bar at another's minute. */
  spanGaps?: boolean;
  /** A tag with the latest value on the series' axis. */
  lastValueLabel?: boolean;
  /** Line only: mark the High and Low of what is on screen, as the candle chart flags its
   *  extremes — a ring on the point, a short leader and the value, pointing into the chart. */
  extremes?: boolean;
  /** What the series is, short ("Spot", "Call OI"): the name its axis tag carries, so a
   *  tag never shows a bare number. Also names the axis under the crosshair when it is
   *  the only named series on that axis of its pane. */
  name?: string;
  /** Line only: shade between the line and 0 on its scale, and draw each side
   *  of 0 in its own colour — a P&L curve green above, red below. */
  baseline?: {
    up: string;
    down: string;
    fillAlpha?: number;
    /** Fade the shade: `fillAlpha` at the curve's furthest point from 0, nothing at the 0 rule. */
    fade?: boolean;
    /** A colour for a stretch lying ON 0 (nothing at stake yet), so a flat line reads neither gain nor loss. */
    flat?: string;
  };
  /** Bars only. `rounded`: soften the end away from 0. `negativeAlpha`: draw
   *  bars below 0 at this strength, so a cut reads quieter than a build-up.
   *  `negativeColor`: bars below 0 in this colour — a histogram green above
   *  its zero line and red below. */
  barStyle?: {
    rounded?: boolean;
    negativeAlpha?: number;
    negativeColor?: string;
    /** A falling bar's colour per member (beats `negativeColor`): calls covered violet, puts yellow. */
    negativeColors?: readonly string[];
  };
  /** Candles only. `hollowDown`: falling candles as an outline over a faint
   *  fill, as the candle chart's hollow mode — so a one-colour series still
   *  tells a rising minute from a falling one. */
  candleStyle?: { hollowDown?: boolean };
}

/** A small triangle on one slot: `up` sits under the value pointing at it,
 *  `down` sits over it pointing down — a buy and a sell on a P&L curve. */
export interface LiteMarker {
  index: number;
  scale: ScaleId;
  value: number;
  shape: "up" | "down";
  color: string;
  /** The pane it is drawn in (0 by default). */
  pane?: number;
}

/**
 * A mark on the time axis drawn down every pane: a line at one slot (a pinned
 * minute), or a band over a run of slots (a span worth seeing at a glance).
 * Its label is a chip at the foot of the plot, in the guide's own colour.
 */
export interface LiteGuide {
  index: number;
  color: string;
  /** Slots the band covers from `index`; a line when omitted. */
  span?: number;
  /** A band's fill strength, 0–1. */
  alpha?: number;
  dashed?: boolean;
  label?: string;
}

/** One pane: its share of the height, and its own value formats when they differ from the chart's. */
export interface LitePane {
  weight: number;
  formatY?: Partial<Record<ScaleId, (value: number) => string>>;
  /** What each of this pane's axes measures ("OI chg", "IV · VIX"): the crosshair tag's name there. */
  names?: Partial<Record<ScaleId, string>>;
}

/** Colours are literals or `var(--token)`; `fontSize` is px or a `var(--token)` holding px. */
export interface LiteTheme {
  bg: string;
  /** Grid rows under the major values, and the clock columns. */
  grid: string;
  /** A session's first column. */
  gridMajor: string;
  /** The plot's edges against the axes: a seam, not a rule. */
  edge: string;
  /** The rule at 0 (`zeroLine`). */
  zero: string;
  /** Labels in the major tier — a value on an even step, a session's date — and the crosshair's time. */
  major: string;
  /** Every other label. */
  minor: string;
  crosshair: string;
  /** The crosshair's value tags: the chart's one inverted chip. */
  tagBg: string;
  tagText: string;
  /** A value tag's ink: whichever of the two reads best on its fill. */
  inkDark: string;
  inkLight: string;
  /** The overview strip's grips. */
  handle: string;
  /** The hovered slot's wash, drawn at low alpha. */
  wash: string;
  font: string;
  fontSize: string;
}

export const DEFAULT_THEME: LiteTheme = {
  bg: "var(--qd-chart-bg)",
  grid: "var(--qd-chart-grid)",
  gridMajor: "var(--qd-chart-grid-major)",
  edge: "var(--qd-chart-edge)",
  zero: "var(--qd-chart-label-minor)",
  major: "var(--qd-text-strong)",
  minor: "var(--qd-chart-label-minor)",
  crosshair: "var(--qd-chart-crosshair)",
  tagBg: "var(--qd-chart-tag-bg)",
  tagText: "var(--qd-chart-tag-text)",
  inkDark: "var(--qd-chart-ink-dark)",
  inkLight: "var(--qd-chart-ink-light)",
  handle: "var(--qd-text-tertiary)",
  wash: "var(--qd-text-primary)",
  font: "var(--qd-font)",
  // The candle chart's axis size, so every chart in the app reads alike.
  fontSize: "var(--qd-size-micro)",
};

export interface LiteOptions {
  /** Slot width in minutes — picks clock-aligned time labels. */
  slotMinutes: number;
  formatY?: Partial<Record<ScaleId, (value: number) => string>>;
  /** What each axis measures, for a one-pane chart (a pane's own `names` win): the crosshair tag's name. */
  axisNames?: Partial<Record<ScaleId, string>>;
  /** The time under the crosshair. */
  formatTime?: (ms: number) => string;
  /** Slot width the default window aims for, in CSS px. */
  preferredSlotPx?: number;
  /** Widest a slot may be drawn, in CSS px. */
  maxSlotPx?: number;
  /** A solid rule at 0 on this scale. */
  zeroLine?: ScaleId | null;
  /** The clock columns behind the plot (on by default); off leaves the value rows alone. */
  gridColumns?: boolean;
  /** The whole-session overview strip under the time axis. */
  navigator?: boolean;
  /** The panes, top to bottom (one by default). A series' `pane` picks one. */
  panes?: readonly LitePane[];
  /** Room kept clear over the top pane's values, CSS px — for a readout floating on the plot. */
  topInset?: number;
  /**
   * The default window is the whole session rather than its latest bars, and
   * while it still starts at the open it GROWS as slots are appended instead of
   * sliding — a decay curve keeps its morning in view. Zoomed in, appends slide.
   */
  fitSession?: boolean;
  /** Called on every pointer move over the plot, and with null when it leaves. */
  onHover?: (hover: LiteHover | null) => void;
  /** Lines and bands across every pane. Keep the array stable between renders. */
  guides?: readonly LiteGuide[];
  /** A click on the plot that did not move it (a drag pans and does not count). */
  onClickIndex?: (index: number) => void;
  /** Called when the latest slot leaves the view (a pan back) or comes back into it. */
  onFollowChange?: (following: boolean) => void;
  /**
   * Called after a draw whose plot area — inside the host, CSS px, between the
   * value axes and above the time axis — differs from the one last reported:
   * for a readout floating on the plot to keep clear of the axes' labels.
   */
  onPlotChange?: (plot: { x: number; y: number; w: number; h: number }) => void;
  /**
   * Called after a draw whose window or plot differs from the last reported:
   * for marks the host lays over the time axis (the Decay tracker's strips)
   * to follow every pan and zoom. Slot `i`'s centre is
   * `plotX + (i + 0.5 − from) × plotW / (to − from)`.
   */
  onView?: (view: LiteViewport) => void;
  /** Glide live updates (the latest values, the axis, a new slot) instead of
   *  jumping. On by default; reduced motion turns it off whatever this says. */
  animate?: boolean;
}

/** The window and plot as drawn, CSS px inside the host. */
export interface LiteViewport {
  from: number;
  to: number;
  plotX: number;
  plotW: number;
  /** The plot's floor: the time axis runs below it. */
  plotBottom: number;
}

export interface LiteHover {
  index: number;
  /** Pointer position inside the host, CSS px. */
  x: number;
  y: number;
  /** Host size, CSS px — for placing a tooltip. */
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Axis {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
  width: number;
  format: (value: number) => string;
}

type Axes = Partial<Record<ScaleId, Axis>>;

/** One pane, placed: its rect inside the plot's span, and its own scales. */
interface Pane {
  rect: Rect;
  axes: Axes;
}

interface Layout {
  /** The panes' common span: every pane shares its x and width; its height runs from the top pane's top to the bottom pane's floor. */
  plot: Rect;
  panes: Pane[];
  nav: Rect | null;
}

/** A time-axis label, placed: `at` is its slot's centre (the grid column), `x` where its text is centred. */
interface TimeLabel {
  at: number;
  x: number;
  w: number;
  text: string;
  /** A session's date: the major tier. */
  major: boolean;
}

/** A value tag on an axis; `y` is its centre, CSS px. */
interface Tag {
  pane: number;
  side: ScaleId;
  y: number;
  text: string;
  fill: string;
  ink: string;
  /** The name before the value ("Spot"), in a segment reaching into the plot. */
  word?: string | null;
}

/** The crosshair: the hovered slot, its centre while it is over the plot, and the pointer's height and pane while it is over one. */
interface Cross {
  index: number;
  x: number | null;
  y: number | null;
  pane: number | null;
}

/** The crosshair's time under the plot, CSS px. */
interface Readout {
  x: number;
  w: number;
  text: string;
}

type DragMode = "pan" | "stretch" | "nav-move" | "nav-left" | "nav-right" | "split";

const PAD_TOP = 10;
const PAD_SIDE = 10;
const X_AXIS_H = 24;
const NAV_GAP = 6;
const NAV_H = 30;
const PAD_BOTTOM = 4;
const AXIS_LABEL_PAD = 8;
const MIN_LABEL_PX = 64;
const Y_TICK_PX = 44;
/** Least room between two time labels. */
const LABEL_GAP_PX = 12;
/** Value labels closer than this to the plot's top or bottom are left out. */
const EDGE_GUARD_PX = 7;
/** Half a value label's height: a tag reaching this close hides it, whole. */
const LABEL_HALF_H = 7;
/** The value tag, as on the candle chart (CSS px): height, inset from the
 *  canvas edge, outer and inner corners, and the notch pointing at the value. */
const TAG_H = 20;
const TAG_INSET = 3;
const TAG_RADIUS = 3;
const TAG_INNER_RADIUS = 2;
const NOTCH_W = 5;
const NOTCH_H = 5;
/** A named tag's name segment: room either side of the name, its ink's strength, the hairline's. */
const TAG_WORD_PAD = 6;
const TAG_WORD_ALPHA = 0.82;
const TAG_DIVIDER_ALPHA = 0.35;
/** Widest a tag's name may reach into the plot, CSS px; a longer one ends in "…". */
const TAG_WORD_MAX = 110;
/** The bitmap grows and shrinks in steps of this many CSS px, so a resize mostly reuses it. */
const BITMAP_BUCKET = 256;
/** Slots of empty room right of the latest bar, so it never sits on the axis. */
const RIGHT_ROOM = 0.8;
const NAV_EDGE_PX = 6;
const MIN_VISIBLE = 5;
/** Space above and below the values when a range is fitted, as a share of their span. */
const RANGE_PAD = 0.08;
/** Extra room a range gets on the side a value broke out of, so the next ticks land inside. */
const RANGE_ROOM = 0.15;
/** A held range is kept until it is this many times the height the values need. */
const RANGE_SLACK = 1.6;
/** A seam's grip (`paintSeamGrip`), CSS px — the candle chart's. */
const SEAM_GRIP_W = 32;
const SEAM_GRIP_H = 4;
/** The seam between two panes, CSS px — the candle chart's. */
const PANE_SEAM = 1;
/** How close to a seam the pointer can grab it, and the least a pane may shrink to. */
const SPLIT_GRAB_PX = 4;
const PANE_MIN_PX = 40;
/* Candles, as the candle chart draws them (`../candle/engine.ts`). */
const CANDLE_RADIUS_PX = 2;
const HOLLOW_ALPHA = 0.28;

export class LiteChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityObserver: IntersectionObserver;
  private opts: LiteOptions;
  private theme: LiteTheme;
  private readonly colours = new Map<string, string>();
  /** Tag ink per fill, per theme. */
  private readonly inks = new Map<string, string>();

  private times: readonly number[] = [];
  /** What is drawn: the data handed in, or — while a live update glides — copies
   *  of it whose latest slots are on their way from the old values to `target`'s. */
  private series: readonly LiteSeries[] = [];
  /** The data last handed in. */
  private target: readonly LiteSeries[] = [];
  private markers: readonly LiteMarker[] = [];
  /** A live update gliding into place: each moving slot, from → to. */
  private glide: { start: number; slots: GlideSlot[] } | null = null;
  /** The pending frame was asked for by a glide alone (no data, view, size or pointer change). */
  private glideFrame = false;
  /** What the last drawn frame showed, to the device pixel: a glide frame showing the same is skipped. */
  private drawnKey = "";
  /** A slot appended while following: the window easing from where it was. */
  private viewGlide: { start: number; from0: number; to0: number; from1: number; to1: number } | null = null;

  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  /** What is SHOWN, device px, inside a bitmap that may be a bucket larger (`sizeBitmap`). */
  private bw = 0;
  private bh = 0;
  /** The bitmap's size (CSS px, whole buckets) and the scaling it was made at. */
  private bucketW = 0;
  private bucketH = 0;
  private bucketDpr = 0;
  /** The bitmap was handed back while the window was hidden; `measure` rebuilds it. */
  private released = false;
  private readonly stopHiddenWatch: () => void;
  private layout: Layout | null = null;

  /** The visible window, in slot-index space: slot i spans [i, i + 1). */
  private from = 0;
  private to = 0;
  private viewReady = false;
  private resetPending = true;
  /** Each pane's y range as last drawn, by `pane:scale` — held steady, see `steadyRange`. */
  private readonly ranges = new Map<string, [number, number]>();

  /** Pane heights the desk dragged a seam to, as weights; null for the options' own. */
  private userWeights: number[] | null = null;
  /** The options' pane weights, to tell a new arrangement from the same one handed over again. */
  private paneKey = "";
  /** What `onFollowChange` last reported. */
  private following = true;
  /** The plot area `onPlotChange` last reported, as whole px. */
  private reportedPlot = "";
  private reportedView = "";

  private hover: number | null = null;
  private pointer: { x: number; y: number } | null = null;
  private drag: { mode: DragMode; x0: number; y0: number; from0: number; to0: number; seam?: number; heights?: number[] } | null = null;
  /** The seam under the pointer (its upper pane's index), its grip lit; null when on none. */
  private hotSeam: number | null = null;
  private frame = 0;
  /** Which window's clock `frame` was asked of. */
  private frameView: Window | null = null;

  constructor(host: HTMLElement, options: LiteOptions, theme: LiteTheme = DEFAULT_THEME) {
    this.opts = options;
    this.paneKey = (options.panes ?? []).map((p) => p.weight).join(",");
    this.theme = theme;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;left:0;top:0;display:block;touch-action:none;cursor:crosshair";
    host.appendChild(this.canvas);
    // The bitmap can be a bucket larger than the plot (`sizeBitmap`): the host clips it,
    // for paint and for the pointer.
    host.style.overflow = "hidden";
    // Opaque: every frame paints the whole ground anyway, and an opaque canvas
    // gets subpixel (LCD) text, as the candle chart's scene does.
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;

    this.resizeObserver = new ResizeObserver(() => this.measure(true));
    this.resizeObserver.observe(host);
    // A dock tab switch takes the panel off screen and puts it back at the same
    // size, so the resize observer stays silent and the canvas comes back blank
    // until something else (a wheel zoom) asks for a frame. Coming into view
    // always re-measures and redraws.
    this.visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.measure(true);
    });
    this.visibilityObserver.observe(host);
    // A minimised window: hand the bitmap back now — the observers above stay
    // silent while a window is hidden — and rebuild it when it is shown.
    this.stopHiddenWatch = onWindowHidden(host, (hidden) => (hidden ? this.release() : this.measure(true)));

    const c = this.canvas;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
    c.addEventListener("dblclick", this.onDoubleClick);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    this.measure();
  }

  /* -- public API ----------------------------------------------------------- */

  /** The window the chart is drawn in — a pop-out's, once its panel is popped out.
   *  Its scaling and its frame clock are the ones that matter, not the main window's. */
  private view(): Window {
    return this.canvas.ownerDocument.defaultView ?? window;
  }

  destroy() {
    this.frameView?.cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.stopHiddenWatch();
    this.canvas.remove();
  }

  setOptions(options: LiteOptions) {
    this.opts = options;
    // A different arrangement drops a dragged seam; the same one handed over
    // again (every render does) keeps it.
    const key = (options.panes ?? []).map((p) => p.weight).join(",");
    if (key !== this.paneKey) {
      this.paneKey = key;
      this.userWeights = null;
    }
    this.invalidate();
  }

  /** Re-reads every `var(--token)` colour — call on a theme change. */
  setTheme(theme: LiteTheme = this.theme) {
    this.theme = theme;
    this.colours.clear();
    this.inks.clear();
    this.invalidate();
  }

  /**
   * New data. When the latest slot was in view it stays in view as slots are
   * appended (a live session keeps scrolling); a zoom or pan elsewhere is kept.
   */
  setData(times: readonly number[], series: readonly LiteSeries[], markers: readonly LiteMarker[] = []) {
    const oldTimes = this.times;
    const shown = this.series;
    const oldN = oldTimes.length;
    const n = times.length;
    // A window still easing towards a new slot lands first: this update measures from there.
    this.settleView();
    const following = this.viewReady && this.to >= oldN;
    // Older slots put in front (history paged in on a pan back, openalgo-charts' `prependData`):
    // the window moves by as many slots, so the same minutes stay where they were on screen.
    const prepended = this.viewReady ? prependedBy(oldTimes, times) : 0;
    if (prepended > 0) {
      this.from += prepended;
      this.to += prepended;
      if (this.hover !== null) this.hover += prepended;
    }
    const base = oldN + prepended;
    const live = prepended === 0 && isLiveStep(oldTimes, times);
    const glides = this.animating() && this.viewReady && live;
    // A new picture fits its own range; a live step keeps the held one.
    if (!live) this.ranges.clear();
    this.times = times;
    this.target = series;
    this.series = series;
    this.glide = null;
    if (glides) this.startGlide(shown, series, oldN);
    this.markers = markers;
    this.colours.clear();
    if (this.userWeights && this.userWeights.length !== this.paneCount()) this.userWeights = null;
    if (this.viewReady && following && n > base) {
      const from0 = this.from;
      const to0 = this.to;
      if (this.opts.fitSession && this.from <= 0) {
        // The whole session in view: it grows with the session, rather than
        // sliding the open off the left edge a minute at a time.
        this.setView(this.from, this.to + (n - base));
      } else {
        this.from += n - base;
        this.to += n - base;
      }
      // The new slot eases in rather than the whole window stepping by one.
      if (glides) {
        this.viewGlide = { start: this.now(), from0, to0, from1: this.from, to1: this.to };
        this.from = from0;
        this.to = to0;
      }
    }
    if (this.hover !== null && this.hover >= n) this.hover = null;
    this.invalidate();
  }

  /* -- live glide ------------------------------------------------------------ */

  private now(): number {
    return this.view().performance.now();
  }

  /** Whether live updates glide here: asked for, and the desk has not asked for less motion. */
  private animating(): boolean {
    if (this.opts.animate === false) return false;
    return !this.view().matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * Starts gliding the latest slots from what is on screen (`shown`, which may
   * itself be mid-glide) to `next`. A slot only glides between two real values;
   * one that appeared, vanished or did not move is simply drawn. A slot new on
   * the axis glides out of the series' previous value, so a fresh minute grows
   * from where the line was rather than appearing beside it.
   */
  private startGlide(shown: readonly LiteSeries[], next: readonly LiteSeries[], oldN: number) {
    if (shown.length !== next.length) return;
    const n = this.times.length;
    const first = Math.max(0, oldN - GLIDE_TAIL);
    const slots: GlideSlot[] = [];
    const drawn = next.map((s, si) => {
      const before = shown[si];
      if (!before || before.id !== s.id || before.members.length !== s.members.length) return s;
      let members: (number | null)[][] | null = null;
      s.members.forEach((values, m) => {
        const was = before.members[m]!;
        for (let i = first; i < n; i++) {
          const to = values[i];
          const from = i < oldN ? was[i] : lastValue(was);
          if (to === null || to === undefined || from === null || from === undefined) continue;
          if (!Number.isFinite(to) || !Number.isFinite(from) || to === from) continue;
          members ??= s.members.map((v) => v.slice());
          members[m]![i] = from;
          slots.push({ s: si, m, i, from, to });
        }
      });
      return members ? { ...s, members } : s;
    });
    if (slots.length === 0) return;
    this.series = drawn;
    this.glide = { start: this.now(), slots };
  }

  /** Moves every gliding value and the window on to this frame. True while any is still moving. */
  private stepGlide(): boolean {
    const now = this.now();
    let moving = false;
    if (this.glide) {
      const t = Math.min(1, (now - this.glide.start) / GLIDE_MS);
      if (t >= 1) {
        this.series = this.target;
        this.glide = null;
      } else {
        const k = easeOut(t);
        for (const g of this.glide.slots) {
          (this.series[g.s]!.members[g.m] as (number | null)[])[g.i] = g.from + (g.to - g.from) * k;
        }
        moving = true;
      }
    }
    const v = this.viewGlide;
    if (v) {
      const t = Math.min(1, (now - v.start) / GLIDE_MS);
      const k = easeOut(t);
      this.from = v.from0 + (v.from1 - v.from0) * k;
      this.to = v.to0 + (v.to1 - v.to0) * k;
      if (t >= 1) this.viewGlide = null;
      else moving = true;
    }
    return moving;
  }

  /** A window easing towards a new slot lands where it was going, at once. */
  private settleView() {
    const v = this.viewGlide;
    if (!v) return;
    this.viewGlide = null;
    this.from = v.from1;
    this.to = v.to1;
  }

  /** The default window: the latest slots at a comfortable width (the whole session with `fitSession`). */
  resetView() {
    this.resetPending = true;
    this.invalidate();
  }

  /** Back to the latest slot at the current zoom — "go live" after a pan back. */
  scrollToLatest() {
    const n = this.times.length;
    if (n === 0) return;
    const vis = this.to - this.from;
    this.setView(n + RIGHT_ROOM - vis, n + RIGHT_ROOM);
  }

  /** The whole session in view. */
  fitAll() {
    const n = this.times.length;
    if (n === 0) return;
    this.setView(-0.2, n + RIGHT_ROOM);
  }

  /** Zooms about the window's centre; >1 zooms out. */
  zoomBy(factor: number) {
    const mid = (this.from + this.to) / 2;
    this.zoomAround(mid, factor);
  }

  /** Moves the crosshair to the neighbouring slot — keyboard navigation. */
  step(delta: number) {
    const n = this.times.length;
    if (n === 0) return;
    const current = this.hover ?? Math.min(n - 1, Math.floor(this.to) - 1);
    const next = Math.max(0, Math.min(n - 1, current + delta));
    const vis = this.to - this.from;
    if (next < this.from) this.setView(next, next + vis);
    else if (next + 1 > this.to) this.setView(next + 1 - vis, next + 1);
    this.hover = next;
    const layout = this.layout;
    if (layout) {
      const x = this.slotCentre(next, layout.plot);
      this.pointer = { x, y: layout.plot.y + layout.plot.h / 2 };
      this.emitHover();
    }
    this.invalidate();
  }

  clearHover() {
    this.hover = null;
    this.pointer = null;
    this.opts.onHover?.(null);
    this.invalidate();
  }

  /* -- view ------------------------------------------------------------------ */

  private plotWidth(): number {
    return this.layout?.plot.w ?? Math.max(1, this.cssW - 2 * PAD_SIDE - 60);
  }

  private visibleLimits(): [number, number] {
    const n = this.times.length;
    const w = this.plotWidth();
    const maxPx = this.opts.maxSlotPx ?? 90;
    const min = Math.max(Math.min(MIN_VISIBLE, n + RIGHT_ROOM), w / maxPx);
    // Out to the whole series and no further (2026-10-14: 15% past it left an hour of empty time
    // on a session chart's right).
    const max = Math.max(min, n + RIGHT_ROOM + 0.2);
    return [min, Math.min(max, w)]; // never below 1px a slot
  }

  private setView(from: number, to: number) {
    // Anything that sets the window — a drag, a zoom, a reset — takes it from an easing one.
    this.viewGlide = null;
    const n = this.times.length;
    const [minVis, maxVis] = this.visibleLimits();
    let vis = Math.max(minVis, Math.min(maxVis, to - from));
    if (!Number.isFinite(vis) || vis <= 0) vis = Math.max(1, minVis);
    let f = from;
    if (vis >= n + RIGHT_ROOM) {
      // Everything fits: the session sits from the left edge, room for new slots on the right.
      f = -0.2;
    } else {
      // Never pan more than a slot or two past either end of the data: no empty margin.
      const slack = Math.min(vis * 0.15, 2);
      f = Math.max(-0.2 - slack, Math.min(n + RIGHT_ROOM + slack - vis, f));
    }
    this.from = f;
    this.to = f + vis;
    this.viewReady = true;
    this.invalidate();
  }

  private applyDefaultView() {
    const n = this.times.length;
    const w = this.plotWidth();
    if (this.opts.fitSession) {
      // All of it — or, narrower than a pixel a slot, as much as fits, ending on the latest.
      const vis = Math.min(n + RIGHT_ROOM + 0.2, this.visibleLimits()[1]);
      this.setView(n + RIGHT_ROOM - vis, n + RIGHT_ROOM);
      return;
    }
    const preferred = this.opts.preferredSlotPx ?? 16;
    const maxPx = this.opts.maxSlotPx ?? 90;
    const comfy = w / preferred;
    const vis = Math.max(w / maxPx, Math.min(n + RIGHT_ROOM, comfy));
    if (vis >= n + RIGHT_ROOM) this.setView(-0.2, -0.2 + vis);
    else this.setView(n + RIGHT_ROOM - vis, n + RIGHT_ROOM);
  }

  private zoomAround(anchor: number, factor: number) {
    const vis = this.to - this.from;
    const [minVis, maxVis] = this.visibleLimits();
    const next = Math.max(minVis, Math.min(maxVis, vis * factor));
    const ratio = next / vis;
    this.setView(anchor - (anchor - this.from) * ratio, anchor - (anchor - this.from) * ratio + next);
  }

  private slotPx(plot: Rect): number {
    return plot.w / Math.max(1e-6, this.to - this.from);
  }

  private slotCentre(i: number, plot: Rect): number {
    return plot.x + (i + 0.5 - this.from) * this.slotPx(plot);
  }

  /* -- sizing ---------------------------------------------------------------- */

  /** `redraw`: draw even when the size has not changed (the panel came back into view). */
  /** Nothing can see the chart: its bitmap goes, its window and data stay. */
  private release() {
    if (this.released) return;
    this.released = true;
    this.canvas.width = 0;
    this.forgetFont();
    this.widths.clear();
    this.canvas.height = 0;
    this.bucketW = 0;
    this.bucketH = 0;
  }

  /**
   * The bitmap, sized by BUCKET rather than to the pixel (2026-10-10, "resize must be buttery"):
   * setting a canvas's size throws its bitmap and GPU texture away, and a splitter drag resized
   * every frame. Whole `BITMAP_BUCKET` steps, grown when outgrown and shrunk only two buckets
   * short, so a drag reallocates a handful of times; drawing keeps to the shown `bw` × `bh` and
   * the host clips the rest. The candle chart sizes its three the same way.
   */
  private sizeBitmap(w: number, h: number, dpr: number, force: boolean) {
    this.bw = Math.max(1, Math.round(w * dpr));
    this.bh = Math.max(1, Math.round(h * dpr));
    const needW = Math.ceil(w / BITMAP_BUCKET) * BITMAP_BUCKET;
    const needH = Math.ceil(h / BITMAP_BUCKET) * BITMAP_BUCKET;
    // No headroom past the bucket: a spare bucket costs more to composite every frame than
    // the odd reallocation it saves (measured, 2026-10-10: p90 16.8 ms without, 33 ms with).
    const fits = (have: number, need: number) => have >= need && have - need < 2 * BITMAP_BUCKET;
    if (!force && dpr === this.bucketDpr && fits(this.bucketW, needW) && fits(this.bucketH, needH)) return;
    this.bucketW = needW;
    this.bucketH = needH;
    this.bucketDpr = dpr;
    this.canvas.width = Math.max(1, Math.round(this.bucketW * dpr));
    this.forgetFont();
    this.widths.clear();
    this.canvas.height = Math.max(1, Math.round(this.bucketH * dpr));
    this.canvas.style.width = `${this.bucketW}px`;
    this.canvas.style.height = `${this.bucketH}px`;
  }

  /**
   * Keeps the bitmap on the screen's pixel grid (openalgo-charts' "device pixels, exactly"). At a
   * fractional ratio (Windows at 125% or 150%) the host can start part way into a device pixel
   * (5 CSS px is 6.25 device px at 1.25), and the browser then resamples the whole bitmap every
   * frame: thin lines come out soft and uneven, as if broken in places. The canvas is nudged back
   * by that fraction, always under one device pixel; the host clips the sliver, and pointer
   * positions are read off the canvas's own box, so the crosshair follows the nudge.
   */
  private snapToDevicePixels(host: HTMLElement, dpr: number) {
    const r = host.getBoundingClientRect();
    const off = (v: number) => {
      const f = (((v * dpr) % 1) + 1) % 1;
      return f > 0.001 && f < 0.999 ? -f / dpr : 0;
    };
    const dx = off(r.left);
    const dy = off(r.top);
    const t = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
    if (this.canvas.style.transform !== t) this.canvas.style.transform = t;
  }

  private measure(redraw = false) {
    const host = this.canvas.parentElement;
    if (!host) return;
    // A chart moved into a pop-out measures there first: start hearing that window.
    watchDocument(host.ownerDocument);
    const w = host.clientWidth;
    const h = host.clientHeight;
    // Hidden, not resized: a dock tab switch takes the panel out of the page,
    // which reads as 0 × 0. Treating that as a resize squeezed the window to
    // nothing, and the chart came back blank until a wheel zoom re-clamped
    // it. Keep the size, the bitmap and the window as they were.
    if (w <= 0 || h <= 0) return;
    const dpr = this.view().devicePixelRatio || 1;
    this.snapToDevicePixels(host, dpr);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) {
      if (this.released) {
        // Shown again at the size it left: the bitmap back, the view as it was.
        this.released = false;
        this.sizeBitmap(w, h, dpr, true);
        this.draw();
      } else if (redraw) this.draw();
      return;
    }
    this.released = false;
    const oldPlotW = this.layout?.plot.w ?? 0;
    // A resize works from the window's settled edges, not a frame of a glide.
    this.settleView();
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.sizeBitmap(w, h, dpr, false);
    this.layout = null;
    // A resize keeps the slot width and the right edge; the left edge gives. Except a session
    // chart showing all of its session: it stays all of it, stretched or squeezed to the new
    // width, so a panel folding open beside it widens the day rather than adding empty time
    // before the open (2026-10-12, the Simulator's rail).
    const showingAll = this.opts.fitSession === true && this.from <= 0 && this.to >= this.times.length;
    if (this.viewReady && oldPlotW > 0 && !showingAll) {
      const newPlotW = this.computeLayout().plot.w;
      const vis = (this.to - this.from) * (newPlotW / oldPlotW);
      if (newPlotW > 0 && Number.isFinite(vis) && vis > 0) this.from = this.to - vis;
    }
    this.draw();
  }

  private invalidate() {
    // Anything asking for a frame has news: only the glide's own re-arm may be skipped (`glideKey`).
    this.glideFrame = false;
    // A pop-out keeps drawing while the main window is minimised: its own clock.
    const view = this.view();
    // A frame pending in ANOTHER window (popped out, or brought back) may never
    // come; waiting on it froze the chart. Ask the window it is in now.
    if (this.frame && this.frameView === view) return;
    if (this.frame) this.frameView?.cancelAnimationFrame(this.frame);
    this.frameView = view;
    this.frame = view.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /* -- colours and type -------------------------------------------------------- */

  private colour(value: string): string {
    if (!value.startsWith("var(")) return value;
    let resolved = this.colours.get(value);
    if (resolved === undefined) {
      const name = value.slice(4, -1).trim();
      const host = this.canvas.parentElement ?? document.documentElement;
      const read = host.isConnected ? getComputedStyle(host).getPropertyValue(name).trim() : "";
      // An empty read is not cached: a dock tab in the background has its DOM
      // detached, whose computed style is empty, and caching that painted the
      // chart invisible until the next theme change (2026-09-30).
      if (!read) return "transparent";
      resolved = read;
      this.colours.set(value, resolved);
    }
    return resolved;
  }

  /** The ink that reads best on a tag's fill: dark on a light green, light on a deep red. */
  private ink(fill: string): string {
    let ink = this.inks.get(fill);
    if (ink === undefined) {
      ink = readableInk(fill, this.colour(this.theme.inkDark), this.colour(this.theme.inkLight));
      this.inks.set(fill, ink);
    }
    return ink;
  }

  /** The type size, CSS px. */
  private fontPx(): number {
    return Number.parseFloat(this.colour(this.theme.fontSize)) || 11;
  }

  /**
   * Sets the font in DEVICE px, as the candle chart does: the canvas is drawn
   * in device px, so a CSS size drawn as is came out two-thirds size and soft
   * at 150% scaling. Widths read back with `textWidth` are CSS px again.
   */
  private setFont(emphasis = false) {
    const family = this.colour(this.theme.font);
    const px = Math.round(this.fontPx() * this.dpr);
    const font = `${emphasis ? 600 : 400} ${px}px ${family === "transparent" ? "sans-serif" : family}`;
    // Assigning `ctx.font` makes the browser parse the font string, even when it is the same one:
    // it was among the most expensive things in a frame (2026-10-13 profile). Set only on a change.
    // `fontNow` is forgotten wherever the canvas forgets its font: a `restore()` and a resize.
    if (font === this.fontNow) return;
    this.ctx.font = font;
    this.fontNow = font;
  }

  /** The font last set on the context, or "" once the context may have dropped it. */
  private fontNow = "";
  /** Text widths by font and text: axis labels and tags repeat frame after frame. */
  private widths = new Map<string, number>();

  /** Width of `text` in the current font, CSS px. Cached: `measureText` lays the text out each call. */
  private textWidth(text: string): number {
    const key = `${this.fontNow}|${text}`;
    let width = this.widths.get(key);
    if (width === undefined) {
      if (this.widths.size > 4096) this.widths.clear();
      width = this.ctx.measureText(text).width / this.dpr;
      // Only a width measured in a known font is safe to keep.
      if (this.fontNow) this.widths.set(key, width);
    }
    return width;
  }

  /** The context's state was reset (restore, resize): the font must be set again before use. */
  private forgetFont() {
    this.fontNow = "";
  }

  /* -- layout ------------------------------------------------------------------ */

  private visibleRange(): [number, number] {
    const n = this.times.length;
    return [Math.max(0, Math.floor(this.from)), Math.min(n - 1, Math.ceil(this.to) - 1)];
  }

  /** As many panes as the options name, or as the series reach into — whichever is more. */
  private paneCount(): number {
    let n = Math.max(1, this.opts.panes?.length ?? 1);
    for (const s of this.series) n = Math.max(n, (s.pane ?? 0) + 1);
    return n;
  }

  /** Each pane's height, CSS px, from the dragged weights or the options', in `total` less the seams. */
  private paneHeights(total: number): number[] {
    const n = this.paneCount();
    const weights = this.userWeights ?? Array.from({ length: n }, (_, k) => this.opts.panes?.[k]?.weight ?? 1);
    const avail = Math.max(n, total - PANE_SEAM * (n - 1));
    const sum = weights.reduce((a, w) => a + Math.max(0, w), 0) || n;
    const heights: number[] = [];
    let used = 0;
    for (let k = 0; k < n; k++) {
      const h = k === n - 1 ? avail - used : Math.max(1, Math.round((avail * Math.max(0, weights[k] ?? 1)) / sum));
      heights.push(Math.max(1, h));
      used += h;
    }
    return heights;
  }

  /** The pane under a height, CSS px; null over a seam or off the plot. */
  private paneAt(layout: Layout, y: number): number | null {
    const k = layout.panes.findIndex((p) => y >= p.rect.y && y <= p.rect.y + p.rect.h);
    return k < 0 ? null : k;
  }

  private domain(pane: number, scale: ScaleId, i0: number, i1: number): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    let bars = false;
    for (const s of this.series) {
      if (s.scale !== scale || s.visible === false || (s.pane ?? 0) !== pane) continue;
      if (s.type === "bars") bars = true;
      const members = s.type === "line" ? s.members.slice(0, 1) : s.members;
      for (const m of members) {
        for (let i = i0; i <= i1; i++) {
          const v = m[i];
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (bars) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    // NaN on either side is no range at all.
    if (Number.isNaN(hi) || Number.isNaN(lo) || hi < lo) return null;
    if (hi === lo) {
      const d = Math.abs(hi) * 0.01 || 1;
      lo -= d;
      hi += d;
    }
    return [lo, hi];
  }

  /**
   * The y range a pane draws, given the values in view — held steady while it
   * still fits them.
   *
   * Fitting the exact low and high on every update made the whole chart move
   * with the live tip: a decaying straddle prints a new low most ticks, each
   * one lowered the floor and lifted every line, and the tip bouncing back
   * dropped them again. So the range now moves only when it must: when a value
   * leaves it, that side widens with room to spare, so the next few ticks land
   * inside; and it tightens only once the values fill well under its height (a
   * zoom in, or a spike scrolled out of view).
   */
  private steadyRange(key: string, raw: [number, number]): [number, number] {
    const [lo, hi] = raw;
    const span = hi - lo;
    const fresh: [number, number] = [lo - span * RANGE_PAD, hi + span * RANGE_PAD];
    const held = this.ranges.get(key);
    let next = fresh;
    if (held) {
      const widened: [number, number] = [
        lo < held[0] ? lo - span * RANGE_ROOM : held[0],
        hi > held[1] ? hi + span * RANGE_ROOM : held[1],
      ];
      // Too loose once the values fill under `1 / RANGE_SLACK` of it: fit again.
      if (widened[1] - widened[0] <= (fresh[1] - fresh[0]) * RANGE_SLACK) next = widened;
    }
    this.ranges.set(key, next);
    return next;
  }

  private computeLayout(): Layout {
    const nav = this.opts.navigator !== false && this.times.length > 1;
    const bottom = X_AXIS_H + (nav ? NAV_GAP + NAV_H : 0) + PAD_BOTTOM;
    const plotH = Math.max(20, this.cssH - PAD_TOP - bottom);
    const heights = this.paneHeights(plotH);
    const [i0, i1] = this.visibleRange();
    // Sized for the bolder weight: majors and tags print in it.
    this.setFont(true);

    // Each pane fits its own scales; a side's gutter is as wide as its widest
    // pane needs, so every pane's plot lines up over the one time axis.
    const gutter: Record<ScaleId, number> = { left: 0, right: 0 };
    const paneAxes = heights.map((h, k) => {
      const axes: Axes = {};
      for (const scale of ["right", "left"] as const) {
        if (!this.series.some((s) => s.scale === scale && s.visible !== false && (s.pane ?? 0) === k)) continue;
        const raw = i1 >= i0 ? this.domain(k, scale, i0, i1) : null;
        const d = raw ? this.steadyRange(`${k}:${scale}`, raw) : null;
        let [lo, hi] = d ?? [0, 1];
        // Headroom over the top pane's values for a readout floating on the plot.
        const inset = k === 0 ? Math.min(this.opts.topInset ?? 0, h * 0.4) : 0;
        if (inset > 0) hi += ((hi - lo) * inset) / (h - inset);
        const step = niceStep(hi - lo, Math.max(2, Math.floor(h / Y_TICK_PX)));
        const ticks = niceTicks(lo, hi, step);
        const format = this.opts.panes?.[k]?.formatY?.[scale] ?? this.opts.formatY?.[scale] ?? compactNumber;
        // As wide as the widest value it can print, as on the candle chart. The
        // crosshair and latest-value tags print unrounded values — two samples
        // inside the range carry every decimal a formatter keeps, where the edges
        // may not ("25,077.1" against a crosshair's "25,125.11") — and digits are
        // measured as "8"s, so a tick that swaps 1s for 8s never shifts the plot.
        let width = 0;
        for (const t of [...ticks, lo, hi, lo + (hi - lo) * 0.3141592, hi - (hi - lo) * 0.2718281]) {
          width = Math.max(width, this.textWidth(format(t).replace(/\d/g, "8")));
        }
        const axis = { lo, hi, step, ticks, format, width: Math.ceil(Math.max(44, width + 2 * AXIS_LABEL_PAD + TAG_INSET)) };
        axes[scale] = axis;
        gutter[scale] = Math.max(gutter[scale], axis.width);
      }
      return axes;
    });
    const left = gutter.left || PAD_SIDE;
    const right = gutter.right || PAD_SIDE;
    const plot = { x: left, y: PAD_TOP, w: Math.max(20, this.cssW - left - right), h: plotH };
    let y = plot.y;
    const panes = heights.map((h, k) => {
      const pane = { rect: { x: plot.x, y, w: plot.w, h }, axes: paneAxes[k]! };
      y += h + PANE_SEAM;
      return pane;
    });
    const navRect = nav ? { x: plot.x, y: plot.y + plot.h + X_AXIS_H + NAV_GAP, w: plot.w, h: NAV_H } : null;
    return { plot, panes, nav: navRect };
  }

  private yOf(axis: Axis, plot: Rect, value: number): number {
    return plot.y + (1 - (value - axis.lo) / (axis.hi - axis.lo)) * plot.h;
  }

  private valueAt(axis: Axis, plot: Rect, y: number): number {
    return axis.lo + (1 - (y - plot.y) / plot.h) * (axis.hi - axis.lo);
  }

  /** A value on an even multiple of its axis' step: the major tier, as on the candle chart. */
  private isMajor(axis: Axis, value: number): boolean {
    return isMajorTick(Math.round(value / axis.step));
  }

  /* -- drawing primitives (device px) ---------------------------------------------- */

  private dev(v: number): number {
    return Math.round(v * this.dpr);
  }

  private line(): number {
    return Math.max(1, Math.floor(this.dpr));
  }

  /** A rule along a row, on whole device pixels; `dash` in device px, 0 for solid. */
  private hRule(x0: number, x1: number, y: number, colour: string, dash = 0) {
    const ctx = this.ctx;
    ctx.fillStyle = colour;
    const Y = this.dev(y);
    const A = this.dev(x0);
    const B = this.dev(x1);
    const t = this.line();
    if (!dash) return ctx.fillRect(A, Y, B - A, t);
    for (let x = A; x < B; x += dash * 2) ctx.fillRect(x, Y, Math.min(dash, B - x), t);
  }

  /** A rule down a column, on whole device pixels; `dash` in device px, 0 for solid. */
  private vRule(x: number, y0: number, y1: number, colour: string, dash = 0) {
    const ctx = this.ctx;
    ctx.fillStyle = colour;
    const X = this.dev(x);
    const A = this.dev(y0);
    const B = this.dev(y1);
    const t = this.line();
    if (!dash) return ctx.fillRect(X, A, t, B - A);
    for (let y = A; y < B; y += dash * 2) ctx.fillRect(X, y, t, Math.min(dash, B - y));
  }

  /* -- frame ---------------------------------------------------------------------------- */

  private draw() {
    const ctx = this.ctx;
    const W = this.bw;
    const H = this.bh;
    // Detached (a background dock tab): nothing to show, and colours cannot be
    // read — coming back into view redraws (the observers above).
    if (this.released || this.cssW <= 0 || this.cssH <= 0 || !this.canvas.isConnected) return;
    if ((this.view().devicePixelRatio || 1) !== this.dpr) return this.measure();
    // A live update still gliding: this frame's values and window. Frames are
    // asked for only while something moves, so a quiet chart costs nothing.
    const moving = this.stepGlide();

    this.layout = this.computeLayout();
    if (this.resetPending && this.times.length > 0) {
      this.resetPending = false;
      this.applyDefaultView();
      this.layout = this.computeLayout(); // the new window rescales the axes
    }
    const layout = this.layout;
    const { plot, panes, nav } = layout;
    const plotKey = `${Math.round(plot.x)},${Math.round(plot.y)},${Math.round(plot.w)},${Math.round(plot.h)}`;
    // A glide frame that lands every gliding value, the window and the axes on the pixels already
    // drawn changes nothing: skipped (2026-10-14, "CPU spikes as the data arrives": a whole-canvas
    // redraw 15 times an update, 35 at 144 Hz, for a line that moved a pixel or two). The landing
    // frame always draws.
    const glideOnly = this.glideFrame;
    this.glideFrame = false;
    const key = this.glide || this.viewGlide || glideOnly ? `${plotKey}|${this.glideKey(layout)}` : "";
    if (glideOnly && moving && key === this.drawnKey) {
      this.invalidate();
      this.glideFrame = true;
      return;
    }
    this.drawnKey = key;
    if (plotKey !== this.reportedPlot) {
      this.reportedPlot = plotKey;
      this.opts.onPlotChange?.({ x: plot.x, y: plot.y, w: plot.w, h: plot.h });
    }
    if (this.opts.onView) {
      const viewKey = `${this.from.toFixed(4)},${this.to.toFixed(4)},${plotKey}`;
      if (viewKey !== this.reportedView) {
        this.reportedView = viewKey;
        this.opts.onView({ from: this.from, to: this.to, plotX: plot.x, plotW: plot.w, plotBottom: plot.y + plot.h });
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    // Wiped first: an unreadable ground colour paints nothing, and the last
    // frame would show through it.
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this.colour(this.theme.bg);
    ctx.fillRect(0, 0, W, H);

    const px = this.slotPx(plot);
    const [i0, i1] = this.visibleRange();
    const labels = this.layoutTimeLabels(plot, px, i0, i1);
    const cross = this.crosshair(layout);
    // Every tag's place first, so the axis labels they would touch are left
    // out whole — never half a "−1,500" peeking out from under a tag.
    const tags = this.lastValueTags(panes);
    const crossTags = cross ? this.crosshairTags(panes, cross) : [];
    const readout = cross ? this.timeReadout(plot, cross.index) : null;

    panes.forEach((pane, k) => {
      this.paintGrid(pane.rect, pane.axes.right ?? pane.axes.left, labels);
      this.paintWash(pane.rect, px, i0, i1);
      this.paintZero(pane.rect, pane.axes);
      this.paintSeries(k, pane.axes, pane.rect, px, i0, i1);
    });
    this.paintExtremes(panes, i0, i1, tags);
    this.paintGuides(plot, px);
    this.paintEdges(plot, panes);
    const allTags = [...tags, ...crossTags];
    // The top pane's left labels stay out of the band kept for a readout floating on the plot (`topInset`).
    const clearTop = (k: number, h: number) => (k === 0 ? Math.min(this.opts.topInset ?? 0, h * 0.4) : 0);
    panes.forEach((pane, k) =>
      this.paintValueLabels(pane.rect, pane.axes, allTags.filter((tag) => tag.pane === k), clearTop(k, pane.rect.h)),
    );
    this.paintTimeLabels(plot, labels, readout);
    if (cross) this.paintCrosshair(plot, cross);
    this.paintHoverDots(panes);
    for (const tag of tags) this.paintTag(tag, plot);
    for (const tag of crossTags) this.paintTag(tag, plot);
    if (readout) this.paintReadout(plot, readout);
    if (nav) this.drawNavigator(nav);
    this.reportFollowing();
    if (moving) {
      this.invalidate();
      this.glideFrame = true;
    }
  }

  /**
   * This frame's gliding values, window and axes, each to a device pixel. Values are counted in
   * the finest axis's pixels, so a value on a coarser axis can only draw MORE often, never be
   * skipped while it moves.
   */
  private glideKey(layout: Layout): string {
    const dpr = this.dpr;
    let unit = Infinity;
    const parts: number[] = [];
    for (const pane of layout.panes) {
      for (const axis of Object.values(pane.axes)) {
        if (!axis) continue;
        const span = axis.hi - axis.lo;
        const perPixel = span / Math.max(1, pane.rect.h * dpr);
        if (perPixel > 0) {
          unit = Math.min(unit, perPixel);
          parts.push(Math.round(axis.lo / perPixel), Math.round(axis.hi / perPixel));
        }
      }
    }
    const slotPx = this.slotPx(layout.plot) * dpr;
    parts.push(Math.round(this.from * slotPx), Math.round(this.to * slotPx));
    if (this.glide && Number.isFinite(unit)) {
      for (const g of this.glide.slots) {
        const value = this.series[g.s]?.members[g.m]?.[g.i];
        parts.push(typeof value === "number" ? Math.round(value / unit) : Number.NaN);
      }
    }
    return parts.join(",");
  }

  /** Tells the host when the latest slot leaves the view, or comes back into it. */
  private reportFollowing() {
    const n = this.times.length;
    // Where the window is going, not where it is mid-glide: a new slot easing
    // in must not flash the "go live" button for a frame or two.
    const to = this.viewGlide ? this.viewGlide.to1 : this.to;
    const following = n === 0 || to >= n;
    if (following === this.following) return;
    this.following = following;
    this.opts.onFollowChange?.(following);
  }

  /**
   * The time labels: each session's date first (the major tier), then the
   * clock times that fit around them — placed left to right, a day's "15:00"
   * used to take the room and drop the next day's date (2026-09-30). Each is
   * kept whole inside the canvas ("09:15" once read as "9:15" at the left
   * edge) and clear of the others by where it is actually drawn.
   */
  private layoutTimeLabels(plot: Rect, px: number, i0: number, i1: number): TimeLabel[] {
    const n = this.times.length;
    if (n === 0) return [];
    const stepMin = timeLabelStep(this.opts.slotMinutes, px, MIN_LABEL_PX);
    const slot = Math.max(1, Math.round(this.opts.slotMinutes));
    const sessions = istDayNumber(this.times[0]!) !== istDayNumber(this.times[n - 1]!);
    const dates: TimeLabel[] = [];
    const clocks: TimeLabel[] = [];
    // A lone session's opening slot off the step ("09:15" on a 30-minute step):
    // placed last, so it never crowds the evenly spaced times out.
    const opens: TimeLabel[] = [];
    for (let i = Math.max(0, i0 - 1); i <= Math.min(n - 1, i1 + 1); i++) {
      const t = this.times[i]!;
      const newDay = i === 0 || istDayNumber(t) !== istDayNumber(this.times[i - 1]!);
      const mod = istMinuteOfDay(t);
      const onStep = (mod - (mod % slot)) % stepMin === 0;
      if (!newDay && !onStep) continue;
      const at = this.slotCentre(i, plot);
      if (at < plot.x || at > plot.x + plot.w) continue;
      // A date only where there is more than one session to tell apart.
      const major = newDay && sessions;
      const text = major ? istDayMonth(t) : istHhMm(t);
      this.setFont(major);
      const w = this.textWidth(text);
      const x = Math.min(Math.max(at, w / 2 + 2), this.cssW - w / 2 - 2);
      let group = clocks;
      if (major) group = dates;
      else if (!onStep) group = opens;
      group.push({ at, x, w, text, major });
    }
    const placed: TimeLabel[] = [];
    for (const label of [...dates, ...clocks, ...opens]) {
      if (placed.some((p) => Math.abs(p.x - label.x) < (p.w + label.w) / 2 + LABEL_GAP_PX)) continue;
      placed.push(label);
    }
    return placed;
  }

  /** The crosshair, when the pointer (or the keyboard) is on a slot. */
  private crosshair(layout: Layout): Cross | null {
    const h = this.hover;
    if (h === null || !this.pointer || this.drag || h < 0 || h >= this.times.length) return null;
    const plot = layout.plot;
    const x = this.slotCentre(h, plot);
    const pane = this.paneAt(layout, this.pointer.y);
    return {
      index: h,
      x: x >= plot.x && x <= plot.x + plot.w ? x : null,
      y: pane === null ? null : this.pointer.y,
      pane,
    };
  }

  /**
   * Each tagged series' latest value on its axis, pinned inside its pane when
   * it is off the scale — so it can always be read, as on the candle chart —
   * and never on top of another tag on the same side of the same pane.
   */
  private lastValueTags(panes: readonly Pane[]): Tag[] {
    const tags: Tag[] = [];
    panes.forEach((pane, k) => {
      const own: Tag[] = [];
      for (const s of this.series) {
        const axis = pane.axes[s.scale];
        if (!s.lastValueLabel || s.visible === false || !axis || (s.pane ?? 0) !== k) continue;
        const last = this.lastOf(s);
        if (last === null) continue;
        const fill = this.colour(last.colour ?? this.theme.tagBg);
        own.push({ pane: k, side: s.scale, y: this.yOf(axis, pane.rect, last.value), text: axis.format(last.value), fill, ink: this.ink(fill), word: s.name ?? null });
      }
      for (const side of ["right", "left"] as const) {
        spread(
          own.filter((t) => t.side === side),
          pane.rect.y + TAG_H / 2,
          pane.rect.y + pane.rect.h - TAG_H / 2,
        );
      }
      tags.push(...own);
    });
    return tags;
  }

  /** A series' latest value and the colour its tag wears: a candle's close, in its rising or falling colour. */
  private lastOf(s: LiteSeries): { value: number; colour: string | undefined } | null {
    if (s.type !== "candles") {
      const v = lastValue(s.members[0]);
      return v === null ? null : { value: v, colour: this.lineColourAt(s, v) };
    }
    const close = s.members[3];
    const open = s.members[0];
    if (!close || !open) return null;
    for (let i = close.length - 1; i >= 0; i--) {
      const c = close[i];
      const o = open[i];
      if (c === null || c === undefined || !Number.isFinite(c)) continue;
      const up = o === null || o === undefined || c >= o;
      return { value: c, colour: s.colors[up ? 0 : 1] ?? s.colors[0] };
    }
    return null;
  }

  /** The value under the pointer on each axis of its pane: the chart's one inverted chip. */
  private crosshairTags(panes: readonly Pane[], cross: Cross): Tag[] {
    const pane = cross.pane === null ? undefined : panes[cross.pane];
    const y = cross.y;
    if (!pane || y === null || cross.pane === null) return [];
    const rect = pane.rect;
    const fill = this.colour(this.theme.tagBg);
    const ink = this.colour(this.theme.tagText);
    const at = Math.min(Math.max(y, rect.y + TAG_H / 2), rect.y + rect.h - TAG_H / 2);
    const tags: Tag[] = [];
    for (const side of ["right", "left"] as const) {
      const axis = pane.axes[side];
      if (axis) tags.push({ pane: cross.pane, side, y: at, text: axis.format(this.valueAt(axis, rect, y)), fill, ink, word: this.axisName(cross.pane, side) });
    }
    return tags;
  }

  /**
   * What an axis measures: the pane's own name for it, the chart's for a one-pane
   * chart, else the one named series drawn against it. Several series and no name
   * given: none — a crosshair tag must not claim one series' name for another's.
   */
  private axisName(pane: number, side: ScaleId): string | null {
    const given = this.opts.panes?.[pane]?.names?.[side] ?? (pane === 0 ? this.opts.axisNames?.[side] : undefined);
    if (given) return given;
    const named = this.series.filter((s) => s.visible !== false && (s.pane ?? 0) === pane && s.scale === side);
    return named.length === 1 ? (named[0]!.name ?? null) : null;
  }

  /** The crosshair's time: centred under its slot, kept inside the plot's span. */
  private timeReadout(plot: Rect, index: number): Readout {
    const t = this.times[index]!;
    const text = this.opts.formatTime ? this.opts.formatTime(t) : istHhMm(t);
    this.setFont(true);
    const w = this.textWidth(text) + 2 * AXIS_LABEL_PAD;
    const at = this.slotCentre(index, plot);
    return { x: Math.max(plot.x + w / 2, Math.min(plot.x + plot.w - w / 2, at)), w, text };
  }

  /**
   * The grid, behind everything — the candle chart's calm lattice: rows only
   * under the major values of the primary scale, columns down the time labels,
   * a session's first column a step brighter.
   */
  private paintGrid(plot: Rect, axis: Axis | undefined, labels: readonly TimeLabel[]) {
    const ctx = this.ctx;
    const t = this.line();
    const X0 = this.dev(plot.x);
    const X1 = this.dev(plot.x + plot.w);
    const Y0 = this.dev(plot.y);
    const Y1 = this.dev(plot.y + plot.h);
    ctx.fillStyle = this.colour(this.theme.grid);
    if (axis) {
      for (const v of axis.ticks) {
        const y = this.yOf(axis, plot, v);
        if (this.isMajor(axis, v) && y > plot.y + 1 && y < plot.y + plot.h - 1) ctx.fillRect(X0, this.dev(y), X1 - X0, t);
      }
    }
    if (this.opts.gridColumns === false) return;
    for (const major of [false, true]) {
      ctx.fillStyle = this.colour(major ? this.theme.gridMajor : this.theme.grid);
      for (const l of labels) if (l.major === major) ctx.fillRect(this.dev(l.at), Y0, t, Y1 - Y0);
    }
  }

  /** The hovered slot's wash — on a bar chart, where it picks out one slot's columns. */
  private paintWash(plot: Rect, px: number, i0: number, i1: number) {
    const h = this.hover;
    if (h === null || this.drag || h < i0 - 1 || h > i1 + 1) return;
    if (!this.series.some((s) => s.type === "bars" && s.visible !== false)) return;
    const ctx = this.ctx;
    const x0 = plot.x + (h - this.from) * px;
    const X0 = Math.max(this.dev(plot.x), this.dev(x0));
    const X1 = Math.min(this.dev(plot.x + plot.w), this.dev(x0 + px));
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = this.colour(this.theme.wash);
    ctx.fillRect(X0, this.dev(plot.y), X1 - X0, this.dev(plot.y + plot.h) - this.dev(plot.y));
    ctx.globalAlpha = 1;
  }

  private paintZero(plot: Rect, axes: Axes) {
    const axis = this.opts.zeroLine ? axes[this.opts.zeroLine] : undefined;
    if (axis && axis.lo < 0 && axis.hi > 0) this.hRule(plot.x, plot.x + plot.w, this.yOf(axis, plot, 0), this.colour(this.theme.zero));
  }

  /** One pane's series, clipped to it: columns first, then candles, lines over them, then the fills' marks. */
  private paintSeries(pane: number, axes: Axes, plot: Rect, px: number, i0: number, i1: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.dev(plot.x), this.dev(plot.y), this.dev(plot.x + plot.w) - this.dev(plot.x), this.dev(plot.y + plot.h) - this.dev(plot.y));
    ctx.clip();
    for (const type of ["bars", "candles", "line"] as const) {
      for (const s of this.series) {
        const axis = axes[s.scale];
        if (s.type !== type || s.visible === false || !axis || (s.pane ?? 0) !== pane) continue;
        if (type === "bars") this.drawBars(s, axis, plot, px, i0, i1);
        else if (type === "candles") this.drawCandles(s, axis, plot, px, i0, i1);
        else this.drawLine(s, axis, plot, i0, i1);
      }
    }
    this.drawMarkers(pane, axes, plot, i0, i1);
    ctx.restore();
    this.forgetFont();
  }

  /**
   * The High and Low of each `extremes` line over what is on screen: the candle chart's flags,
   * drawn for a line. A ring sits on the point (the line's colour round the chart's ground), a
   * short leader runs from it into the chart, and the value follows with its word a tier quieter
   * ("High 12.40"). The leader points away from the nearer side edge, so the label never runs off
   * the plot, and the label is held inside its pane. Recomputed every frame from the visible
   * slots, so a pan or zoom moves the flags with it.
   */
  private paintExtremes(panes: readonly Pane[], i0: number, i1: number, tags: readonly Tag[]) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    for (const s of this.series) {
      if (!s.extremes || s.type !== "line" || s.visible === false) continue;
      const pane = panes[s.pane ?? 0];
      const axis = pane?.axes[s.scale];
      const values = s.members[0];
      if (!pane || !axis || !values) continue;
      let hi = -Infinity;
      let lo = Infinity;
      let hiAt = -1;
      let loAt = -1;
      for (let i = Math.max(0, i0); i <= Math.min(values.length - 1, i1); i++) {
        const v = values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        if (v > hi) {
          hi = v;
          hiAt = i;
        }
        if (v < lo) {
          lo = v;
          loAt = i;
        }
      }
      if (hiAt < 0 || hi === lo) continue;
      const paneTags = tags.filter((tag) => tag.pane === (s.pane ?? 0));
      const rect = pane.rect;
      const ring = this.colour(this.lineColourAt(s, hi) ?? s.colors[0] ?? "transparent");
      const ringLo = this.colour(this.lineColourAt(s, lo) ?? s.colors[0] ?? "transparent");
      for (const [word, value, at, colour] of [
        ["High", hi, hiAt, ring],
        ["Low", lo, loAt, ringLo],
      ] as const) {
        const x = this.slotCentre(at, rect);
        const y = this.yOf(axis, rect, value);
        if (x < rect.x || x > rect.x + rect.w || y < rect.y - 1 || y > rect.y + rect.h + 1) continue;
        const text = axis.format(value);
        this.setFont(true);
        const valueW = this.textWidth(text);
        this.setFont(false);
        const wordW = this.textWidth(word);
        const gap = 4;
        const len = 12;
        const labelW = wordW + gap + valueW;
        // Toward the chart's middle, unless that side cannot hold the label.
        let leftward = x > rect.x + rect.w / 2;
        if (leftward && x - len - gap - labelW < rect.x + 2) leftward = false;
        else if (!leftward && x + len + gap + labelW > rect.x + rect.w - 2) leftward = true;
        let ty = Math.min(Math.max(y, rect.y + TAG_H / 2), rect.y + rect.h - TAG_H / 2);
        const start = leftward ? x - len - gap - labelW : x + len + gap;
        // A label running into a value tag's word (it reaches into the plot from the right axis)
        // moves one tag height inward: down from a High, up from a Low.
        const reach = rect.x + rect.w - 96;
        if (start + labelW > reach && paneTags.some((tag) => tag.side === "right" && Math.abs(tag.y - ty) < TAG_H)) {
          ty = Math.min(Math.max(ty + (word === "High" ? TAG_H : -TAG_H), rect.y + TAG_H / 2), rect.y + rect.h - TAG_H / 2);
        }
        const X = x * dpr;
        const Y = y * dpr;
        const end = (leftward ? x - len : x + len) * dpr;

        // The leader: the line's colour, half strength.
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = colour;
        ctx.lineWidth = Math.max(1, Math.round(dpr));
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(X, Y);
        ctx.lineTo(end, ty * dpr);
        ctx.stroke();
        ctx.globalAlpha = 1;

        this.paintRing(X, Y, colour);

        // A plate of the chart's own ground behind the label, so a line passing under it never
        // cuts through the text.
        const padX = 4;
        const plateH = 16;
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = this.colour(this.theme.bg);
        ctx.beginPath();
        ctx.roundRect(
          Math.round((start - padX) * dpr),
          Math.round((ty - plateH / 2) * dpr),
          Math.round((labelW + 2 * padX) * dpr),
          Math.round(plateH * dpr),
          3 * dpr,
        );
        ctx.fill();
        ctx.globalAlpha = 1;

        // The label: its word quiet, the value in the strong ink.
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        this.setFont(false);
        ctx.fillStyle = this.colour(this.theme.minor);
        ctx.fillText(word, Math.round(start * dpr), Math.round(ty * dpr));
        this.setFont(true);
        ctx.fillStyle = this.colour(this.theme.major);
        ctx.fillText(text, Math.round((start + wordW + gap) * dpr), Math.round(ty * dpr));
      }
    }
  }

  /** An extreme's ring: the chart's ground inside, the line's colour round it (device px). */
  private paintRing(X: number, Y: number, colour: string) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.beginPath();
    ctx.arc(X, Y, 3.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = this.colour(this.theme.bg);
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.strokeStyle = colour;
    ctx.stroke();
  }

  /** The plot's edges against the axes, and between the panes: a quiet seam, as on the candle chart — not a white rule. */
  private paintEdges(plot: Rect, panes: readonly Pane[]) {
    const ctx = this.ctx;
    const t = this.line();
    const X0 = this.dev(plot.x);
    const X1 = this.dev(plot.x + plot.w);
    const bottom = this.dev(plot.y + plot.h);
    const hasLeft = panes.some((p) => p.axes.left);
    const hasRight = panes.some((p) => p.axes.right);
    const left = hasLeft ? X0 - t : X0;
    const right = hasRight ? X1 + t : X1;
    ctx.fillStyle = this.colour(this.theme.edge);
    ctx.fillRect(left, bottom, right - left, t);
    if (hasRight) ctx.fillRect(X1, 0, t, bottom);
    if (hasLeft) ctx.fillRect(X0 - t, 0, t, bottom);
    // Between two panes the seam runs the canvas' whole width, gutters too, as the candle chart's does.
    for (let k = 0; k < panes.length - 1; k++) {
      const r = panes[k]!.rect;
      ctx.fillRect(0, this.dev(r.y + r.h), this.bw, t);
    }
    for (let k = 0; k < panes.length - 1; k++) {
      const hot = k === this.hotSeam || (this.drag?.mode === "split" && this.drag.seam === k);
      this.paintSeamGrip(plot, panes[k]!.rect, hot);
      ctx.fillStyle = this.colour(this.theme.edge);
    }
  }

  /**
   * A seam's grip: a short rounded bar at the plot's middle, so the seam reads as something to drag
   * (2026-10-16, on request: "a middle line, notch style, showing it can be resized"), as the candle
   * chart draws its own. Quiet at rest; `hot` (pointer on it, or dragging) in the major ink.
   */
  private paintSeamGrip(plot: Rect, above: Rect, hot: boolean) {
    const ctx = this.ctx;
    const w = this.dev(SEAM_GRIP_W);
    const h = Math.max(2, this.dev(SEAM_GRIP_H));
    const x = Math.round(this.dev(plot.x + plot.w / 2) - w / 2);
    const y = this.dev(above.y + above.h + PANE_SEAM / 2) - Math.floor(h / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.lineWidth = Math.max(2, this.dev(2));
    ctx.strokeStyle = this.colour(this.theme.bg);
    ctx.stroke();
    ctx.fillStyle = this.colour(hot ? this.theme.major : this.theme.minor);
    ctx.fill();
  }

  /** The value labels, in the candle chart's two tiers: a major bright and emphasised, the rest quiet. */
  private paintValueLabels(plot: Rect, axes: Axes, tags: readonly Tag[], clearTop = 0) {
    const ctx = this.ctx;
    ctx.textBaseline = "middle";
    for (const major of [true, false]) {
      this.setFont(major);
      ctx.fillStyle = this.colour(major ? this.theme.major : this.theme.minor);
      for (const side of ["right", "left"] as const) {
        const axis = axes[side];
        if (!axis) continue;
        ctx.textAlign = side === "right" ? "left" : "right";
        const x = this.dev(side === "right" ? plot.x + plot.w + AXIS_LABEL_PAD : plot.x - AXIS_LABEL_PAD);
        for (const v of axis.ticks) {
          if (this.isMajor(axis, v) !== major) continue;
          const y = this.yOf(axis, plot, v);
          if (y < plot.y + EDGE_GUARD_PX || y > plot.y + plot.h - EDGE_GUARD_PX) continue;
          if (side === "left" && y < plot.y + clearTop) continue;
          if (tags.some((tag) => tag.side === side && Math.abs(tag.y - y) < TAG_H / 2 + LABEL_HALF_H)) continue;
          ctx.fillText(axis.format(v), x, this.dev(y));
        }
      }
    }
  }

  /** The time labels, a session's date in the major tier; any the crosshair's time touches is left out, whole. */
  private paintTimeLabels(plot: Rect, labels: readonly TimeLabel[], readout: Readout | null) {
    const ctx = this.ctx;
    const y = this.dev(plot.y + plot.h + X_AXIS_H / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const major of [true, false]) {
      this.setFont(major);
      ctx.fillStyle = this.colour(major ? this.theme.major : this.theme.minor);
      for (const l of labels) {
        if (l.major !== major) continue;
        if (readout && Math.abs(readout.x - l.x) < (readout.w + l.w) / 2 + 2) continue;
        ctx.fillText(l.text, this.dev(l.x), y);
      }
    }
  }

  /** The crosshair's rules: dashed, in the chart's quiet guide colour. */
  /** The host's guides: bands first so a line over one stays visible, then each label chip. */
  private paintGuides(plot: Rect, px: number) {
    const guides = this.opts.guides;
    if (!guides || guides.length === 0) return;
    const ctx = this.ctx;
    const n = this.times.length;
    const X0 = this.dev(plot.x);
    const X1 = this.dev(plot.x + plot.w);
    const Y0 = this.dev(plot.y);
    const Y1 = this.dev(plot.y + plot.h);
    const chips: { x: number; text: string; colour: string }[] = [];
    for (const band of [true, false]) {
      for (const g of guides) {
        if (g.index < 0 || g.index >= n || (g.span !== undefined && g.span > 0) !== band) continue;
        const colour = this.colour(g.color);
        let at: number;
        if (band) {
          const a = Math.max(X0, this.dev(plot.x + (g.index - this.from) * px));
          const b = Math.min(X1, this.dev(plot.x + (g.index + g.span! - this.from) * px));
          if (b <= a) continue;
          ctx.globalAlpha = g.alpha ?? 0.16;
          ctx.fillStyle = colour;
          ctx.fillRect(a, Y0, Math.max(this.line(), b - a), Y1 - Y0);
          ctx.globalAlpha = 1;
          at = (a + b) / 2 / this.dpr;
        } else {
          at = this.slotCentre(g.index, plot);
          if (at < plot.x || at > plot.x + plot.w) continue;
          this.vRule(at, plot.y, plot.y + plot.h, colour, g.dashed ? 3 * this.line() : 0);
        }
        if (g.label) chips.push({ x: at, text: g.label, colour });
      }
    }
    if (chips.length === 0) return;
    this.setFont(true);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const h = Math.round(16 * this.dpr);
    const bg = this.colour(this.theme.bg);
    for (const chip of chips) {
      const w = Math.round((this.textWidth(chip.text) + 10) * this.dpr);
      const left = Math.min(Math.max(X0, Math.round(chip.x * this.dpr - w / 2)), X1 - w);
      ctx.fillStyle = chip.colour;
      // At the plot's foot: a host's readout floats over its head.
      const top = Y1 - h;
      ctx.fillRect(left, top, w, h);
      ctx.fillStyle = bg;
      ctx.fillText(chip.text, left + Math.round(w / 2), top + Math.round(h / 2));
    }
  }

  private paintCrosshair(plot: Rect, cross: Cross) {
    const colour = this.colour(this.theme.crosshair);
    const dash = 4 * this.line();
    if (cross.x !== null) this.vRule(cross.x, plot.y, plot.y + plot.h, colour, dash);
    if (cross.y !== null) this.hRule(plot.x, plot.x + plot.w, cross.y, colour, dash);
  }

  /** A dot where the crosshair crosses each line, ringed in the ground so it reads over the shading. */
  private paintHoverDots(panes: readonly Pane[]) {
    const h = this.hover;
    const first = panes[0];
    if (h === null || this.drag || !first) return;
    const x = this.slotCentre(h, first.rect);
    if (x < first.rect.x || x > first.rect.x + first.rect.w) return;
    const ctx = this.ctx;
    const dpr = this.dpr;
    const bg = this.colour(this.theme.bg);
    for (const s of this.series) {
      const pane = panes[s.pane ?? 0];
      const axis = pane?.axes[s.scale];
      const v = s.members[0]?.[h];
      if (!pane || s.type !== "line" || s.visible === false || !axis || v === null || v === undefined || !Number.isFinite(v)) continue;
      const plot = pane.rect;
      const y = this.yOf(axis, plot, v);
      if (y < plot.y || y > plot.y + plot.h) continue;
      ctx.beginPath();
      ctx.arc(x * dpr, y * dpr, 4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x * dpr, y * dpr, 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = this.colour(this.lineColourAt(s, v) ?? "transparent");
      ctx.fill();
    }
  }

  /**
   * A value tag — the candle chart's one shape: a solid body across the axis
   * gutter, its outer corners rounded, with a notch pointing into the plot at
   * the value. Mirrored on the left axis. The value sits where the axis labels
   * do, in the emphasised weight.
   */
  private paintTag(tag: Tag, plot: Rect) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const t = this.line();
    const right = tag.side === "right";
    const d = right ? 1 : -1;
    const inner = right ? this.dev(plot.x + plot.w) + t : this.dev(plot.x) - t;
    const outer = right ? this.bw - Math.round(TAG_INSET * dpr) : Math.round(TAG_INSET * dpr);
    const w = Math.abs(outer - inner);
    const lineH = Math.round(TAG_H * dpr);
    const top = Math.round(tag.y * dpr - lineH / 2);
    const bottom = top + lineH;
    const mid = top + Math.round(lineH / 2);
    // The outer end is a capsule (user, 2026-10-14: LTP tags as Apple pills); the notch end keeps its point.
    const r = Math.max(Math.round(TAG_RADIUS * dpr), Math.floor(lineH / 2));
    const rl = Math.round(TAG_INNER_RADIUS * dpr);
    const nw = Math.round(NOTCH_W * dpr);
    const nh = Math.min(Math.round(NOTCH_H * dpr), Math.floor(lineH / 2) - rl);
    const x = (u: number) => inner + d * u;
    // A named tag reaches into the plot by its name's width: the notch moves out to
    // the name's far edge, so the whole chip still points at the value.
    this.setFont(false);
    const word = tag.word ? fitWord(ctx, tag.word, Math.round(TAG_WORD_MAX * dpr)) : null;
    const s = word ? -Math.round(ctx.measureText(word).width + 2 * TAG_WORD_PAD * dpr) : 0;

    ctx.fillStyle = tag.fill;
    ctx.beginPath();
    ctx.moveTo(x(s + rl), top);
    ctx.lineTo(x(w - r), top);
    ctx.arcTo(x(w), top, x(w), top + r, r);
    ctx.lineTo(x(w), bottom - r);
    ctx.arcTo(x(w), bottom, x(w - r), bottom, r);
    ctx.lineTo(x(s + rl), bottom);
    ctx.arcTo(x(s), bottom, x(s), bottom - rl, rl);
    ctx.lineTo(x(s), mid + nh);
    ctx.lineTo(x(s - nw), mid);
    ctx.lineTo(x(s), mid - nh);
    ctx.lineTo(x(s), top + rl);
    ctx.arcTo(x(s), top, x(s + rl), top, rl);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = tag.ink;
    ctx.textBaseline = "middle";
    if (word) {
      // The name a step quieter than the figure, split from it by a hairline on the plot's edge.
      ctx.globalAlpha = TAG_DIVIDER_ALPHA;
      ctx.fillRect(right ? inner : inner - t, top, t, lineH);
      ctx.globalAlpha = TAG_WORD_ALPHA;
      ctx.textAlign = "center";
      ctx.fillText(word, Math.round((x(s) + x(0)) / 2), mid);
      ctx.globalAlpha = 1;
    }
    this.setFont(true);
    ctx.textAlign = right ? "left" : "right";
    ctx.fillText(tag.text, this.dev(right ? plot.x + plot.w + AXIS_LABEL_PAD : plot.x - AXIS_LABEL_PAD), mid);
  }

  /** The crosshair's time: no box, as on the candle chart — bright and emphasised, the labels it touches left out. */
  private paintReadout(plot: Rect, readout: Readout) {
    const ctx = this.ctx;
    this.setFont(true);
    ctx.fillStyle = this.colour(this.theme.major);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(readout.text, this.dev(readout.x), this.dev(plot.y + plot.h + X_AXIS_H / 2));
  }

  private drawBars(s: LiteSeries, axis: Axis, plot: Rect, px: number, i0: number, i1: number) {
    const ctx = this.ctx;
    const m = s.members.length;
    if (m === 0) return;
    const slotDev = px * this.dpr;
    const group = Math.max(m, Math.floor(slotDev * 0.78));
    const seam = group / m >= 5 ? Math.max(1, Math.round(this.dpr)) : 0;
    const col = Math.max(1, Math.floor((group - seam * (m - 1)) / m));
    const total = col * m + seam * (m - 1);
    const zero = this.dev(this.yOf(axis, plot, Math.min(Math.max(0, axis.lo), axis.hi)));
    const colours = s.colors.map((c) => this.colour(c));
    const hovering = this.hover !== null && !this.drag;
    const style = s.barStyle;
    const below = style?.negativeColor ? this.colour(style.negativeColor) : null;
    const belowEach = style?.negativeColors?.map((c) => this.colour(c)) ?? [];
    // Only where a column is wide enough for the curve to read as one; a
    // hairline column stays a plain rectangle.
    const radius = style?.rounded && col >= 4 ? Math.min(Math.round(2 * this.dpr), Math.floor(col / 3)) : 0;
    for (let i = Math.max(0, i0 - 1); i <= Math.min(this.times.length - 1, i1 + 1); i++) {
      const left = Math.round(this.slotCentre(i, plot) * this.dpr - total / 2);
      // Everything but the hovered slot steps back, so the eye lands on it.
      const slotAlpha = hovering && i !== this.hover ? 0.55 : 1;
      for (let k = 0; k < m; k++) {
        const v = s.members[k]![i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const y = this.dev(this.yOf(axis, plot, v));
        const top = Math.min(y, zero);
        const h = Math.max(1, Math.abs(y - zero)); // a tiny change still shows as a 1px tick
        ctx.globalAlpha = slotAlpha * (v < 0 ? (style?.negativeAlpha ?? 1) : 1);
        ctx.fillStyle = (v < 0 ? (belowEach[k] ?? below) : null) ?? colours[k] ?? colours[0] ?? "transparent";
        const x = left + k * (col + seam);
        const r = Math.min(radius, Math.floor(h / 2));
        if (r > 0) {
          // Rounded at the far end only: the end on the zero line stays square,
          // so every column still stands on one clean baseline.
          ctx.beginPath();
          ctx.roundRect(x, top, col, h, v >= 0 ? [r, r, 0, 0] : [0, 0, r, r]);
          ctx.fill();
        } else {
          ctx.fillRect(x, top, col, h);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Candles, drawn as the candle chart draws them: TradingView's body width for the slot
   * (`candleWidth`; 2.5–4 px apart a fixed 3 px, so tight candles still read as candles, not
   * sticks with gaps — 2026-10-14, the Simulator's day of 1m bars), never over the candle
   * before it, softly rounded over a whole-pixel wick, each colour in one path. Falling candles
   * can be hollow — an outline over a faint fill.
   */
  private drawCandles(s: LiteSeries, axis: Axis, plot: Rect, px: number, i0: number, i1: number) {
    const [open, high, low, close] = s.members;
    if (!open || !high || !low || !close) return;
    const ctx = this.ctx;
    const dpr = this.dpr;
    let wick = Math.max(1, Math.floor(dpr));
    let bw = candleWidth(px, dpr);
    // Body and wick share their parity, so the wick sits dead centre.
    if (bw >= 2 && bw % 2 !== wick % 2) bw -= 1;
    if (bw < wick) wick = bw;
    const half = (bw - wick) >> 1;
    const wickOff = wick >> 1;
    const radius = bw < 4 ? 0 : Math.min(Math.round(CANDLE_RADIUS_PX * dpr), Math.max(1, Math.round(bw / 8)));
    const hollowDown = s.candleStyle?.hollowDown === true && bw >= wick * 2 + 1;
    const y = (v: number) => Math.round(this.yOf(axis, plot, v) * dpr);
    const a = Math.max(0, i0 - 1);
    const b = Math.min(close.length - 1, i1 + 1);
    for (const up of [true, false]) {
      const colour = this.colour(s.colors[up ? 0 : 1] ?? s.colors[0] ?? "transparent");
      const hollow = !up && hollowDown;
      ctx.fillStyle = colour;
      ctx.beginPath();
      // Wicks go straight down; bodies gather in the path and are filled over them.
      const outline = hollow ? new Path2D() : null;
      const inside = hollow ? new Path2D() : null;
      // The candle before this one, whatever its colour: its body's right edge bounds this one's left.
      let before: number | null = null;
      for (let i = a; i <= b; i++) {
        const o = open[i];
        const h = high[i];
        const l = low[i];
        const c = close[i];
        if (o == null || h == null || l == null || c == null || !Number.isFinite(o + h + l + c)) continue;
        const wx = Math.round(this.slotCentre(i, plot) * dpr) - wickOff;
        const prev = before;
        before = wx;
        if (c >= o !== up) continue;
        const yh = y(h);
        const yl = y(l);
        const yo = y(o);
        const yc = y(c);
        const top = Math.min(yo, yc);
        const bh = Math.max(1, Math.abs(yo - yc));
        // TradingView's rule: a body never reaches over the one before it, so it gives way on its left.
        const bx0 = wx - half;
        const bx = prev === null ? bx0 : Math.max(bx0, prev - half + bw);
        const bwHere = Math.max(1, bx0 + bw - bx);
        if (bw <= wick) {
          // Too narrow for a body: the whole bar is one stroke.
          ctx.rect(wx, yh, wick, Math.max(1, yl - yh));
          continue;
        }
        if (!outline || !inside || bh <= wick * 2) {
          ctx.fillRect(wx, yh, wick, Math.max(1, yl - yh));
          candleBody(ctx, bx, top, bwHere, bh, radius);
          continue;
        }
        const bottom = top + bh;
        if (top > yh) ctx.fillRect(wx, yh, wick, top - yh);
        if (yl > bottom) ctx.fillRect(wx, bottom, wick, yl - bottom);
        candleBody(outline, bx + wick / 2, top + wick / 2, bwHere - wick, bh - wick, radius - wick / 2);
        candleBody(inside, bx + wick, top + wick, bwHere - 2 * wick, bh - 2 * wick, radius - wick);
      }
      ctx.fill();
      if (!outline || !inside) continue;
      ctx.strokeStyle = colour;
      ctx.lineWidth = wick;
      ctx.stroke(outline);
      ctx.globalAlpha = HOLLOW_ALPHA;
      ctx.fill(inside);
      ctx.globalAlpha = 1;
    }
  }

  /** A series' colour at a value: a baseline line, or a bar with a colour below 0, takes its side of 0. */
  private lineColourAt(s: LiteSeries, value: number): string | undefined {
    if (s.baseline) return value >= 0 ? s.baseline.up : s.baseline.down;
    if (s.type === "bars" && s.barStyle?.negativeColor && value < 0) return s.barStyle.negativeColor;
    return s.colors[0];
  }

  private drawLine(s: LiteSeries, axis: Axis, plot: Rect, i0: number, i1: number) {
    const ctx = this.ctx;
    const values = s.members[0];
    if (!values) return;
    // The visible stretch as device-px points, broken where a slot has no value.
    const runs: { x: number; y: number }[][] = [];
    let run: { x: number; y: number }[] | null = null;
    for (let i = Math.max(0, i0 - 1); i <= Math.min(values.length - 1, i1 + 1); i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        if (!s.spanGaps) run = null;
        continue;
      }
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push({ x: this.slotCentre(i, plot) * this.dpr, y: this.yOf(axis, plot, v) * this.dpr });
    }
    const stroke = () => {
      ctx.beginPath();
      for (const r of runs) r.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    };
    ctx.lineWidth = Math.max(1, Math.round((s.lineWidth ?? 1.5) * this.dpr));
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash((s.dash ?? []).map((d) => d * this.dpr));
    const baseline = s.baseline;
    if (!baseline) {
      ctx.strokeStyle = this.colour(s.colors[0] ?? "transparent");
      stroke();
    } else {
      // Each side of 0 clipped on its own: shaded to the zero rule and stroked
      // in that side's colour, so the curve changes colour exactly where it
      // crosses. With `flat`, a band the line's own width around 0 is kept for
      // it: a stretch lying on 0 strokes there in that colour, not in both sides'.
      const zero = Math.min(Math.max(this.yOf(axis, plot, 0), plot.y), plot.y + plot.h) * this.dpr;
      const left = this.dev(plot.x);
      const right = this.dev(plot.x + plot.w);
      const top = this.dev(plot.y);
      const bottom = this.dev(plot.y + plot.h);
      const band = baseline.flat ? ctx.lineWidth / 2 + this.dpr : 0;
      const alpha = baseline.fillAlpha ?? 0.16;
      for (const side of ["up", "down"] as const) {
        const colour = this.colour(baseline[side]);
        ctx.save();
        ctx.beginPath();
        if (side === "up") ctx.rect(left, top, right - left, zero - band - top);
        else ctx.rect(left, zero + band, right - left, bottom - zero - band);
        ctx.clip();
        if (baseline.fade) {
          // Strongest at the furthest the curve reaches on this side, gone at 0: depth, not a block.
          let reach = zero;
          for (const r of runs) for (const p of r) reach = side === "up" ? Math.min(reach, p.y) : Math.max(reach, p.y);
          if (reach !== zero) {
            const shade = ctx.createLinearGradient(0, reach, 0, zero);
            shade.addColorStop(0, withAlpha(colour, alpha));
            shade.addColorStop(1, withAlpha(colour, 0));
            ctx.fillStyle = shade;
          } else {
            ctx.fillStyle = withAlpha(colour, 0);
          }
        } else {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = colour;
        }
        ctx.beginPath();
        for (const r of runs) {
          const first = r[0];
          const last = r[r.length - 1];
          if (!first || !last) continue;
          ctx.moveTo(first.x, zero);
          for (const p of r) ctx.lineTo(p.x, p.y);
          ctx.lineTo(last.x, zero);
          ctx.closePath();
        }
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colour;
        stroke();
        ctx.restore();
        this.forgetFont();
      }
      if (baseline.flat && band > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, zero - band, right - left, band * 2);
        ctx.clip();
        ctx.strokeStyle = this.colour(baseline.flat);
        stroke();
        ctx.restore();
        this.forgetFont();
      }
    }
    ctx.setLineDash([]);
  }

  private drawMarkers(pane: number, axes: Axes, plot: Rect, i0: number, i1: number) {
    if (this.markers.length === 0) return;
    const ctx = this.ctx;
    const half = Math.max(3, Math.round(4 * this.dpr));
    const tall = Math.round(half * 1.5);
    const gap = Math.round(4 * this.dpr);
    ctx.lineWidth = Math.max(1, Math.floor(this.dpr));
    ctx.lineJoin = "round";
    ctx.strokeStyle = this.colour(this.theme.bg);
    for (const m of this.markers) {
      const axis = axes[m.scale];
      if (!axis || (m.pane ?? 0) !== pane || m.index < i0 - 1 || m.index > i1 + 1) continue;
      const x = Math.round(this.slotCentre(m.index, plot) * this.dpr);
      const y = Math.round(this.yOf(axis, plot, m.value) * this.dpr);
      const tip = m.shape === "up" ? y + gap : y - gap;
      const base = m.shape === "up" ? tip + tall : tip - tall;
      ctx.beginPath();
      ctx.moveTo(x, tip);
      ctx.lineTo(x - half, base);
      ctx.lineTo(x + half, base);
      ctx.closePath();
      // Outlined in the ground colour, so a mark stays legible over the shading.
      ctx.stroke();
      ctx.fillStyle = this.colour(m.color);
      ctx.fill();
    }
  }

  private drawNavigator(nav: Rect) {
    const ctx = this.ctx;
    const n = this.times.length;
    const theme = this.theme;
    const X0 = this.dev(nav.x);
    const X1 = this.dev(nav.x + nav.w);
    const Y0 = this.dev(nav.y);
    const Y1 = this.dev(nav.y + nav.h);

    // The whole session in miniature: the first bar series around a mid line,
    // or the first line when there are no bars.
    const bars = this.series.find((s) => s.type === "bars" && s.visible !== false);
    const mid = Math.round((Y0 + Y1) / 2);
    const half = (Y1 - Y0) / 2 - this.dpr * 2;
    ctx.globalAlpha = 0.6;
    if (bars) {
      let max = 0;
      for (const m of bars.members) for (const v of m) if (v !== null && Number.isFinite(v)) max = Math.max(max, Math.abs(v));
      const per = (X1 - X0) / n;
      const mCount = bars.members.length;
      const col = Math.max(1, Math.floor((per * 0.8) / mCount));
      for (let k = 0; k < mCount; k++) {
        ctx.fillStyle = this.colour(bars.colors[k] ?? bars.colors[0] ?? "transparent");
        const m = bars.members[k]!;
        for (let i = 0; i < n; i++) {
          const v = m[i];
          if (v === null || v === undefined || !max) continue;
          const h = Math.max(1, Math.round((Math.abs(v) / max) * half));
          const x = Math.round(X0 + i * per + (per - col * mCount) / 2 + k * col);
          ctx.fillRect(x, v >= 0 ? mid - h : mid, col, h);
        }
      }
    } else {
      // The lead line: the last one carrying the axis tag or the up/down shade —
      // a lead is drawn last, over the lines it is read against.
      const lines = this.series.filter((s) => s.type === "line" && s.visible !== false);
      const line = [...lines].reverse().find((s) => s.lastValueLabel || s.baseline) ?? lines[0];
      const values = line?.members[0];
      if (line && values) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of values) {
          if (v === null || !Number.isFinite(v)) continue;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        if (hi > lo) {
          ctx.strokeStyle = this.colour(line.colors[0] ?? "transparent");
          ctx.lineWidth = Math.max(1, Math.round(this.dpr));
          ctx.lineJoin = "round";
          ctx.beginPath();
          values.forEach((v, i) => {
            if (v === null) return;
            const x = X0 + ((i + 0.5) / n) * (X1 - X0);
            const y = Y1 - this.dpr * 3 - ((v - lo) / (hi - lo)) * (Y1 - Y0 - this.dpr * 6);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    // The window: everything outside it dimmed, a frame, and a grip on each edge.
    const wx0 = Math.max(X0, Math.min(X1, Math.round(X0 + (this.from / n) * (X1 - X0))));
    const wx1 = Math.max(X0, Math.min(X1, Math.round(X0 + (this.to / n) * (X1 - X0))));
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = this.colour(theme.bg);
    ctx.fillRect(X0, Y0, wx0 - X0, Y1 - Y0);
    ctx.fillRect(wx1, Y0, X1 - wx1, Y1 - Y0);
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = this.colour(theme.wash);
    ctx.fillRect(wx0, Y0, wx1 - wx0, Y1 - Y0);
    ctx.globalAlpha = 1;

    // The strip's edges are seams, like the plot's; the window's frame a step brighter.
    const t = this.line();
    ctx.fillStyle = this.colour(theme.edge);
    ctx.fillRect(X0, Y0, X1 - X0, t);
    ctx.fillRect(X0, Y1 - t, X1 - X0, t);
    ctx.fillStyle = this.colour(theme.minor);
    ctx.fillRect(wx0, Y0, wx1 - wx0, t);
    ctx.fillRect(wx0, Y1 - t, wx1 - wx0, t);
    ctx.fillRect(wx0, Y0, t, Y1 - Y0);
    ctx.fillRect(wx1 - t, Y0, t, Y1 - Y0);
    // The grips: small pills astride the window's edges.
    const gripH = Math.round((Y1 - Y0) * 0.5);
    const gripW = Math.max(3, Math.round(4 * this.dpr));
    const gy = Math.round((Y0 + Y1 - gripH) / 2);
    ctx.fillStyle = this.colour(theme.handle);
    for (const edge of [wx0, wx1]) {
      ctx.beginPath();
      ctx.roundRect(Math.round(edge - gripW / 2), gy, gripW, gripH, gripW / 2);
      ctx.fill();
    }
  }

  /* -- interaction ------------------------------------------------------------------------- */

  private local(e: PointerEvent | MouseEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The seam between two panes the pointer is on, by its upper pane's index; null when on none. */
  private seamAt(x: number, y: number): number | null {
    const layout = this.layout;
    if (!layout || layout.panes.length < 2 || x < 0 || x > this.cssW) return null;
    for (let k = 0; k < layout.panes.length - 1; k++) {
      const r = layout.panes[k]!.rect;
      if (Math.abs(y - (r.y + r.h + PANE_SEAM / 2)) <= SPLIT_GRAB_PX) return k;
    }
    return null;
  }

  private region(x: number, y: number): "plot" | "time" | "split" | "nav-left" | "nav-right" | "nav-move" | "nav-jump" | "none" {
    const layout = this.layout;
    if (!layout) return "none";
    const { plot, nav } = layout;
    if (this.seamAt(x, y) !== null) return "split";
    if (nav && y >= nav.y - 2 && y <= nav.y + nav.h + 2 && x >= nav.x && x <= nav.x + nav.w) {
      const n = this.times.length;
      const wx0 = nav.x + (this.from / n) * nav.w;
      const wx1 = nav.x + (this.to / n) * nav.w;
      if (Math.abs(x - wx0) <= NAV_EDGE_PX) return "nav-left";
      if (Math.abs(x - wx1) <= NAV_EDGE_PX) return "nav-right";
      return x > wx0 && x < wx1 ? "nav-move" : "nav-jump";
    }
    if (x < plot.x || x > plot.x + plot.w) return "none";
    if (y >= plot.y && y <= plot.y + plot.h) return "plot";
    if (y > plot.y + plot.h && y <= plot.y + plot.h + X_AXIS_H) return "time";
    return "none";
  }

  private setCursor(region: ReturnType<LiteChart["region"]>) {
    const cursor =
      this.drag
        ? this.drag.mode === "pan" || this.drag.mode === "nav-move"
          ? "grabbing"
          : this.drag.mode === "split"
            ? "ns-resize"
            : "ew-resize"
        : region === "split"
          ? "ns-resize"
          : region === "plot"
          ? "crosshair"
          : region === "time" || region === "nav-left" || region === "nav-right"
            ? "ew-resize"
            : region === "nav-move"
              ? "grab"
              : region === "nav-jump"
                ? "pointer"
                : "default";
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  private emitHover() {
    if (this.hover === null || !this.pointer) return this.opts.onHover?.(null);
    this.opts.onHover?.({ index: this.hover, x: this.pointer.x, y: this.pointer.y, width: this.cssW, height: this.cssH });
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.layout) return;
    const { x, y } = this.local(e);
    const region = this.region(x, y);
    const n = this.times.length;
    if (region === "none" || n === 0) return;
    if (region === "split") {
      const seam = this.seamAt(x, y);
      if (seam === null) return;
      this.drag = { mode: "split", x0: x, y0: y, from0: this.from, to0: this.to, seam, heights: this.layout.panes.map((p) => p.rect.h) };
      this.canvas.setPointerCapture(e.pointerId);
      this.opts.onHover?.(null);
      this.setCursor(region);
      this.invalidate();
      return;
    }
    let mode: DragMode = region === "plot" ? "pan" : region === "time" ? "stretch" : (region as DragMode);
    if (region === "nav-jump" && this.layout.nav) {
      // Centre the window where the strip was pressed, then drag from there.
      const nav = this.layout.nav;
      const at = ((x - nav.x) / nav.w) * n;
      const vis = this.to - this.from;
      this.setView(at - vis / 2, at + vis / 2);
      mode = "nav-move";
    }
    this.drag = { mode, x0: x, y0: y, from0: this.from, to0: this.to };
    this.canvas.setPointerCapture(e.pointerId);
    this.opts.onHover?.(null);
    this.setCursor(region);
    this.invalidate();
  };

  private onPointerMove = (e: PointerEvent) => {
    const layout = this.layout;
    if (!layout) return;
    const { x, y } = this.local(e);
    const drag = this.drag;
    if (drag) {
      const dx = x - drag.x0;
      const vis0 = drag.to0 - drag.from0;
      const n = this.times.length;
      const navScale = layout.nav ? n / layout.nav.w : 0;
      switch (drag.mode) {
        case "pan": {
          const d = (dx / layout.plot.w) * vis0;
          this.setView(drag.from0 - d, drag.to0 - d);
          break;
        }
        case "stretch": {
          // Drag the time axis right to spread the slots, left to squeeze them.
          const vis = vis0 * Math.exp(-dx / 160);
          this.setView(drag.to0 - vis, drag.to0);
          break;
        }
        case "nav-move":
          this.setView(drag.from0 + dx * navScale, drag.to0 + dx * navScale);
          break;
        case "nav-left":
          this.setView(Math.min(drag.from0 + dx * navScale, drag.to0 - MIN_VISIBLE), drag.to0);
          break;
        case "nav-right":
          this.setView(drag.from0, Math.max(drag.to0 + dx * navScale, drag.from0 + MIN_VISIBLE));
          break;
        case "split": {
          // The seam moves between its two panes only; neither shrinks past its least.
          const heights = drag.heights;
          const k = drag.seam;
          if (!heights || k === undefined) break;
          const pair = heights[k]! + heights[k + 1]!;
          const least = Math.min(PANE_MIN_PX, pair / 2);
          const upper = Math.max(least, Math.min(pair - least, heights[k]! + (y - drag.y0)));
          const next = heights.slice();
          next[k] = upper;
          next[k + 1] = pair - upper;
          this.userWeights = next;
          this.invalidate();
          break;
        }
      }
      return;
    }
    const region = this.region(x, y);
    this.setCursor(region);
    const seamNow = region === "split" ? this.seamAt(x, y) : null;
    if (seamNow !== this.hotSeam) {
      this.hotSeam = seamNow;
      this.invalidate();
    }
    if (region === "plot" || region === "time") {
      const i = Math.floor(this.from + (x - layout.plot.x) / this.slotPx(layout.plot));
      const index = i >= 0 && i < this.times.length ? i : null;
      this.pointer = { x, y };
      if (index !== this.hover) this.hover = index;
      this.emitHover();
      this.invalidate();
    } else if (this.hover !== null) {
      this.clearHover();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    // A press that never moved is a click on the minute under it, not a pan.
    if (drag.mode === "pan" && this.opts.onClickIndex && this.layout) {
      const { x, y } = this.local(e);
      if (Math.abs(x - drag.x0) < 4 && Math.abs(y - drag.y0) < 4) {
        const i = Math.floor(this.from + (x - this.layout.plot.x) / this.slotPx(this.layout.plot));
        if (i >= 0 && i < this.times.length) this.opts.onClickIndex(i);
      }
    }
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.onPointerMove(e);
    this.invalidate();
  };

  private onPointerLeave = () => {
    if (this.drag) return;
    this.canvas.style.cursor = "default";
    if (this.hotSeam !== null) {
      this.hotSeam = null;
      this.invalidate();
    }
    if (this.hover !== null || this.pointer) this.clearHover();
  };

  private onDoubleClick = (e: MouseEvent) => {
    const { x, y } = this.local(e);
    const region = this.region(x, y);
    if (region === "split") {
      // The panes' own shares again.
      this.userWeights = null;
      this.invalidate();
    } else if (region.startsWith("nav")) this.fitAll();
    else if (region !== "none") this.resetView();
  };

  private onWheel = (e: WheelEvent) => {
    const layout = this.layout;
    if (!layout || this.times.length === 0) return;
    const { x, y } = this.local(e);
    const region = this.region(x, y);
    if (region === "none") return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? layout.plot.w : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const vis = this.to - this.from;
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      // Sideways scroll (or Shift + wheel) pans.
      const d = ((e.shiftKey ? dy || dx : dx) / layout.plot.w) * vis;
      this.setView(this.from + d, this.to + d);
      return;
    }
    // While the latest slot is in view, zoom keeps it pinned to the right edge
    // (a live session stays live); otherwise zoom about the pointer.
    const following = this.to >= this.times.length;
    const anchor = following ? this.to : region.startsWith("nav") ? (this.from + this.to) / 2 : this.from + ((x - layout.plot.x) / layout.plot.w) * vis;
    this.zoomAround(anchor, Math.exp(dy * 0.0015));
    if (this.pointer) this.onPointerMove(e as unknown as PointerEvent);
  };
}

/** A candle body: rounded where it is big enough to show it, a plain rectangle otherwise. */
function candleBody(path: CanvasPath, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, Math.floor(h / 2), Math.floor(w / 2));
  if (rr >= 1) path.roundRect(x, y, w, h, rr);
  else path.rect(x, y, w, h);
}

/** The latest value in `values`; null when there is none. */
/** How long a live update glides: `--qd-dur`, the app's standard transition. */
const GLIDE_MS = 240;
/** The latest slots a live update may move — older ones are history and snap. */
const GLIDE_TAIL = 3;

/** One value gliding: series `s`, member `m`, slot `i`. */
interface GlideSlot {
  s: number;
  m: number;
  i: number;
  from: number;
  to: number;
}

/** Decelerating: most of the way at once, settling gently — `--qd-ease-out`'s shape. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Whether `next` is `prev` moved on by live data: the same slots, or the same
 * slots and a few more at the end. A different session, selection or zoom
 * level is a new picture, which is drawn, not glided into.
 */
function isLiveStep(prev: readonly number[], next: readonly number[]): boolean {
  const a = prev.length;
  const b = next.length;
  if (a === 0 || b < a || b - a > GLIDE_TAIL) return false;
  return prev[0] === next[0] && prev[a - 1] === next[a - 1];
}

/**
 * How many slots were put in front of `prev` to make `next`: the index in `next` of `prev`'s
 * first time, when everything before it is older. 0 when nothing was prepended (a live step, or a
 * different picture altogether).
 */
function prependedBy(prev: readonly number[], next: readonly number[]): number {
  const a = prev.length;
  const first = prev[0];
  if (a === 0 || first === undefined || next.length <= a || next[0]! >= first) return 0;
  // Times ascend: binary search for the old first slot.
  let lo = 1;
  let hi = next.length - a;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (next[mid]! < first) lo = mid + 1;
    else hi = mid;
  }
  return next[lo] === first && next[lo + a - 1] === prev[a - 1] ? lo : 0;
}

function lastValue(values: ReadonlyArray<number | null> | undefined): number | null {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Sorts one side's tags by height and pushes them apart, at least a tag's
 * height, inside [lo, hi] — a run that reaches the floor slides back up.
 */
function spread(tags: Tag[], lo: number, hi: number) {
  tags.sort((a, b) => a.y - b.y);
  let above = -Infinity;
  for (const tag of tags) {
    tag.y = Math.max(Math.min(Math.max(tag.y, lo), hi), above + TAG_H);
    above = tag.y;
  }
  let below = Infinity;
  for (let k = tags.length - 1; k >= 0; k--) {
    const tag = tags[k]!;
    tag.y = Math.min(tag.y, hi, below - TAG_H);
    below = tag.y;
  }
}

/**
 * `colour` at `alpha`, for a canvas gradient stop: a stop of "transparent" would fade through
 * black (stops interpolate unpremultiplied), so both ends keep the colour and only alpha moves.
 * Takes the forms a resolved token comes in: #rgb, #rrggbb, rgb()/rgba(); anything else as is.
 */
function withAlpha(colour: string, alpha: number): string {
  const c = colour.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h.split("").map((d) => d + d).join("") : h;
    const n = Number.parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return c;
}
