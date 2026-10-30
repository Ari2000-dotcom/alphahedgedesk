import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createChart, PaneLegend, type Chart, type CrosshairMoveEvent, type LegendValue, type SeriesApi, type SeriesDataItem } from "openalgo-charts";

import { priceAxisWidth, themeFromPage, token } from "../chart/chartTheme";
import { useChartPixelSnap } from "../chart/useChartPixelSnap";
import { fmt0, fmt2 } from "../core/format";
import type { Bar } from "../hub/types";
import { Spinner } from "../ui/icons";
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
  { id: "vwap", label: "VWAP", tag: "VWAP", pane: 0, side: "left", colour: "--mh-line-vwap", width: 2, priceLine: false, value: (b) => b.vwap, format: fmt2 },
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
}: Readonly<{
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
      // A panel that grows or shrinks keeps the same minutes in view (the fork's option): a session
      // fitted while the dock was still laying the panel out fills it once it has its size.
      timeScale: { lockVisibleTimeRangeOnResize: true },
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
          color: token(line.colour),
          lineWidth: line.width,
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
    return () => {
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
      for (const line of LINES) {
        seriesRef.current.get(line.id)?.applyOptions({ color: token(line.colour) });
      }
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
