import { useState } from "react";

/**
 * How the scrip chart draws its price, TradingView's chart-type menu and in its order: the bar
 * family reads a candle's open, high, low and close; the line family its close alone, in one
 * colour. (Columns are left out: the library draws them from zero as a non-price series, which
 * would flatten the price scale and leave the pane without its price.) `group` starts a new run
 * in the menu (a thin rule above it). The pick is kept on this computer.
 */
export type ScripChartType =
  | "bar"
  | "candlestick"
  | "hollow-candle"
  | "line"
  | "line-markers"
  | "step"
  | "area"
  | "hlc-area"
  | "baseline"
  | "high-low";

export const CHART_TYPES: readonly { id: ScripChartType; name: string; group?: true }[] = [
  { id: "bar", name: "Bars" },
  { id: "candlestick", name: "Candles" },
  { id: "hollow-candle", name: "Hollow candles" },
  { id: "line", name: "Line", group: true },
  { id: "line-markers", name: "Line with markers" },
  { id: "step", name: "Step line" },
  { id: "area", name: "Area", group: true },
  { id: "hlc-area", name: "HLC area" },
  { id: "baseline", name: "Baseline" },
  { id: "high-low", name: "High-low", group: true },
];

/** Drawn in one colour rather than up/down: the candle colour picker means nothing to these. */
export const isLineType = (t: ScripChartType) => t === "line" || t === "line-markers" || t === "step" || t === "area" || t === "hlc-area";

const KEY = "mh.scrip.chartType";

function readChartType(): ScripChartType {
  try {
    const v = localStorage.getItem(KEY);
    return CHART_TYPES.some((t) => t.id === v) ? (v as ScripChartType) : "candlestick";
  } catch {
    return "candlestick";
  }
}

export function useChartType(): [ScripChartType, (t: ScripChartType) => void] {
  const [type, setType] = useState<ScripChartType>(readChartType);
  const set = (next: ScripChartType) => {
    setType(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A per-viewer convenience only.
    }
  };
  return [type, set];
}
