import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createChart, darkTheme, type Chart, type ChartTheme, type CrosshairMoveEvent, type SeriesApi, type SeriesDataItem } from "openalgo-charts";

import { fmt0, fmt2, fmtUpTo2 } from "../core/format";
import type { Bar } from "../hub/types";
import { CloseIcon, EyeIcon, EyeOffIcon, Spinner } from "../ui/icons";
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
 * The chart is the library's own: its canvas, crosshair, value tags and price lines, time axis,
 * pan and zoom. Over it, each pane's legend (TradingView's way, straight on the chart at the top
 * left: a row per line with its latest value in its colour and its move since the open, and an
 * eye to hide it), QuantDesk's named
 * axis tags, and QuantDesk's crosshair tooltips: a small frosted card in each pane beside the
 * line, reading that pane's lines at the hovered minute (QuantDesk's `CrosshairTip`, `perPane`).
 * Live minutes go in with `update`; earlier sessions come in front with `prependData` when a pan
 * reaches the first loaded minute (the library's history loader), the view held where it was.
 *
 * Nothing is computed here: every value arrives on the hub's bars.
 */

export type LineId = "spot" | "fut" | "iv" | "vix" | "straddle" | "vwap";

interface Line {
  id: LineId;
  label: string;
  /** The word on its axis tag, QuantDesk's way ("NIFTY 21,503", "Net +60.71"). */
  tag: string;
  pane: 0 | 1;
  side: "left" | "right";
  colour: string;
  width: number;
  /** TradingView's dotted rule across the plot at the latest value: the lines the desk reads. */
  priceLine: boolean;
  value: (bar: Bar) => number | null;
  format: (value: number) => string;
}

const pct = (value: number) => `${value.toFixed(2)}%`;

/**
 * Added in this order. The synthetic future goes first: the library makes the first price series
 * the instrument (its axis tag turns green or red on the move, and the crosshair snaps to it), as
 * TradingView treats the main price line. The rest go back to front, the premium last, on top.
 */
const LINES: Line[] = [
  { id: "fut", tag: "Syn fut", label: "Syn fut", pane: 0, side: "right", colour: "--mh-line-fut", width: 1.5, priceLine: true, value: (b) => b.synth, format: fmt2 },
  { id: "spot", tag: "Spot", label: "Spot", pane: 0, side: "right", colour: "--mh-line-spot", width: 1, priceLine: false, value: (b) => b.spot, format: fmt2 },
  { id: "vwap", tag: "VWAP", label: "VWAP", pane: 0, side: "left", colour: "--mh-line-vwap", width: 1.25, priceLine: false, value: (b) => b.vwap, format: fmt2 },
  { id: "straddle", tag: "Straddle", label: "ATM straddle", pane: 0, side: "left", colour: "--mh-line-straddle", width: 2, priceLine: true, value: (b) => b.straddle, format: fmt2 },
  { id: "vix", tag: "VIX", label: "India VIX", pane: 1, side: "left", colour: "--mh-line-vix", width: 1.5, priceLine: false, value: (b) => b.vix, format: fmt2 },
  { id: "iv", tag: "IV", label: "ATM IV", pane: 1, side: "right", colour: "--mh-line-iv", width: 1.75, priceLine: true, value: (b) => b.iv, format: pct },
];

/** Legend rows and tooltip items, in the order the desk reads them: the premium first. */
const READ_ORDER: LineId[] = ["straddle", "vwap", "fut", "spot", "iv", "vix"];
const lineOf = (id: LineId) => LINES.find((l) => l.id === id)!;

/** Each pane's tooltip leads with its name, as QuantDesk's do ("Vega", "Theta"). */
const PANE_NAMES = ["Price", "Vol"] as const;

/** Clear of the crosshair line, and below the top of a pane, CSS px (QuantDesk's `GAP_PX`, `PANE_TOP_PX`). */
const TIP_GAP = 10;
/** Below the one-line legend at the top of a pane, so the two never overlap. */
const TIP_TOP = 28;
/** The legend plate's inset from the plot's top-left corner, CSS px. */
const LEGEND_INSET = 8;

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

/** A token from the page's palette, resolved: the canvas cannot read `var(--x)`. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The library's dark theme on the page's palette, so the chart sits in its container as one piece. */
function themeFromPage(): ChartTheme {
  return {
    ...darkTheme,
    background: token("--mh-bg") || darkTheme.background,
    grid: token("--mh-chart-grid") || darkTheme.grid,
    axisText: token("--mh-chart-axis-text") || darkTheme.axisText,
    axisLine: token("--mh-line-strong") || darkTheme.axisLine,
    paneSeparator: token("--mh-line-strong") || darkTheme.paneSeparator,
    crosshair: token("--mh-chart-crosshair") || darkTheme.crosshair,
    lastPriceText: token("--mh-bg") || darkTheme.lastPriceText,
  };
}

/**
 * A line width that lands on whole device pixels: at Windows' 125% a 1.5 px line is 1.875
 * device px, smeared across three pixel rows by anti-aliasing. Rounded, it is 2, and sharp.
 */
function crispWidth(css: number, dpr: number): number {
  return Math.max(1, Math.round(css * dpr)) / dpr;
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

/** Where the crosshair is: its x in the chart, the minute under it, and the pane the pointer is in. */
interface Hover {
  x: number;
  time: number;
  pane: number | null;
}

export function StraddleChart({
  bars,
  viewKey,
  themeKey,
  history = "idle",
  historyLabel = "",
  onReachStart,
  onRetry,
  extras = [],
  onRemoveExtra,
}: Readonly<{
  /** The straddles picked on the option chain: each a line beside the ATM one, with a remove. */
  extras?: readonly StrikeLine[];
  onRemoveExtra?: (strike: number) => void;
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
  const shownRef = useRef<{ key: string; bars: readonly Bar[] }>({ key: "", bars: [] });
  const byTime = useRef(new Map<number, Bar>());
  const loaderPending = useRef(false);
  const reachRef = useRef(onReachStart);
  reachRef.current = onReachStart;
  const hidden = useHidden();
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [hover, setHover] = useState<Hover | null>(null);
  // Where the chart's box sits inside the frame once snapped to device pixels, CSS px.
  const offset = useRef({ x: 0, y: 0 });
  // The axis tags are re-placed after anything that moves a scale: a pan, a zoom, a resize,
  // a new minute (autoscale), a line shown or hidden. At most once a frame.
  const [, setAxisTick] = useState(0);
  const bumpFrame = useRef(0);
  const bump = () => {
    if (bumpFrame.current) return;
    bumpFrame.current = requestAnimationFrame(() => {
      bumpFrame.current = 0;
      setAxisTick((n) => n + 1);
    });
  };
  const bumpRef = useRef(bump);
  bumpRef.current = bump;


  /* -- the chart, once ------------------------------------------------------------------------- */
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const dpr = window.devicePixelRatio || 1;
    const chart = createChart(element, {
      timezone: "Asia/Kolkata",
      theme: themeFromPage(),
      branding: false,
      // A drag moves through time only; the price scales keep fitting what is in view.
      navigation: { mousePan: "horizontal" },
    });
    chartRef.current = chart;
    for (const line of LINES) {
      const series = chart.addSeries("line", {
        paneIndex: line.pane,
        priceScaleId: line.side,
        // Indian grouping, decimals only where they say something: "22,800", "22,772.98", "24.37%".
        priceFormat: { type: "custom", formatter: line.id === "iv" ? pct : fmtUpTo2 },
        style: {
          color: token(line.colour),
          lineWidth: crispWidth(line.width, dpr),
          title: line.label,
          priceLineVisible: line.priceLine,
          // QuantDesk's named axis tags (below) take the place of the library's value boxes.
          lastValueVisible: false,
          visible: !hiddenRef.current.has(line.id),
        },
      });
      seriesRef.current.set(line.id, series);
    }
    chart.setPaneWeight(0, 2);
    chart.setPaneWeight(1, 1);

    const offMove = chart.on("crosshair:move", (e: CrosshairMoveEvent) => {
      setHover(e.time !== null && e.point ? { x: e.point.x, time: e.time, pane: e.paneIndex ?? null } : null);
    });
    const offPan = chart.on("pan", () => bumpRef.current());
    const offZoom = chart.on("zoom", () => bumpRef.current());
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
    return () => {
      offMove();
      offPan();
      offZoom();
      chart.destroy();
      chartRef.current = null;
      series.clear();
      extraRef.current.clear();
      shownRef.current = { key: "", bars: [] };
    };
  }, []);

  /*
   * -- sharp at any display scale ------------------------------------------------------------------
   * At a fractional ratio (Windows at 125% or 150%) the frame starts part way into a device pixel
   * (5 CSS px is 6.25 device px at 1.25), and a box 1590 px wide is 1987.5 device px: the browser
   * then resamples every canvas each frame and every line comes out soft. The chart's box is set
   * on the next whole device pixel, an exact number of device pixels wide and tall, so its
   * canvases map one to one onto the screen; and the line widths are rounded to whole device
   * pixels for the ratio in force. Done again on a resize and on a change of display scale.
   */
  useEffect(() => {
    const outer = frame.current;
    const inner = host.current;
    if (!outer || !inner) return;
    let ratio = 0;
    let query: MediaQueryList | null = null;
    const snap = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = outer.getBoundingClientRect();
      const dx = Math.ceil(r.left * dpr - 0.001) / dpr - r.left;
      const dy = Math.ceil(r.top * dpr - 0.001) / dpr - r.top;
      const w = Math.floor((r.width - dx) * dpr + 0.001) / dpr;
      const h = Math.floor((r.height - dy) * dpr + 0.001) / dpr;
      offset.current = { x: dx, y: dy };
      Object.assign(inner.style, { left: `${dx}px`, top: `${dy}px`, width: `${w}px`, height: `${h}px` });
      bumpRef.current();
      if (dpr !== ratio) {
        ratio = dpr;
        for (const line of LINES) seriesRef.current.get(line.id)?.applyOptions({ lineWidth: crispWidth(line.width, dpr) });
        query?.removeEventListener("change", snap);
        query = window.matchMedia(`(resolution: ${dpr}dppx)`);
        query.addEventListener("change", snap);
      }
    };
    snap();
    const observer = new ResizeObserver(snap);
    observer.observe(outer);
    window.addEventListener("resize", snap);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", snap);
      query?.removeEventListener("change", snap);
    };
  }, []);

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

  /* -- shown and hidden lines --------------------------------------------------------------------- */
  useEffect(() => {
    for (const line of LINES) {
      const off = hidden.has(line.id);
      seriesRef.current.get(line.id)?.applyOptions({ visible: !off });
    }
    bumpRef.current();
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
    bumpRef.current();
  }, [bars, viewKey]);

  /* -- the picked straddles: a line each on the premium's own (left) scale ------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const want = new Set(extras.map((e) => e.strike));
    for (const [strike, series] of extraRef.current) {
      if (want.has(strike)) continue;
      series.remove();
      extraRef.current.delete(strike);
    }
    const dpr = window.devicePixelRatio || 1;
    for (const e of extras) {
      let series = extraRef.current.get(e.strike);
      if (!series) {
        series = chart.addSeries("line", {
          paneIndex: 0,
          priceScaleId: "left",
          priceFormat: { type: "custom", formatter: fmtUpTo2 },
          style: { color: e.colour, lineWidth: crispWidth(1.5, dpr), title: `Straddle ${e.strike}`, priceLineVisible: false, lastValueVisible: false, visible: true },
        });
        extraRef.current.set(e.strike, series);
      }
      series.applyOptions({ color: e.colour });
      series.setData(e.points);
    }
    bumpRef.current();
  }, [extras]);

  // "Start of available history" says so for a moment, then gets out of the way.
  const [endNote, setEndNote] = useState(false);
  useEffect(() => {
    if (history !== "exhausted") return;
    setEndNote(true);
    const timer = setTimeout(() => setEndNote(false), 2500);
    return () => clearTimeout(timer);
  }, [history]);

  /* -- QuantDesk's crosshair tooltips: one small card per pane ----------------------------------- */
  const hoveredBar = hover ? byTime.current.get(hover.time) : undefined;
  const chart = chartRef.current;
  const width = frame.current?.clientWidth ?? 0;
  const tips =
    hover && hoveredBar && chart
      ? ([0, 1] as const).flatMap((pane) => {
          const rect = chart.plotRect(pane);
          const items = READ_ORDER.map(lineOf).filter((l) => l.pane === pane && !hidden.has(l.id));
          if (!rect || rect.height < 40 || items.length === 0) return [];
          return [
            {
              pane,
              top: Math.round(offset.current.y + rect.top + TIP_TOP),
              here: hover.pane === pane,
              items: [
                ...items.map((l) => {
                  const v = l.value(hoveredBar);
                  return { id: l.id as string, name: l.id === "straddle" ? `Straddle ${fmt0(hoveredBar.strike)}` : l.label, colour: `var(${l.colour})`, value: v !== null && Number.isFinite(v) ? l.format(v) : "—" };
                }),
                ...(pane === 0
                  ? extras.map((e) => {
                      const v = e.byTime.get(hover.time);
                      return { id: `x:${e.strike}`, name: `Straddle ${fmt0(e.strike)}`, colour: e.colour, value: v !== undefined ? fmt2(v) : "—" };
                    })
                  : []),
              ],
            },
          ];
        })
      : [];
  const anchor = hover ? Math.round(offset.current.x + hover.x) : 0;

  /* -- the legends: a plate per pane, each line's latest value and its move since today's open ----- */
  const shownBars = shownRef.current.bars;
  const legendBar = shownBars[shownBars.length - 1];
  // Today's open: the first minute of the latest bar's session (earlier sessions may sit in front).
  const openBar = legendBar ? shownBars.find((b) => istDay(b.t) === istDay(legendBar.t)) : undefined;
  const legends = chart
    ? ([0, 1] as const).flatMap((pane) => {
        const rect = chart.plotRect(pane);
        if (!rect || rect.height < 40) return [];
        const rows = READ_ORDER.map(lineOf)
          .filter((l) => l.pane === pane)
          .map((l) => {
            const v = legendBar ? l.value(legendBar) : null;
            const o = openBar ? l.value(openBar) : null;
            const has = v !== null && Number.isFinite(v);
            return {
              id: l.id as string,
              lineId: l.id as LineId | undefined,
              onRemove: undefined as (() => void) | undefined,
              name: l.label,
              detail: l.id === "straddle" && legendBar ? fmt0(legendBar.strike) : "",
              colour: `var(${l.colour})`,
              value: has ? l.format(v) : "—",
              // Nothing to say while the open is the only minute: every move would read 0.00%.
              change: has && openBar !== legendBar && o !== null && Number.isFinite(o) ? changeOf(l, v, o) : null,
              off: hidden.has(l.id),
            };
          });
        if (pane === 0) {
          for (const e of extras) {
            const d = e.first !== null && e.last !== null && e.first !== 0 ? ((e.last - e.first) / e.first) * 100 : null;
            const r = d === null ? null : Number(d.toFixed(2));
            rows.push({
              id: `x:${e.strike}`,
              lineId: undefined,
              onRemove: () => onRemoveExtra?.(e.strike),
              name: "Straddle",
              detail: fmt0(e.strike),
              colour: e.colour,
              value: e.last !== null ? fmt2(e.last) : "—",
              change: r === null ? null : { text: `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}%`, tone: r > 0 ? "mh-up" : r < 0 ? "mh-down" : "" },
              off: false,
            });
          }
        }
        return [
          {
            pane,
            left: Math.round(offset.current.x + rect.left + LEGEND_INSET),
            top: Math.round(offset.current.y + rect.top + LEGEND_INSET - 2),
            maxWidth: Math.max(0, Math.floor(rect.width - 2 * LEGEND_INSET)),
            rows,
          },
        ];
      })
    : [];
  const toggle = toggleLine;

  /* -- QuantDesk's axis tags: each line's latest value on its own axis, named ---------------------- */
  const lastBar = shownRef.current.bars[shownRef.current.bars.length - 1];
  const axisTags: AxisTag[] = [];
  if (chart && lastBar) {
    for (const line of LINES) {
      if (hidden.has(line.id)) continue;
      const v = line.value(lastBar);
      const rect = chart.plotRect(line.pane);
      if (v === null || !Number.isFinite(v) || !rect) continue;
      const y = yOf(seriesRef.current.get(line.id), v, rect);
      if (y === null) continue;
      axisTags.push({ id: line.id, side: line.side, pane: line.pane, y, word: line.tag, text: line.format(v), colour: `var(${line.colour})`, lo: rect.top, hi: rect.top + rect.height });
    }
    const priceRect = chart.plotRect(0);
    if (priceRect) {
      for (const e of extras) {
        if (e.last === null) continue;
        const y = yOf(extraRef.current.get(e.strike), e.last, priceRect);
        if (y === null) continue;
        axisTags.push({ id: `x:${e.strike}`, side: "left", pane: 0, y, word: fmt0(e.strike), text: fmt2(e.last), colour: e.colour, lo: priceRect.top, hi: priceRect.top + priceRect.height });
      }
    }
    for (const pane of [0, 1]) for (const side of ["left", "right"] as const) spread(axisTags.filter((t) => t.pane === pane && t.side === side));
  }
  const flip = anchor > width / 2;

  return (
    <div className="straddle-chart" ref={frame} onPointerLeave={() => setHover(null)}>
      <div ref={host} className="oa-chart" aria-label="ATM straddle session: spot, synthetic future, ATM IV, India VIX, premium and its VWAP" />

      {legends.map((legend) => (
        <div key={legend.pane} className="mh-legend" style={{ left: legend.left, top: legend.top, maxWidth: legend.maxWidth }}>
          {legend.rows.map((row) => (
            <div key={row.id} className="mh-legend-row" data-off={row.off ? "" : undefined}>
              <span aria-hidden className="mh-legend-mark" style={{ background: row.colour }} />
              <span className="mh-legend-name">
                {row.name}
                {row.detail ? <span className="mh-legend-detail">{row.detail}</span> : null}
              </span>
              <span className="mh-legend-value" style={{ color: row.colour }}>
                {row.value}
              </span>
              <span className={`mh-legend-change ${row.change?.tone ?? ""}`}>{row.change?.text ?? ""}</span>
              {row.onRemove ? (
                <button type="button" className="mh-legend-eye" aria-label={`Remove the ${row.detail} straddle`} title={`Remove the ${row.detail} straddle`} onClick={row.onRemove}>
                  <CloseIcon size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  className="mh-legend-eye"
                  aria-pressed={!row.off}
                  aria-label={row.off ? `Show ${row.name}` : `Hide ${row.name}`}
                  title={row.off ? `Show ${row.name}` : `Hide ${row.name}`}
                  onClick={() => toggle(row.lineId!)}
                >
                  {row.off ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                </button>
              )}
            </div>
          ))}
        </div>
      ))}

      {axisTags.map((tag) => (
        <div
          key={tag.id}
          aria-hidden
          className="mh-axis-tag"
          data-side={tag.side}
          style={{ top: Math.round(offset.current.y + tag.y - TAG_H / 2), background: tag.colour }}
        >
          <span className="mh-axis-tag-word">{tag.word}</span>
          <span className="mh-axis-tag-value">{tag.text}</span>
        </div>
      ))}

      {tips.map((tip) => (
        <TipCard key={tip.pane} anchor={anchor} flip={flip} top={tip.top} here={tip.here}>
          <span className="mh-tipitem-name mh-tip-pane" data-here={tip.here ? "" : undefined}>
            {PANE_NAMES[tip.pane]}
          </span>
          {tip.items.map((item) => (
            <span key={item.id} className="mh-tipitem">
              <span aria-hidden className="mh-tipitem-mark" style={{ background: item.colour }} />
              <span className="mh-tipitem-name">{item.name}</span>
              <span className="mh-tipitem-value">{item.value}</span>
            </span>
          ))}
        </TipCard>
      ))}

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
const istDay = (ms: number) => IST_DAY.format(ms);

/**
 * A line's move since today's open, as the desk reads it: IV in vol points, every other line as a
 * percent of where it opened. Green up, red down.
 */
function changeOf(line: Line, now: number, open: number): { text: string; tone: string } {
  const d = line.id === "iv" ? now - open : open !== 0 ? ((now - open) / open) * 100 : 0;
  const r = Number(d.toFixed(2));
  const sign = r > 0 ? "+" : r < 0 ? "−" : "";
  const tone = r > 0 ? "mh-up" : r < 0 ? "mh-down" : "";
  return { text: `${sign}${Math.abs(r).toFixed(2)}${line.id === "iv" ? " pts" : "%"}`, tone };
}

/** An axis tag's height and the least gap between two on one axis, CSS px. */
const TAG_H = 18;
const TAG_GAP = 2;

interface AxisTag {
  id: string;
  side: "left" | "right";
  pane: number;
  /** Centre, container px. */
  y: number;
  word: string;
  text: string;
  colour: string;
  /** The pane's plot top and bottom: a tag never leaves its pane. */
  lo: number;
  hi: number;
}

/**
 * A value's y on a line's own scale, container px: read off that scale's range (its margins
 * included) over the pane's plot, the same linear map the library draws with. Its own
 * `priceToCoordinate` reads only a pane's right scale, and below the first pane it came back
 * pane-local rather than container-relative.
 */
function yOf(series: SeriesApi | undefined, value: number, rect: { top: number; height: number }): number | null {
  const range = series?.priceScale().priceRange();
  if (!range || !(range.max > range.min)) return null;
  return rect.top + ((range.max - value) / (range.max - range.min)) * rect.height;
}

/** Tags on one axis of one pane, spread apart so none covers another (QuantDesk's `spread`), kept inside the pane. */
function spread(tags: AxisTag[]) {
  if (tags.length === 0) return;
  tags.sort((a, b) => a.y - b.y);
  const step = TAG_H + TAG_GAP;
  const lo = tags[0]!.lo + TAG_H / 2;
  const hi = tags[0]!.hi - TAG_H / 2;
  for (let i = 0; i < tags.length; i++) {
    const min = i === 0 ? lo : tags[i - 1]!.y + step;
    tags[i]!.y = Math.max(tags[i]!.y, min);
  }
  // Pushed past the foot: walk back up from the bottom.
  for (let i = tags.length - 1; i >= 0; i--) {
    const max = i === tags.length - 1 ? hi : tags[i + 1]!.y - step;
    tags[i]!.y = Math.min(tags[i]!.y, max);
  }
}

/**
 * One tooltip card (QuantDesk's `TipCard`): beside the crosshair, on the side with more room,
 * placed on whole pixels and measured before it is painted. Its width is rounded up to a whole
 * pixel, and on the line's left it is set that far left of the line, so no glyph lands on a
 * fraction of a pixel.
 */
function TipCard({ anchor, flip, top, here, children }: Readonly<{ anchor: number; flip: boolean; top: number; here: boolean; children: React.ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.width = "";
    const width = Math.ceil(element.getBoundingClientRect().width);
    element.style.width = `${width}px`;
    element.style.left = `${flip ? Math.max(0, anchor - TIP_GAP - width) : anchor + TIP_GAP}px`;
    element.style.visibility = "visible";
  });
  return (
    <div ref={ref} aria-hidden className="mh-tipcard" data-here={here ? "" : undefined} style={{ top, left: 0, visibility: "hidden" }}>
      {children}
    </div>
  );
}
