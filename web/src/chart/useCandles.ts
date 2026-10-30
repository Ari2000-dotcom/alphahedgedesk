import { useEffect, useState } from "react";
import { atr, type Bar as OaBar, type LinePoint, type Whitespace } from "openalgo-charts";

import { istDate } from "../core/format";

/**
 * The intervals a scrip chart offers, TradingView's set as far as the hub's `/history` reaches:
 * every interval it serves, and 2h and 4h built from its hourly candles. Each asks for enough
 * calendar days to warm up a 14-period ATR with room to spare and to stay under the hub's
 * 92-day-per-request cap; the hourly ones share one request.
 */
export interface CandleInterval {
  /** Ours, and what a saved panel remembers. */
  value: string;
  /** Short, for the toolbar: `5m`, `1h`, `1D`. */
  label: string;
  /** Long, for the menu: `5 minutes`. */
  name: string;
  group: "Minutes" | "Hours" | "Days";
  /** The hub's interval the candles are asked in. */
  source: string;
  /** How many of the source's candles make one of these, counted from each session's first. */
  merge: number;
  days: number;
  /** One candle, seconds: when a live candle closes and the next opens. */
  seconds: number;
}

export const CANDLE_INTERVALS: readonly CandleInterval[] = [
  { value: "1m", label: "1m", name: "1 minute", group: "Minutes", source: "1m", merge: 1, days: 5, seconds: 60 },
  { value: "3m", label: "3m", name: "3 minutes", group: "Minutes", source: "3m", merge: 1, days: 10, seconds: 180 },
  { value: "5m", label: "5m", name: "5 minutes", group: "Minutes", source: "5m", merge: 1, days: 15, seconds: 300 },
  { value: "15m", label: "15m", name: "15 minutes", group: "Minutes", source: "15m", merge: 1, days: 30, seconds: 900 },
  { value: "30m", label: "30m", name: "30 minutes", group: "Minutes", source: "30m", merge: 1, days: 45, seconds: 1800 },
  { value: "60m", label: "1h", name: "1 hour", group: "Hours", source: "60m", merge: 1, days: 60, seconds: 3600 },
  { value: "2h", label: "2h", name: "2 hours", group: "Hours", source: "60m", merge: 2, days: 60, seconds: 7200 },
  { value: "4h", label: "4h", name: "4 hours", group: "Hours", source: "60m", merge: 4, days: 60, seconds: 14_400 },
  { value: "1d", label: "1D", name: "1 day", group: "Days", source: "1d", merge: 1, days: 90, seconds: 86_400 },
];

/**
 * `merge` source candles to one, counted afresh from each IST session's first candle, as
 * TradingView aligns its intraday bars to the session open: NSE's 2h bars open at 09:15, 11:15,
 * 13:15 and 15:15, its 4h bars at 09:15 and 13:15.
 */
export function mergeCandles(candles: readonly OaBar[], merge: number): OaBar[] {
  if (merge <= 1) return [...candles];
  const out: OaBar[] = [];
  let day = "";
  let inDay = 0;
  for (const c of candles) {
    const d = istDate(c.time * 1000);
    if (d !== day) {
      day = d;
      inDay = 0;
    }
    const last = out[out.length - 1];
    if (inDay % merge === 0 || !last) {
      out.push({ ...c });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      if (c.volume !== undefined) last.volume = (last.volume ?? 0) + c.volume;
    }
    inDay++;
  }
  return out;
}

export const ATR_PERIOD = 14;

const DAY_MS = 86_400_000;

/** The hub turned the request away for the visitor's per-minute history allowance (HTTP 429). */
class Throttled extends Error {}

async function fetchCandles(id: string, interval: string, days: number): Promise<OaBar[]> {
  const to = istDate(Date.now());
  const from = istDate(Date.now() - days * DAY_MS);
  const q = new URLSearchParams({ id, interval, from, to });
  const res = await fetch(`/history?${q}`);
  if (res.status === 429) throw new Throttled((await res.text()) || "history allowance used up");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { pieces: { candles?: number[][] }[] };
  const out: OaBar[] = [];
  for (const piece of body.pieces) {
    for (const c of piece.candles ?? []) {
      // A candle is [time (s), open, high, low, close, volume].
      out.push({ time: c[0]!, open: c[1]!, high: c[2]!, low: c[3]!, close: c[4]!, volume: c[5] });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Answers kept a couple of minutes, by request and day: switching back to an interval or opening
 * the same chart again draws at once, and two panels asking together share one request.
 */
const KEEP_MS = 2 * 60_000;
const answers = new Map<string, { at: number; candles: Promise<OaBar[]> }>();

function candlesFor(id: string, interval: string, days: number): Promise<OaBar[]> {
  const key = `${id}|${interval}|${days}|${istDate(Date.now())}`;
  const kept = answers.get(key);
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.candles;
  const candles = fetchCandles(id, interval, days);
  answers.set(key, { at: Date.now(), candles });
  candles.catch(() => answers.delete(key));
  return candles;
}

/** Waits before asking again after the hub's 429: its allowance refills within seconds. */
const RETRY_MS = [2_000, 5_000, 10_000, 20_000];

export interface CandleState {
  candles: OaBar[];
  /**
   * `id|interval` of the candles held. While a new interval loads, the old one's candles stay on
   * screen and this still names them, so the chart fits the new candles when they arrive instead
   * of fitting the old ones under the new interval's name.
   */
  forKey: string;
  loading: boolean;
  error: string | null;
  /** Said while a request waits on the hub's history allowance, so a slow load is not silent. */
  note: string | null;
}

/**
 * `id`'s candles in `spec`'s interval, asked again whenever the instrument or interval changes
 * (2h and 4h are the hourly answer merged, `mergeCandles`). A new interval of the same instrument
 * keeps the candles on screen until its own arrive, so the chart is not torn down and rebuilt on
 * every switch; a 429 from the hub waits and asks again rather than failing the chart.
 */
export function useCandles(id: string, spec: CandleInterval): CandleState {
  const { value: interval, source, merge, days } = spec;
  const [state, setState] = useState<CandleState>({ candles: [], forKey: "", loading: false, error: null, note: null });
  const [shownId, setShownId] = useState(id);
  useEffect(() => {
    if (!id) {
      setState({ candles: [], forKey: "", loading: false, error: null, note: null });
      return;
    }
    let cancelled = false;
    let timer = 0;
    const sameInstrument = id === shownId;
    setShownId(id);
    setState((was) => (sameInstrument ? { ...was, loading: true, error: null, note: null } : { candles: [], forKey: "", loading: true, error: null, note: null }));
    const ask = (attempt: number) => {
      candlesFor(id, source, days)
        .then((candles) => {
          if (!cancelled) setState({ candles: mergeCandles(candles, merge), forKey: `${id}|${interval}`, loading: false, error: null, note: null });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (e instanceof Throttled && attempt < RETRY_MS.length) {
            setState((was) => ({ ...was, note: "Waiting for the hub's history allowance" }));
            timer = window.setTimeout(() => ask(attempt + 1), RETRY_MS[attempt]);
            return;
          }
          setState((was) => ({ ...was, loading: false, note: null, error: e instanceof Error ? e.message : "couldn't load candles" }));
        });
    };
    ask(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `shownId` is read, not watched: it only tells a new instrument from a new interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, interval]);
  return state;
}

/** Wilder's ATR as chart points: a gap (`Whitespace`) until the warm-up period has passed. */
export function atrPoints(candles: readonly OaBar[], period: number): (LinePoint | Whitespace)[] {
  if (candles.length === 0) return [];
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const values = atr(high, low, close, period);
  return candles.map((c, i) => (Number.isFinite(values[i]) ? { time: c.time, value: values[i]! } : { time: c.time }));
}
