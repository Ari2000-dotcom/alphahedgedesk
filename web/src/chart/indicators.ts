import { useState } from "react";
import { atr, ema, rsi, supertrend, type Bar as OaBar, type LinePoint, type Whitespace } from "openalgo-charts";

/**
 * The scrip chart's indicators, TradingView's way: picked from one menu, drawn over the candles
 * (an overlay) or in a pane of their own under them (an oscillator). The pick is kept on this
 * computer.
 */
export type IndicatorId = "atp" | "avg" | "ema20" | "ema50" | "supertrend" | "atr" | "rsi";

export interface IndicatorDef {
  id: IndicatorId;
  name: string;
  /** A word beside the name in the menu (its source, or "Pane" for one under the candles); empty for none. */
  note: string;
  /** On the candles, in its own pane under them, or one price level across the chart (drawn by
   *  `ScripChart` from the live quote, not from `points`). */
  place: "overlay" | "pane" | "level";
  /** A palette token, or `"trend"` for Supertrend's up/down colouring. */
  color: string;
  /** The line's points; `up`/`down` colour a trend-following line. */
  points: (bars: readonly OaBar[], colors: { up: string; down: string }) => (LinePoint | Whitespace)[];
}

const ATR_PERIOD = 14;
const RSI_PERIOD = 14;

/** Values as chart points: a gap (`Whitespace`) wherever a value is not ready (warm-up). */
function asPoints(bars: readonly OaBar[], values: readonly number[]): (LinePoint | Whitespace)[] {
  return bars.map((b, i) => (Number.isFinite(values[i]) ? { time: b.time, value: values[i]! } : { time: b.time }));
}

/** The IST calendar day of a candle (UTC seconds), the session an average restarts on. */
const istDay = (t: number) => Math.floor((t + 19_800) / 86_400);

/**
 * The session's average price: from each day's first candle, the running average of every candle's
 * typical price ((high + low + close) / 3), weighted by volume where the candles carry it — VWAP
 * on a future or a share, the plain running average on an index (which trades no volume of its
 * own). On a daily chart each candle is its own session, so it reads the candle's typical price.
 */
export function sessionAverage(bars: readonly OaBar[]): number[] {
  const out: number[] = [];
  let day = Number.NaN;
  let sum = 0;
  let weight = 0;
  for (const b of bars) {
    const d = istDay(b.time);
    if (d !== day) {
      day = d;
      sum = 0;
      weight = 0;
    }
    const w = b.volume && b.volume > 0 ? b.volume : 1;
    sum += ((b.high + b.low + b.close) / 3) * w;
    weight += w;
    out.push(sum / weight);
  }
  return out;
}

export const INDICATORS: readonly IndicatorDef[] = [
  {
    id: "atp",
    name: "ATP",
    note: "Avg traded price",
    place: "level",
    color: "--mh-amber",
    points: () => [],
  },
  {
    id: "avg",
    name: "Avg price",
    note: "VWAP",
    place: "overlay",
    color: "--mh-line-vwap",
    points: (bars) => asPoints(bars, sessionAverage(bars)),
  },
  {
    id: "ema20",
    name: "EMA 20",
    note: "",
    place: "overlay",
    color: "--mh-line-fut",
    points: (bars) => asPoints(bars, ema(bars.map((b) => b.close), 20)),
  },
  {
    id: "ema50",
    name: "EMA 50",
    note: "",
    place: "overlay",
    color: "--mh-line-iv",
    points: (bars) => asPoints(bars, ema(bars.map((b) => b.close), 50)),
  },
  {
    id: "supertrend",
    name: "Supertrend",
    note: "10, 3",
    place: "overlay",
    color: "trend",
    points: (bars, colors) =>
      supertrend(bars, 10, 3).map((p, i) =>
        Number.isFinite(p.value) ? { time: bars[i]!.time, value: p.value, color: p.direction < 0 ? colors.up : colors.down } : { time: bars[i]!.time },
      ),
  },
  {
    id: "atr",
    name: `ATR ${ATR_PERIOD}`,
    note: "Pane",
    place: "pane",
    color: "--mh-line-vix",
    points: (bars) =>
      asPoints(
        bars,
        atr(
          bars.map((b) => b.high),
          bars.map((b) => b.low),
          bars.map((b) => b.close),
          ATR_PERIOD,
        ),
      ),
  },
  {
    id: "rsi",
    name: `RSI ${RSI_PERIOD}`,
    note: "Pane",
    place: "pane",
    color: "--mh-line-straddle",
    points: (bars) => asPoints(bars, rsi(bars.map((b) => b.close), RSI_PERIOD)),
  },
];

const KEY = "mh.scrip.indicators";
/** Every indicator this computer has been offered, so one added since comes on by default once. */
const SEEN_KEY = "mh.scrip.indicators.seen";
const DEFAULT: readonly IndicatorId[] = ["atp", "avg", "atr"];
/** What the menu offered before `SEEN_KEY` was kept: a pick saved then has seen these and no more. */
const FIRST_OFFERED: readonly IndicatorId[] = ["avg", "ema20", "ema50", "supertrend", "atr", "rsi"];

function readIndicators(): IndicatorId[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [...DEFAULT];
    const ids = JSON.parse(raw) as unknown;
    if (!Array.isArray(ids)) return [...DEFAULT];
    const seenRaw = localStorage.getItem(SEEN_KEY);
    const seen = seenRaw === null ? FIRST_OFFERED : (JSON.parse(seenRaw) as IndicatorId[]);
    // A default added since this pick was saved comes on; one the viewer has seen and turned off stays off.
    const added = DEFAULT.filter((id) => !seen.includes(id));
    localStorage.setItem(SEEN_KEY, JSON.stringify(INDICATORS.map((d) => d.id)));
    return INDICATORS.map((d) => d.id).filter((id) => ids.includes(id) || added.includes(id));
  } catch {
    return [...DEFAULT];
  }
}

/** The indicators switched on, in the menu's order. */
export function useIndicators(): [IndicatorId[], (ids: IndicatorId[]) => void] {
  const [ids, setIds] = useState<IndicatorId[]>(readIndicators);
  const set = (next: IndicatorId[]) => {
    const ordered = INDICATORS.map((d) => d.id).filter((id) => next.includes(id));
    setIds(ordered);
    try {
      localStorage.setItem(KEY, JSON.stringify(ordered));
      localStorage.setItem(SEEN_KEY, JSON.stringify(INDICATORS.map((d) => d.id)));
    } catch {
      // A per-viewer convenience only.
    }
  };
  return [ids, set];
}
