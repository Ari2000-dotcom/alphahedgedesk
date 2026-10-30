import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createChart, PaneLegend, type Chart, type CrosshairMoveEvent, type LegendValue, type SeriesApi, type SeriesDataItem } from "openalgo-charts";

import { priceAxisWidth, themeFromPage, token } from "../chart/chartTheme";
import { useChartPixelSnap } from "../chart/useChartPixelSnap";
import { fmt0, fmt2 } from "../core/format";
import type { Bar } from "../hub/types";
import { Spinner } from "../ui/icons";
import { LivePulse, type PulseDot } from "./LivePulse";
import type { StrikeLine } from "./useStrikeLines";

/**
 * The ATM straddle's session on openalgo-charts (github.com/marketcalls/openalgo-charts):
 * spot, synthetic future, ATM IV, India VIX, the straddle premium and its VWAP.
 *
 * Two panes, each with a right and a left scale, so no line is flattened by another's range:
 *
 *   price pane  spot and synthetic future on the right (index points: the gap between them is
 *               the basis); the straddle premium and its session VWAP on the LEFT, their own scale
 *   vol pane    ATM IV on the right, India VIX on the left
 *
 * Drawn the way TradingView's Lightweight Charts draws, on our fork of the library
 * (vendor/openalgo-charts/FORK.md), so it reads as one canvas rather than a page of boxes laid over
 * a picture. The price pane's lines are read on the page's chips row above the chart (`onHover`
 * hands it the minute under the crosshair, `readingOf` the reading); the vol pane's keep the
 * library's canvas legend, a row per line at its top left (name, value in its colour, move since
 * the open, an eye to hide it), reading the same minute, or the latest one. Each line's latest value is a tag in its colour on its
 * own axis with its name in a box beside it, tags that would overlap moved apart, and a dotted
 * rule across the plot for the lines the desk reads. The crosshair stands on a minute, puts a dot
 * on every line there, and labels its time and price in dark chips on the axes. Live minutes go in with `update`; earlier sessions come in
 * front with `prependData` when a pan reaches the first loaded minute (the library's history
 * loader), the view held where it was.
 *
 * Nothing is computed here: every value arrives on the hub's bars.
 */

export type LineId = "spot" | "fut" | "iv" | "vix" | "straddle" | "vwap";

interface Line {
  id: LineId;
  label: string;
  /** The name in the box beside its axis tag, short ("Straddle", "IV"). */
  tag: string;
  pane: 0 | 1;
  side: "left" | "right";
  colour: string;
  /** CSS px, and a whole number of them, as TradingView allows only 1 to 4: a 1.5 px line never
   *  covers a pixel whole, so every pixel along it is part-strength and it reads faded and beaded
   *  up close; at 2 px every column of the line has solid pixels. Drawn at this width times the
   *  display scale, as TradingView draws (2 px at 125% is 2.5 device px). */
  width: number;
  /** TradingView's dotted rule across the plot at the latest value: the lines the desk reads. */
  priceLine: boolean;
  value: (bar: Bar) => number | null;
  format: (value: number) => string;
}

const pct = (value: number) => `${value.toFixed(2)}%`;

/**
 * Added in this order. The synthetic future goes first: the library makes the first price series
 * the instrument, as TradingView treats the main price line. The rest go back to front, the
 * premium last, on top.
 */
const LINES: Line[] = [
  { id: "fut", label: "Syn fut", tag: "Syn fut", pane: 0, side: "right", colour: "--mh-line-fut", width: 2, priceLine: true, value: (b) => b.synth, format: fmt2 },
  { id: "spot", label: "Spot", tag: "Spot", pane: 0, side: "right", colour: "--mh-line-spot", width: 2, priceLine: false, value: (b) => b.spot, format: fmt2 },
  { id: "vwap", label: "VWAP", tag: "VWAP", pane: 0, side: "left", colour: "--mh-line-vwap", width: 1, priceLine: false, value: (b) => b.vwap, format: fmt2 },
  { id: "straddle", label: "ATM straddle", tag: "Straddle", pane: 0, side: "left", colour: "--mh-line-straddle", width: 2, priceLine: true, value: (b) => b.straddle, format: fmt2 },
  { id: "vix", label: "India VIX", tag: "VIX", pane: 1, side: "left", colour: "--mh-line-vix", width: 2, priceLine: false, value: (b) => b.vix, format: fmt2 },
  { id: "iv", label: "ATM IV", tag: "IV", pane: 1, side: "right", colour: "--mh-line-iv", width: 2, priceLine: true, value: (b) => b.iv, format: pct },
];

/** A picked straddle's line: a guide beside the ATM one. */
const EXTRA_WIDTH = 2;

/** Legend rows, top to bottom, in the order the desk reads them: the premium first. */
const READ_ORDER: LineId[] = ["straddle", "vwap", "fut", "spot", "iv", "vix"];
const lineOf = (id: LineId) => LINES.find((l) => l.id === id)!;

/** The legend's text, CSS px: TradingView's status line is a size up from its axes. */
const LEGEND_FONT = 12;

const STORE_KEY = "mh.straddle.hidden";

function readHidden(): Set<LineId> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return new Set((JSON.parse(raw) as LineId[]).filter((id) => LINES.some((l) => l.id === id)));
  } catch {
    // No storage (private window): every line shows.
  }
  return new Set();
}

let hiddenState: ReadonlySet<LineId> = readHidden();
const hiddenListeners = new Set<() => void>();

/** Shows or hides one line, on every chart and in the chips row at once. */
export function toggleLine(id: LineId) {
  const next = new Set(hiddenState);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  hiddenState = next;
  writeHidden(next);
  for (const fn of hiddenListeners) fn();
}

export const useHidden = (): ReadonlySet<LineId> =>
  useSyncExternalStore(
    (fn) => {
      hiddenListeners.add(fn);
      return () => hiddenListeners.delete(fn);
    },
    () => hiddenState,
  );

/**
 * The spotlight. The premium is the chart's main line: full strength, with the synthetic future and
 * spot faded behind it. Pointing at a line's chip (or its legend) puts that line forward and fades
 * every other one; with nothing pointed at, the resting emphasis comes back.
 */
let focusState: LineId | null = null;
const focusListeners = new Set<() => void>();

export function setFocus(id: LineId | null) {
  if (focusState === id) return;
  focusState = id;
  for (const fn of focusListeners) fn();
}

export const useFocus = (): LineId | null =>
  useSyncExternalStore(
    (fn) => {
      focusListeners.add(fn);
      return () => focusListeners.delete(fn);
    },
    () => focusState,
  );

const MAIN_LINE: LineId = "straddle";
const RESTING_FADED = new Set<LineId>(["fut", "spot"]);

/** How a line reads now: how strong its colour is and how heavy it is drawn. */
export function lookOf(id: LineId, focus: LineId | null): { alpha: number; width: number; faded: boolean } {
  if (focus) return id === focus ? { alpha: 1, width: 2, faded: false } : { alpha: 0.32, width: 1, faded: true };
  if (id === MAIN_LINE) return { alpha: 1, width: 2, faded: false };
  if (id === "vwap") return { alpha: 0.9, width: 1, faded: false };
  if (RESTING_FADED.has(id)) return { alpha: 0.5, width: 1, faded: true };
  return { alpha: 0.85, width: 2, faded: false };
}

/** A colour from the palette at a strength; a form that is not #rrggbb is used as it is. */
function tint(colour: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  const hex = m?.[1];
  if (!hex || alpha >= 1) return colour;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The share of the price pane's height that the spot and synthetic lines fill, centred. */
const SPOT_BAND = 0.4;
/** The least span, in index points, the band stands for: a quiet stretch is not blown up to fill it. */
const SPOT_MIN_SPAN = 40;

/**
 * Spot and the synthetic future share the price pane's right scale, and are kept in the middle of
 * the pane: the premium fills the pane on its own scale, and these two read as a band across its
 * middle, so both are seen whole at a glance. The scale is set from the minutes in view, centred
 * and never more than SPOT_BAND of the height, so it neither stretches every wiggle of the index
 * across the pane nor squeezes it flat when an earlier, wider session is scrolled into view.
 */
function fitSpot(chart: Chart, series: ReadonlyMap<LineId, SeriesApi>, bars: readonly Bar[]) {
  const scale = series.get("fut")?.priceScale();
  if (!scale || bars.length === 0) return;
  const view = chart.getVisibleLogicalRange();
  const from = Math.max(0, Math.floor(view.from));
  const to = Math.min(bars.length - 1, Math.ceil(view.to));
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i <= to; i++) {
    const b = bars[i]!;
    for (const v of [b.spot, b.synth]) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo > hi) return;
  const mid = (lo + hi) / 2;
  const half = Math.max(hi - lo, SPOT_MIN_SPAN) / SPOT_BAND / 2;
  scale.setOptions({ marginTop: 0, marginBottom: 0 });
  scale.setFixedRange({ min: mid - half, max: mid + half });
}

/** How near the pointer must be to a line, in px, to pick it up. */
const HOVER_REACH = 14;
/** Once on a line it is held until the pointer is this far off it, so a wobble does not drop it. */
const HOVER_RELEASE = 30;
/** Another line takes over only when it is this much nearer than the held one. */
const HOVER_SWITCH = 6;
/** The pause before the resting emphasis returns, so the gap between two lines does not flash it. */
const HOVER_LINGER = 220;

let lingerTimer: ReturnType<typeof setTimeout> | undefined;

/** Follows the pointer over the chart: holds the line it is on, and lets go only after a pause. */
function followPointer(chart: Chart, seriesOf: ReadonlyMap<LineId, SeriesApi>, point: { y: number } | null, pane: number | null | undefined, bar: Bar | undefined) {
  const pick = point && pane != null && bar ? lineUnder(chart, seriesOf, point.y, pane, bar) : null;
  if (pick) {
    clearTimeout(lingerTimer);
    lingerTimer = undefined;
    setFocus(pick);
  } else if (focusState && lingerTimer === undefined) {
    lingerTimer = setTimeout(() => {
      lingerTimer = undefined;
      setFocus(null);
    }, point ? HOVER_LINGER : 60);
  }
}

/** The line the pointer (container y) is on at that minute, favouring the one already held. */
function lineUnder(chart: Chart, seriesOf: ReadonlyMap<LineId, SeriesApi>, y: number, pane: number, bar: Bar): LineId | null {
  const rect = chart.plotRect(pane);
  if (!rect) return null;
  const gaps = new Map<LineId, number>();
  for (const line of LINES) {
    if (line.pane !== pane || hiddenState.has(line.id)) continue;
    const v = line.value(bar);
    const series = seriesOf.get(line.id);
    if (v === null || !Number.isFinite(v) || !series) continue;
    gaps.set(line.id, Math.abs(rect.top + series.priceScale().priceToY(v) - y));
  }
  let near: LineId | null = null;
  for (const [id, d] of gaps) if (near === null || d < gaps.get(near)!) near = id;
  const held = focusState && gaps.has(focusState) ? focusState : null;
  if (held && gaps.get(held)! <= HOVER_RELEASE) {
    return near && near !== held && gaps.get(near)! <= HOVER_REACH && gaps.get(near)! < gaps.get(held)! - HOVER_SWITCH ? near : held;
  }
  return near && gaps.get(near)! <= HOVER_REACH ? near : null;
}

function paintLines(series: ReadonlyMap<LineId, SeriesApi>, focus: LineId | null) {
  for (const line of LINES) {
    const look = lookOf(line.id, focus);
    series.get(line.id)?.applyOptions({ color: tint(token(line.colour), look.alpha), lineWidth: look.width });
  }
}

function writeHidden(hidden: ReadonlySet<LineId>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...hidden]));
  } catch {
    // A per-viewer convenience only.
  }
}

const sec = (ms: number) => Math.floor(ms / 1000);

/** One line's points: a minute with no value is whitespace, a gap the line does not bridge. */
function points(bars: readonly Bar[], line: Line): SeriesDataItem[] {
  return bars.map((bar) => {
    const v = line.value(bar);
    return v !== null && Number.isFinite(v) ? { time: sec(bar.t), value: v } : { time: sec(bar.t) };
  });
}

/** Earlier sessions' paging state, openalgo-charts' `HistoryLoadingStatus`. */
export type HistoryStatus = "idle" | "loading" | "exhausted" | "error";

export function StraddleChart({
  bars,
  viewKey,
  themeKey,
  history = "idle",
  historyLabel = "",
  onReachStart,
  onRetry,
  extras = [],
  onHover,
  live = false,
}: Readonly<{
  /** Today's session, still ticking: its lines end in a pulsing dot. */
  live?: boolean;
  /** The straddles picked on the option chain: each a line beside the ATM one. */
  extras?: readonly StrikeLine[];
  /** The minute under the crosshair (epoch seconds), or null when it leaves: for the chips row. */
  onHover?: (time: number | null) => void;
  bars: readonly Bar[];
  viewKey: string;
  themeKey: string;
  history?: HistoryStatus;
  /** The session being loaded or that failed, for the pill. */
  historyLabel?: string;
  /** A pan reached the first loaded minute: page in the session before. */
  onReachStart?: () => Promise<void> | void;
  onRetry?: () => void;
}>) {
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const seriesRef = useRef(new Map<LineId, SeriesApi>());
  const extraRef = useRef(new Map<number, SeriesApi>());
  // The vol pane's legend rows on the canvas, one per line.
  const legendRef = useRef(new Map<string, PaneLegend>());
  const shownRef = useRef<{ key: string; bars: readonly Bar[] }>({ key: "", bars: [] });
  const byTime = useRef(new Map<number, Bar>());
  const loaderPending = useRef(false);
  const reachRef = useRef(onReachStart);
  reachRef.current = onReachStart;
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;
  const hidden = useHidden();
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const focus = useFocus();
  const barAt = useRef(new Map<number, Bar>());
  const liveRef = useRef({ live, bars });
  liveRef.current = { live, bars };
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useChartPixelSnap(frame, host);
  // The minute under the crosshair (epoch seconds), or null: the legends read it.
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  /* -- the chart, once ------------------------------------------------------------------------- */
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const chart = createChart(element, {
      timezone: "Asia/Kolkata",
      theme: themeFromPage(),
      priceAxisWidth: priceAxisWidth(),
      // TradingView's crosshair stands on a minute, not between two.
      crosshairSnapToBar: true,
      branding: false,
      // A drag moves through time and price, TradingView's way (a double-click puts the scales
      // back to fitting what is in view).
      navigation: { mousePan: "both" },
    });
    chartRef.current = chart;
    for (const line of LINES) {
      const series = chart.addSeries("line", {
        paneIndex: line.pane,
        priceScaleId: line.side,
        // Indian grouping at a fixed two decimals, as TradingView prints a scale: "22,800.00",
        // "390.80", "16.20", "24.37%".
        priceFormat: { type: "custom", formatter: line.id === "iv" ? pct : fmt2 },
        style: {
          color: tint(token(line.colour), lookOf(line.id, focusRef.current).alpha),
          lineWidth: lookOf(line.id, focusRef.current).width,
          // The name in the box beside its axis tag.
          title: line.tag,
          priceLineVisible: line.priceLine,
          // The latest value as a tag in the line's colour on its own axis, TradingView's way.
          lastValueVisible: true,
          // The VWAP restarts every session: no line from one day's last value up or down to the
          // next day's first, as TradingView draws a session VWAP.
          sessionBreaks: line.id === "vwap",
          visible: !hiddenRef.current.has(line.id),
        },
      });
      seriesRef.current.set(line.id, series);
    }
    chart.setPaneWeight(0, 2);
    chart.setPaneWeight(1, 1);

    // The live end of the premium line: a dot with rings drizzling out of it, on today's session only.
    chart.addPrimitive(
      new LivePulse({
        read: () => {
          const { live: on, bars: all } = liveRef.current;
          const last = all[all.length - 1];
          if (!on || !last) return [];
          const dots: PulseDot[] = [];
          for (const line of LINES) {
            const series = seriesRef.current.get(line.id);
            const value = line.value(last);
            if (line.id !== MAIN_LINE || !series || hiddenRef.current.has(line.id) || value === null || !Number.isFinite(value)) continue;
            dots.push({
              time: sec(last.t),
              value,
              colour: token(line.colour),
              toY: (v) => series.priceScale().priceToY(v),
              strength: lookOf(line.id, focusRef.current).alpha,
            });
          }
          return dots;
        },
      }),
      0,
    );

    // The vol pane's legend: the price pane's lines are read on the chips row over the chart.
    READ_ORDER.map(lineOf)
      .filter((l) => l.pane === 1)
      .forEach((l, row) => {
        const legend = new PaneLegend({ id: l.id, title: l.label, color: token(l.colour), row, font: LEGEND_FONT, actions: ["hide"], hidden: hiddenRef.current.has(l.id) });
        chart.addPrimitive(legend, 1);
        legendRef.current.set(l.id, legend);
      });

    // A legend row's eye.
    const offClick = chart.subscribeClick((id) => {
      const [row, action] = id.split("::");
      if (action === "hide" && LINES.some((l) => l.id === row)) toggleLine(row as LineId);
    });
    const offMove = chart.on("crosshair:move", (e: CrosshairMoveEvent) => {
      setHoverTime(e.time);
      hoverRef.current?.(e.time);
      // Pointing at a line on the chart puts it forward. A drag is a pan, not a hover.
      followPointer(chart, seriesRef.current, e.pressed ? null : e.point, e.paneIndex, e.time === null ? undefined : barAt.current.get(e.time));
    });
    if (import.meta.env.DEV) (window as unknown as { __mhChart?: Chart }).__mhChart = chart;
    // The library asks when a pan nears the oldest loaded minute; it is re-armed once the
    // earlier session is in (below), or the ask came to nothing (no session left, an error).
    chart.setHistoryLoader(() => {
      loaderPending.current = true;
      void Promise.resolve(reachRef.current?.()).finally(() =>
        requestAnimationFrame(() => {
          if (!loaderPending.current) return;
          loaderPending.current = false;
          chart.historyLoadComplete();
        }),
      );
    });

    const series = seriesRef.current;
    const legends = legendRef.current;
    // Scrolling or zooming: spot and the synthetic future are re-centred on what is in view.
    const refit = () => fitSpot(chart, seriesRef.current, shownRef.current.bars);
    const offPan = chart.on("pan", refit);
    const offZoom = chart.on("zoom", refit);
    return () => {
      offPan();
      offZoom();
      offClick();
      offMove();
      chart.destroy();
      chartRef.current = null;
      series.clear();
      legends.clear();
      extraRef.current.clear();
      shownRef.current = { key: "", bars: [] };
    };
  }, []);

  // The bars by minute (epoch seconds), for finding the line under the pointer.
  useEffect(() => {
    barAt.current = new Map(bars.map((b) => [sec(b.t), b]));
  }, [bars]);

  /* -- the spotlight: the main line forward, or the one pointed at ---------------------------------- */
  useEffect(() => {
    paintLines(seriesRef.current, focus);
  }, [focus]);

  /* -- shown and hidden lines --------------------------------------------------------------------- */
  useEffect(() => {
    for (const line of LINES) {
      const off = hidden.has(line.id);
      seriesRef.current.get(line.id)?.applyOptions({ visible: !off });
      legendRef.current.get(line.id)?.setOptions({ hidden: off });
    }
  }, [hidden]);

  /* -- data: a new picture, a live minute, or an earlier session put in front --------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const was = shownRef.current;
    const old = was.bars;
    const sameView = was.key === viewKey && old.length > 0 && bars.length > 0;
    const firstOld = old[0]?.t ?? 0;
    const prependedAt = sameView && bars[0]!.t < firstOld ? bars.findIndex((b) => b.t === firstOld) : -1;

    if (prependedAt > 0) {
      // Earlier minutes in front: the library keeps the same minutes in view.
      const older = bars.slice(0, prependedAt);
      for (const line of LINES) seriesRef.current.get(line.id)?.prependData(points(older, line));
      if (loaderPending.current) {
        loaderPending.current = false;
        chart.historyLoadComplete();
      }
    } else if (sameView && bars[0]!.t === firstOld && bars.length >= old.length && bars.length - old.length <= 2) {
      // A live step: the forming minute changed, or a new one opened (and the one before closed).
      const from = Math.max(0, old.length - 1);
      for (const line of LINES) {
        const s = seriesRef.current.get(line.id);
        if (!s) continue;
        for (const point of points(bars.slice(from), line)) s.update(point);
      }
    } else {
      for (const line of LINES) seriesRef.current.get(line.id)?.setData(points(bars, line));
      if (!sameView) chart.fitContent();
    }
    fitSpot(chart, seriesRef.current, bars);
    shownRef.current = { key: viewKey, bars };
    byTime.current = new Map(bars.map((b) => [sec(b.t), b]));
  }, [bars, viewKey]);

  /* -- the picked straddles: a line each on the premium's own (left) scale --------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const want = new Set(extras.map((e) => e.strike));
    for (const [strike, series] of extraRef.current) {
      if (want.has(strike)) continue;
      series.remove();
      extraRef.current.delete(strike);
    }
    for (const e of extras) {
      let series = extraRef.current.get(e.strike);
      if (!series) {
        series = chart.addSeries("line", {
          paneIndex: 0,
          priceScaleId: "left",
          priceFormat: { type: "custom", formatter: fmt2 },
          style: { color: e.colour, lineWidth: EXTRA_WIDTH, title: fmt0(e.strike), priceLineVisible: false, lastValueVisible: true, visible: true },
        });
        extraRef.current.set(e.strike, series);
      }
      series.applyOptions({ color: e.colour });
      series.setData(e.points);
    }
  }, [extras]);

  /* -- the vol pane's legend readings: the minute under the crosshair, else the latest ------------- */
  const opens = useMemo(() => sessionOpens(bars), [bars]);

  useEffect(() => {
    const paint = () => {
      const legends = legendRef.current;
      const latest = bars[bars.length - 1];
      const bar = (hoverTime !== null ? byTime.current.get(hoverTime) : undefined) ?? latest;
      const open = openOf(opens, bar);
      const up = token("--mh-up");
      const down = token("--mh-down");
      for (const line of LINES) {
        const legend = legends.get(line.id);
        if (!legend) continue;
        const colour = token(line.colour);
        const r = readingOf(line.id, bar, open);
        const values: LegendValue[] = [{ text: r.value, color: colour }];
        if (r.move) values.push({ text: r.move.text, color: r.move.dir > 0 ? up : r.move.dir < 0 ? down : undefined, field: "change" });
        legend.setOptions({ color: colour });
        legend.setValues(values);
      }
    };
    paint();
    // A new palette lands on <html> in the page's own effect, after this one: read it next frame.
    const raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [bars, opens, hoverTime, themeKey]);

  /* -- the palette: the chart's ground, grid, axes and line colours follow it ------------------ */
  useEffect(() => {
    // Next frame: the page puts the new palette on <html> in its own effect, which runs after this one.
    const raf = requestAnimationFrame(() => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.setTheme(themeFromPage());
      paintLines(seriesRef.current, focusRef.current);
    });
    return () => cancelAnimationFrame(raf);
  }, [themeKey]);

  // "Start of available history" says so for a moment, then gets out of the way.
  const [endNote, setEndNote] = useState(false);
  useEffect(() => {
    if (history !== "exhausted") return;
    setEndNote(true);
    const timer = setTimeout(() => setEndNote(false), 2500);
    return () => clearTimeout(timer);
  }, [history]);

  return (
    <div className="oa-chart-frame" ref={frame}>
      <div ref={host} className="oa-chart" aria-label="ATM straddle session: spot, synthetic future, ATM IV, India VIX, premium and its VWAP" />

      {history === "loading" || history === "error" || (history === "exhausted" && endNote) ? (
        <div className={history === "error" ? "chart-history mh-error" : "chart-history"} role="status">
          {history === "loading" ? (
            <>
              <Spinner size={12} />
              Loading {historyLabel}
            </>
          ) : history === "error" ? (
            <>
              Couldn't load {historyLabel}
              <button type="button" className="chart-history-retry" onClick={onRetry}>
                Retry
              </button>
            </>
          ) : (
            "Start of available history"
          )}
        </div>
      ) : null}
    </div>
  );
}

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
/** The IST day a minute falls on: the session it belongs to. */
const istDay = (ms: number) => IST_DAY.format(ms);

/** Each session's first minute, by IST day: what a line's move is measured from. */
export function sessionOpens(bars: readonly Bar[]): Map<string, Bar> {
  const out = new Map<string, Bar>();
  for (const bar of bars) {
    const day = istDay(bar.t);
    if (!out.has(day)) out.set(day, bar);
  }
  return out;
}

/** The session-open minute of `bar`, from `sessionOpens`. */
export const openOf = (opens: ReadonlyMap<string, Bar>, bar: Bar | undefined): Bar | undefined => (bar ? opens.get(istDay(bar.t)) : undefined);

/** A move, as the desk reads it ("+0.59%", "-3.01 pts"), and which way it went. */
export interface Move {
  text: string;
  dir: 1 | -1 | 0;
}

/**
 * One line's reading at a minute: its value, and its move since its session's open. IV moves in
 * vol points, every other line as a percent of where it opened. No move while the open is the
 * only minute: every move would read 0.00%.
 */
export function readingOf(id: LineId, bar: Bar | undefined, open: Bar | undefined): { value: string; move: Move | null } {
  const line = lineOf(id);
  const v = bar ? line.value(bar) : null;
  if (v === null || !Number.isFinite(v)) return { value: "—", move: null };
  const o = open ? line.value(open) : null;
  const move = open !== bar && o !== null && Number.isFinite(o) ? (id === "iv" ? signedMove(v - o, " pts") : percentMove(v, o)) : null;
  return { value: line.format(v), move };
}

/** A move as a percent of where it started. */
export function percentMove(now: number, from: number): Move {
  return signedMove(from !== 0 ? ((now - from) / from) * 100 : 0, "%");
}

function signedMove(d: number, unit: string): Move {
  const r = Number(d.toFixed(2));
  return { text: `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}${unit}`, dir: r > 0 ? 1 : r < 0 ? -1 : 0 };
}
