import { useEffect, useRef } from "react";
import { createChart, type Bar as OaBar, type Chart, type LinePoint, type PriceLine, type SeriesApi, type Whitespace } from "openalgo-charts";

import { fmt2 } from "../core/format";
import { priceAxisWidth, themeFromPage, token } from "./chartTheme";
import { OiProfileBars, type OiBarLevel } from "./OiProfileBars";
import type { OiProfileData, OiProfileMode } from "./useOiProfile";
import { useChartPixelSnap } from "./useChartPixelSnap";

/**
 * A scrip's candles on openalgo-charts: price on the right axis, Wilder's ATR underneath on its
 * own pane, drawn the way every other chart in the app is (`chartTheme.ts`). Historical only —
 * no live tick aggregation into a forming candle yet, so a tab left open does not grow one — but
 * `live` still marks the real current price on the axis with its own dashed line, since the
 * latest CLOSED candle (the series' own last-value tag) can be well behind it. `oiProfile`, when
 * given, hangs call/put OI bars off the price axis (`OiProfileBars`), QuantDesk's way.
 */
export function ScripChart({
  candles,
  atr,
  period,
  live,
  prevClose,
  oiProfile,
  oiMode,
  viewKey,
  themeKey,
}: Readonly<{
  candles: readonly OaBar[];
  atr: readonly (LinePoint | Whitespace)[];
  period: number;
  /** The real current price (today's last trade), independent of the chart's own interval. */
  live: number | null;
  /** Yesterday's close: which way `live` has moved, for its line's colour. */
  prevClose: number | null;
  oiProfile: OiProfileData | null;
  oiMode: OiProfileMode;
  viewKey: string;
  themeKey: string;
}>) {
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const priceRef = useRef<SeriesApi | null>(null);
  const atrRef = useRef<SeriesApi | null>(null);
  const liveLineRef = useRef<PriceLine | null>(null);
  const oiBarsRef = useRef<OiProfileBars | null>(null);
  const shownKey = useRef("");

  useChartPixelSnap(frame, host);

  /* -- the chart, once ------------------------------------------------------------------------- */
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const chart = createChart(element, {
      timezone: "Asia/Kolkata",
      theme: themeFromPage(),
      priceAxisWidth: priceAxisWidth(),
      crosshairSnapToBar: true,
      branding: false,
      navigation: { mousePan: "both" },
      // A panel that grows or shrinks keeps the same candles in view (the fork's option).
      timeScale: { lockVisibleTimeRangeOnResize: true },
    });
    chartRef.current = chart;
    priceRef.current = chart.addSeries("candlestick", {
      paneIndex: 0,
      priceScaleId: "right",
      priceFormat: { type: "custom", formatter: fmt2 },
      style: {
        upColor: token("--mh-up"),
        downColor: token("--mh-down"),
        borderUpColor: token("--mh-up"),
        borderDownColor: token("--mh-down"),
        wickUpColor: token("--mh-up"),
        wickDownColor: token("--mh-down"),
        lastValueVisible: true,
        priceLineVisible: true,
      },
    });
    atrRef.current = chart.addSeries("line", {
      paneIndex: 1,
      priceScaleId: "right",
      priceFormat: { type: "custom", formatter: fmt2 },
      style: {
        color: token("--mh-line-vix"),
        lineWidth: 2,
        title: `ATR ${period}`,
        priceLineVisible: false,
        lastValueVisible: true,
      },
    });
    chart.setPaneWeight(0, 3);
    chart.setPaneWeight(1, 1);
    oiBarsRef.current = new OiProfileBars({ levels: [], mode: "oi", callColor: token("--mh-up"), putColor: token("--mh-down") });
    chart.addPrimitive(oiBarsRef.current, 0);
    if (import.meta.env.DEV) (window as unknown as { __mhScripChart?: Chart }).__mhScripChart = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
      priceRef.current = null;
      atrRef.current = null;
      liveLineRef.current = null;
      oiBarsRef.current = null;
      shownKey.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -- data: a new picture every time (no live aggregation yet) ------------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    const atrSeries = atrRef.current;
    if (!chart || !price || !atrSeries) return;
    price.setData(candles);
    atrSeries.setData(atr);
    if (shownKey.current !== viewKey) chart.fitContent();
    shownKey.current = viewKey;
  }, [candles, atr, viewKey]);

  /* -- the ATR pane's title follows a changed period --------------------------------------------- */
  useEffect(() => {
    atrRef.current?.applyOptions({ title: `ATR ${period}` });
  }, [period]);

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
    oiBarsRef.current?.setOptions({ levels, mode: oiMode });
  }, [oiProfile, oiMode]);

  /* -- the live price on the axis: its own dashed line, since the candle series' last-value tag
   *    only ever shows the latest CLOSED candle, which can sit minutes or a whole day behind. ---- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (live === null) {
      if (liveLineRef.current) {
        chart.removePrimitive(liveLineRef.current);
        liveLineRef.current = null;
      }
      return;
    }
    const up = prevClose === null || live >= prevClose;
    const color = token(up ? "--mh-up" : "--mh-down");
    const label = `${fmt2(live)}  LTP`;
    if (!liveLineRef.current) {
      liveLineRef.current = chart.addPriceLine({ id: "live", price: live, color, label, lineWidth: 1, dashed: true }, 0);
    } else {
      liveLineRef.current.setPrice(live);
      liveLineRef.current.setOptions({ color, label });
    }
  }, [live, prevClose, themeKey]);

  /* -- the palette: the chart's ground, grid and series colours follow it ----------------------- */
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.setTheme(themeFromPage());
      priceRef.current?.applyOptions({
        upColor: token("--mh-up"),
        downColor: token("--mh-down"),
        borderUpColor: token("--mh-up"),
        borderDownColor: token("--mh-down"),
        wickUpColor: token("--mh-up"),
        wickDownColor: token("--mh-down"),
      });
      atrRef.current?.applyOptions({ color: token("--mh-line-vix") });
      oiBarsRef.current?.setOptions({ callColor: token("--mh-up"), putColor: token("--mh-down") });
    });
    return () => cancelAnimationFrame(raf);
  }, [themeKey]);

  return (
    <div className="oa-chart-frame" ref={frame}>
      <div ref={host} className="oa-chart" aria-label="Candlestick chart with an ATR indicator pane" />
    </div>
  );
}
