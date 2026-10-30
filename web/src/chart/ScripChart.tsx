import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createChart, PaneLegend, type Bar as OaBar, type Chart, type LegendValue, type SeriesApi } from "openalgo-charts";

import { fmt0, fmt2, istDate } from "../core/format";
import { priceAxisWidth, themeFromPage, token } from "./chartTheme";
import { isLineType, type ScripChartType } from "./chartType";
import { ATR_PERIOD, atrPoints } from "./useCandles";
import { INDICATORS, sessionAverage, type IndicatorId } from "./indicators";
import { OiProfileBars, type OiBarLevel } from "./OiProfileBars";
import type { OiProfileData, OiProfileMode } from "./useOiProfile";
import { useChartPixelSnap } from "./useChartPixelSnap";

/** A live trade: its price and the hub's timestamp, ms. */
export interface LiveTick {
  price: number;
  ts: number;
}

/** TradingView's slightly rounded candle bodies, CSS px. */
const BODY_RADIUS = 2;

/** Today's session average (`sessionAverage`), over today's candles with `forming` standing in for
 *  the last one; null when the latest candle is not today's (before the open, a holiday). */
function todayAverage(candles: readonly OaBar[], forming: OaBar | null): number | null {
  const istDay = (t: number) => Math.floor((t + 19_800) / 86_400);
  const today = istDay(Date.now() / 1000);
  const bars = candles.filter((b) => istDay(b.time) === today);
  if (forming && istDay(forming.time) === today) {
    if (bars.length > 0 && bars[bars.length - 1]!.time === forming.time) bars[bars.length - 1] = forming;
    else bars.push(forming);
  }
  if (bars.length === 0) return null;
  return sessionAverage(bars)[bars.length - 1]!;
}

/** The page's chart theme, with the price tag's up/down fill in the candles' own pair. */
function themeFor(colors: { up: string; down: string }) {
  return { ...themeFromPage(), lastPriceUp: colors.up, lastPriceDown: colors.down };
}

/** Halfway between the lowest low and the highest high: where a baseline chart puts its base. */
function midpoint(bars: readonly OaBar[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  return Number.isFinite(lo) ? (lo + hi) / 2 : 0;
}

/** A 6-digit hex colour at `alpha` (0..1); anything else is returned as it is. */
function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/** The NSE cash session, seconds (09:15 to 15:30). */
const SESSION_SECONDS = 22_500;
/** The least candles a fresh view shows, so a coarse interval keeps some history around its day. */
const MIN_VISIBLE = 70;
/** Empty room kept to the right of the session, candles. */
const ROOM = 4;

/**
 * Opens a chart on the current day, whole and unsqueezed: an intraday chart shows the latest
 * session from its first candle across to the close with room for the candles still to come, never
 * the fortnight loaded behind it fitted into the width. A coarse interval, whose session is only a
 * few candles, shows enough of the days before it to read as a chart. A daily chart fits what it has.
 */
function fitLatestSession(chart: Chart, candles: readonly OaBar[], stepSec: number): void {
  const n = candles.length;
  if (n === 0 || stepSec >= 86_400) {
    chart.fitContent();
    return;
  }
  const day = istDate(candles[n - 1]!.time * 1000);
  let first = n - 1;
  while (first > 0 && istDate(candles[first - 1]!.time * 1000) === day) first--;
  const perDay = Math.max(1, Math.round(SESSION_SECONDS / stepSec));
  const to = Math.max(n - 1, first + perDay - 1) + ROOM;
  const from = Math.max(-2, to - Math.max(perDay + ROOM + 2, MIN_VISIBLE));
  chart.setVisibleLogicalRange({ from, to });
}

/**
 * A scrip's candles on openalgo-charts: price on the right axis, the picked indicators over the
 * candles or in panes under them (`indicators.ts`), drawn the way every other chart in the app is
 * (`chartTheme.ts`). Live ticks (`tick`) build the forming candle as TradingView does: each one
 * moves its close, high and low, and the first past the interval opens the next candle, on the
 * same grid as the hub's candles (stepped from the last one, so a 9:15 session keeps its 9:15,
 * 9:20, ...). The price tag counts down to the candle's close. `oiProfile`, when given, hangs
 * call/put OI bars off the price axis (`OiProfileBars`), QuantDesk's way; hovering one shows that
 * strike's figures. `chartType` draws the price as candles, bars, a line or an area (`chartType.ts`);
 * a line or an area reads each candle's close, in one colour.
 */
export function ScripChart({
  candles,
  chartType,
  indicators,
  tick,
  atp,
  stepSec,
  onAtr,
  name,
  colors,
  oiProfile,
  oiMode,
  oiUnit = "oi",
  viewKey,
  themeKey,
}: Readonly<{
  candles: readonly OaBar[];
  chartType: ScripChartType;
  indicators: readonly IndicatorId[];
  /** The latest live trade (never the hub's replay of yesterday's), or null before one arrives. */
  tick: LiveTick | null;
  /** The exchange's average traded price today, from the live quote; null for an index (none). */
  atp: number | null;
  /** The interval, seconds: when the forming candle closes and the next one opens. */
  stepSec: number;
  /** The latest ATR on the candles including the forming one, as it moves with each tick. */
  onAtr?: (value: number | null) => void;
  /** The instrument's name, in a box beside its price tag. */
  name: string;
  colors: { up: string; down: string };
  /** Null hides the profile. */
  oiProfile: OiProfileData | null;
  oiMode: OiProfileMode;
  /** What the bars measure: open interest, or delta x open interest (the tooltip says which). */
  oiUnit?: "oi" | "delta";
  viewKey: string;
  themeKey: string;
}>) {
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const priceRef = useRef<SeriesApi | null>(null);
  /** The indicator lines on the chart now, by indicator. */
  const linesRef = useRef(new Map<IndicatorId, SeriesApi>());
  /** The name label at the top left of each lower pane (ATR 14, RSI 14), with the line's reading. */
  const legendRef = useRef(new Map<IndicatorId, PaneLegend>());
  const readings = useRef(new Map<IndicatorId, { byTime: Map<number, number>; last: number | null }>());
  const hoverAt = useRef<number | null>(null);
  const oiBarsRef = useRef<OiProfileBars | null>(null);
  const shownKey = useRef("");
  /** The candle the next tick lands on: the hub's last one, then whatever ticks have made of it. */
  const forming = useRef<OaBar | null>(null);
  /** The candles on the chart as they are now: the hub's, with the ones the ticks have built on the end. */
  const bars = useRef<OaBar[]>([]);
  const refreshFrame = useRef(0);
  /** The ATP level: a one-point line series, so it takes the name box, value tag and dotted level
   *  every other line on the chart has. */
  const atpRef = useRef<SeriesApi | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; price: number } | null>(null);

  useChartPixelSnap(frame, host);

  const candleStyle = (c: { up: string; down: string }) => ({
    upColor: c.up,
    downColor: c.down,
    borderUpColor: c.up,
    borderDownColor: c.down,
    wickUpColor: c.up,
    wickDownColor: c.down,
  });
  /** The price series' colours for `type`: candles and bars read the up/down pair, a line or an
   *  area the line colour and its fill, a baseline the pair above and below its base. Area and
   *  baseline share the fill keys, so each type sets them its own way. */
  const priceStyle = (type: ScripChartType, c: { up: string; down: string }) => {
    const line = token("--mh-line-fut");
    if (type === "baseline") {
      return {
        ...candleStyle(c),
        // No `color`: the library reads one as "a one-colour series" and paints the price tag in it.
        color: undefined,
        topColor: c.up,
        bottomColor: c.down,
        areaTopColor: withAlpha(c.up, 0.2),
        areaBottomColor: withAlpha(c.down, 0.2),
        baseValue: midpoint(candles),
      };
    }
    return {
      ...candleStyle(c),
      // A line's tag is in the line's colour; candles and bars leave `color` unset, so their tag
      // turns green or red with the candle, as TradingView's does.
      color: isLineType(type) ? line : undefined,
      closeColor: line,
      areaTopColor: withAlpha(line, 0.28),
      areaBottomColor: withAlpha(line, 0),
    };
  };
  const lineColor = (color: string) => (color === "trend" ? colors.up : token(color));

  /* -- the chart, once ------------------------------------------------------------------------- */
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const chart = createChart(element, {
      timezone: "Asia/Kolkata",
      theme: themeFor(colors),
      priceAxisWidth: priceAxisWidth(),
      crosshairSnapToBar: true,
      branding: false,
      navigation: { mousePan: "both" },
      axisChrome: { barCountdown: true },
    });
    chartRef.current = chart;
    priceRef.current = chart.addSeries(chartType, {
      paneIndex: 0,
      priceScaleId: "right",
      priceFormat: { type: "custom", formatter: fmt2 },
      style: {
        ...priceStyle(chartType, colors),
        bodyRadius: BODY_RADIUS,
        title: name,
        lastValueVisible: true,
        priceLineVisible: true,
      },
    });
    oiBarsRef.current = new OiProfileBars({ levels: [], mode: oiMode, callColor: colors.up, putColor: colors.down });
    chart.addPrimitive(oiBarsRef.current, 0);
    // The OI tooltip: only while the pointer is over a strike's bars on the price pane.
    const unsubscribe = chart.subscribeCrosshairMove((e) => {
      hoverAt.current = e.time ?? null;
      showLegends();
      const level = e.point && e.paneIndex === 0 && !e.pressed ? oiBarsRef.current?.levelAt(e.point.x, e.point.y) ?? null : null;
      // The strike, not a copy of its figures: the tooltip reads them fresh as the profile updates.
      setTip(level && e.point ? { x: e.point.x, y: e.point.y, price: level.price } : null);
    });
    if (import.meta.env.DEV) (window as unknown as { __mhScripChart?: Chart }).__mhScripChart = chart;
    const lines = linesRef.current;
    return () => {
      unsubscribe();
      chart.destroy();
      chartRef.current = null;
      priceRef.current = null;
      lines.clear();
      legendRef.current.clear();
      readings.current.clear();
      atpRef.current = null;
      oiBarsRef.current = null;
      shownKey.current = "";
      forming.current = null;
      bars.current = [];
      cancelAnimationFrame(refreshFrame.current);
      refreshFrame.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Folds `t` into the forming candle, or opens the next one once its interval is over. */
  const apply = (t: LiveTick) => {
    const price = priceRef.current;
    const last = forming.current;
    if (!price || !last) return;
    const at = t.ts / 1000;
    if (at < last.time) return; // older than the hub's own last candle: already in it
    let next: OaBar;
    if (at < last.time + stepSec) {
      next = { ...last, high: Math.max(last.high, t.price), low: Math.min(last.low, t.price), close: t.price };
    } else {
      const time = last.time + Math.floor((at - last.time) / stepSec) * stepSec;
      next = { time, open: t.price, high: t.price, low: t.price, close: t.price };
    }
    price.update(next);
    forming.current = next;
    const held = bars.current;
    if (held.length > 0 && held[held.length - 1]!.time === next.time) held[held.length - 1] = next;
    else held.push(next);
    scheduleRefresh();
  };

  /**
   * The lines that follow from the candles (VWAP, the averages, Supertrend, ATR, RSI) and the ATR
   * read-out move with the forming candle: their last points are worked out again from the candles
   * as they are now, once a frame however many ticks arrive.
   */
  /** The pane legends' readings: the minute under the crosshair, else the latest. */
  const showLegends = () => {
    for (const [id, legend] of legendRef.current) {
      const def = INDICATORS.find((d) => d.id === id)!;
      const held = readings.current.get(id);
      const at = hoverAt.current;
      const value = at !== null ? held?.byTime.get(at) ?? held?.last ?? null : held?.last ?? null;
      const values: LegendValue[] = [{ text: value !== null && value !== undefined ? fmt2(value) : "—", color: lineColor(def.color) }];
      legend.setOptions({ color: lineColor(def.color) });
      legend.setValues(values);
    }
  };
  /** Takes in points (all of them, or the last few that moved) as the legend's readings. */
  const takeReadings = (id: IndicatorId, points: readonly { time: number; value?: number }[]) => {
    if (!legendRef.current.has(id)) return;
    const held = readings.current.get(id) ?? { byTime: new Map<number, number>(), last: null };
    for (const p of points) {
      if (typeof p.value === "number" && Number.isFinite(p.value)) {
        held.byTime.set(p.time, p.value);
        held.last = p.value;
      }
    }
    readings.current.set(id, held);
  };

  const refreshLive = () => {
    const held = bars.current;
    if (held.length === 0) return;
    for (const [id, series] of linesRef.current) {
      const def = INDICATORS.find((d) => d.id === id)!;
      const tail = def.points(held, colors).slice(-2);
      for (const point of tail) series.update(point);
      takeReadings(id, tail);
    }
    showLegends();
    if (onAtr) {
      const last = atrPoints(held, ATR_PERIOD).at(-1);
      onAtr(last && "value" in last ? last.value : null);
    }
  };
  const scheduleRefresh = () => {
    if (refreshFrame.current) return;
    refreshFrame.current = requestAnimationFrame(() => {
      refreshFrame.current = 0;
      refreshLive();
    });
  };

  /** Every indicator line's points from the candles on the chart. */
  const fillLines = () => {
    for (const [id, series] of linesRef.current) {
      const def = INDICATORS.find((d) => d.id === id)!;
      const points = def.points(bars.current.length > 0 ? bars.current : candles, colors);
      series.setData(points);
      readings.current.delete(id);
      takeReadings(id, points);
    }
    showLegends();
  };

  /* -- indicators: the picked lines, overlays on the candles and each oscillator in its own pane - */
  const indicatorKey = indicators.join(",");
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Rebuilt whole: an oscillator's pane goes with it, and the panes under it move up a slot.
    for (const series of linesRef.current.values()) series.remove();
    linesRef.current.clear();
    legendRef.current.clear();
    readings.current.clear();
    for (let i = chart.panes().length - 1; i >= 1; i--) chart.removePane(i, { force: true });
    for (const def of INDICATORS) {
      // A level (ATP) is a price line, drawn by its own effect below.
      if (!indicators.includes(def.id) || def.place === "level") continue;
      const paneIndex = def.place === "overlay" ? 0 : chart.panes().length;
      const series = chart.addSeries("line", {
        paneIndex,
        priceScaleId: "right",
        priceFormat: { type: "custom", formatter: fmt2 },
        style: {
          color: lineColor(def.color),
          lineWidth: def.place === "overlay" ? 1 : 2,
          title: def.name,
          sessionBreaks: def.id === "avg",
          priceLineVisible: false,
          // Every line's value on the axis, in its colour with its name beside it, TradingView's way.
          lastValueVisible: true,
        },
      });
      if (paneIndex > 0) {
        chart.setPaneWeight(paneIndex, 1);
        // The pane says what it is: the indicator's name at its top left, with its reading.
        const legend = new PaneLegend({ id: def.id, title: def.name, color: lineColor(def.color), row: 0, font: 12 });
        chart.addPrimitive(legend, paneIndex);
        legendRef.current.set(def.id, legend);
      }
      linesRef.current.set(def.id, series);
    }
    chart.setPaneWeight(0, 3);
    fillLines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorKey]);

  /* -- data: the hub's candles, then the latest tick on top of them ----------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    if (!chart || !price) return;
    price.setData(candles);
    if (chartType === "baseline") price.applyOptions({ baseValue: midpoint(candles) });
    bars.current = [...candles];
    fillLines();
    forming.current = candles[candles.length - 1] ?? null;
    if (tick) apply(tick);
    if (shownKey.current !== viewKey) fitLatestSession(chart, candles, stepSec);
    shownKey.current = viewKey;
    // `tick` is applied here only to catch up a reload; its own effect follows it from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, viewKey]);

  /* -- live: every tick moves the forming candle ------------------------------------------------ */
  useEffect(() => {
    if (tick) apply(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  /* -- ATP: today's average traded price as a level across the chart, with its name box ("ATP")
   *    and value tag on the axis like every other line. The exchange's figure when the quote
   *    carries one; an index has none, so on an intraday chart it falls back to today's session
   *    average from the candles (the forming one included), named "Avg" so the two are never
   *    confused. A daily chart has no session to average. ---------------------------------------- */
  const showAtp = indicators.includes("atp");
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let price = showAtp ? atp : null;
    let name = "ATP";
    if (showAtp && price === null && stepSec < 86_400) {
      price = todayAverage(bars.current.length > 0 ? bars.current : candles, null);
      name = "Avg";
    }
    const at = forming.current?.time ?? candles[candles.length - 1]?.time;
    if (price === null || at === undefined) {
      atpRef.current?.remove();
      atpRef.current = null;
      return;
    }
    const color = token("--mh-amber");
    if (!atpRef.current) {
      atpRef.current = chart.addSeries("line", {
        paneIndex: 0,
        priceScaleId: "right",
        priceFormat: { type: "custom", formatter: fmt2 },
        style: { color, lineWidth: 1, title: name, lastValueVisible: true, priceLineVisible: true },
      });
    } else {
      atpRef.current.applyOptions({ color, title: name });
    }
    // One point at the latest candle: the tag and the dotted level carry it, no line to draw.
    atpRef.current.setData([{ time: at, value: price }]);
    // `tick` moves the forming candle, and with it the fallback average.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAtp, atp, candles, tick, stepSec, themeKey]);

  /* -- the chart type: the same series, drawn another way ------------------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    if (!chart || !price) return;
    chart.setSeriesType(price, chartType);
    price.applyOptions(priceStyle(chartType, colors));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType]);

  /* -- the price tag's name follows the instrument ---------------------------------------------- */
  useEffect(() => {
    priceRef.current?.applyOptions({ title: name });
  }, [name]);

  /* -- the OI profile: call/put bars hung off the price axis ------------------------------------ */
  useEffect(() => {
    const levels: OiBarLevel[] = oiProfile
      ? oiProfile.strikes.map((price, i) => ({
          price,
          call: oiProfile.call[i]!,
          put: oiProfile.put[i]!,
          callChange: oiProfile.callChange[i]!,
          putChange: oiProfile.putChange[i]!,
        }))
      : [];
    oiBarsRef.current?.setOptions({ levels, mode: oiMode, unit: oiUnit });
    if (levels.length === 0) setTip(null);
  }, [oiProfile, oiMode, oiUnit]);

  /* -- the palette: the chart's ground and grid follow the page, the candles their preset ------- */
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.setTheme(themeFor(colors));
      priceRef.current?.applyOptions(priceStyle(chartType, colors));
      for (const [id, series] of linesRef.current) series.applyOptions({ color: lineColor(INDICATORS.find((d) => d.id === id)!.color) });
      // Supertrend's points carry the up/down colours themselves.
      if (linesRef.current.has("supertrend")) fillLines();
      oiBarsRef.current?.setOptions({ callColor: colors.up, putColor: colors.down });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey, colors.up, colors.down]);

  // The hovered strike's figures as they are now, so a still pointer sees them move.
  const tipLevel = useMemo<OiBarLevel | null>(() => {
    if (!tip || !oiProfile) return null;
    const i = oiProfile.strikes.indexOf(tip.price);
    return i < 0 ? null : { price: tip.price, call: oiProfile.call[i]!, put: oiProfile.put[i]!, callChange: oiProfile.callChange[i]!, putChange: oiProfile.putChange[i]! };
  }, [tip, oiProfile]);

  return (
    <div className="oa-chart-frame" ref={frame}>
      <div ref={host} className="oa-chart" aria-label="Price chart with indicators" />
      {tipLevel && tip ? <OiTip x={tip.x} y={tip.y} level={tipLevel} colors={colors} unit={oiUnit} mode={oiMode} /> : null}
    </div>
  );
}

const signed = (v: number) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt0(Math.abs(v))}` : "—");
const whole = (v: number) => (Number.isFinite(v) ? fmt0(v) : "—");

/** Indian short scale, as a desk reads it: 1.42 Cr, 44.1 L, 8.2 K. */
function compact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return `${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${(a / 1e3).toFixed(1)} K`;
  return fmt0(a);
}
const compactSigned = (v: number) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${compact(v)}` : "—");

/** An arrow and a move: green ▲ while it is being added, red ▼ while it is shed, nothing when flat. */
function Move({ v, text }: Readonly<{ v: number; text: string }>) {
  if (!Number.isFinite(v) || v === 0) return <span className="mh-oi-flat">—</span>;
  return (
    <span className={v > 0 ? "mh-up" : "mh-down"}>
      {v > 0 ? "▲" : "▼"} {text}
    </span>
  );
}

/**
 * One strike beside the pointer, read live: call and put, each with its move, and under them what
 * the two make of it. Open interest: the total and the put/call ratio. Delta x OI: the net
 * exposure (calls less puts), long or short.
 */
function OiTip({ x, y, level, colors, unit, mode }: Readonly<{ x: number; y: number; level: OiBarLevel; colors: { up: string; down: string }; unit: "oi" | "delta"; mode: OiProfileMode }>) {
  const delta = unit === "delta";
  const fmt = delta ? compact : whole;
  const fmtMove = delta ? compactSigned : signed;
  const showMove = mode !== "oi";
  const box = useRef<HTMLDivElement>(null);
  // Kept whole inside the chart: near the top or bottom edge the box slides in rather than being cut.
  useLayoutEffect(() => {
    const el = box.current;
    const frame = el?.parentElement;
    if (!el || !frame) return;
    const half = el.offsetHeight / 2;
    el.style.top = `${Math.min(Math.max(y, half + 4), Math.max(half + 4, frame.clientHeight - half - 4))}px`;
  });
  const net = level.call - level.put;
  const pcr = level.call > 0 ? level.put / level.call : Number.NaN;
  return (
    // Left of the pointer: the bars hang off the right axis, so there is always room that side.
    <div ref={box} className="mh-oi-tip" style={{ right: `calc(100% - ${x - 12}px)`, top: y }} role="tooltip">
      <div className="mh-oi-tip-head">
        {fmt2(level.price)}
        <span>{delta ? "Delta × OI" : "Open interest"}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>{delta ? "Δ×OI" : "OI"}</th>
            {showMove ? <th>{delta ? "vs 2 min" : "Today"}</th> : null}
          </tr>
        </thead>
        <tbody>
          <tr style={{ color: colors.up }}>
            <th>Call</th>
            <td>{fmt(level.call)}</td>
            {showMove ? (
              <td>
                <Move v={level.callChange} text={fmtMove(level.callChange)} />
              </td>
            ) : null}
          </tr>
          <tr style={{ color: colors.down }}>
            <th>Put</th>
            <td>{fmt(level.put)}</td>
            {showMove ? (
              <td>
                <Move v={level.putChange} text={fmtMove(level.putChange)} />
              </td>
            ) : null}
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th>{delta ? "Net" : "PCR"}</th>
            <td className={delta && Number.isFinite(net) ? (net > 0 ? "mh-up" : net < 0 ? "mh-down" : "") : ""}>
              {delta ? (Number.isFinite(net) ? `${net > 0 ? "Long " : net < 0 ? "Short " : ""}${compact(net)}` : "—") : Number.isFinite(pcr) ? pcr.toFixed(2) : "—"}
            </td>
            {showMove ? <td /> : null}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
