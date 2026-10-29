import { useEffect, useState } from "react";
import { atr, type Bar as OaBar, type LinePoint, type Whitespace } from "openalgo-charts";

import { istDate } from "../core/format";

/**
 * The hub's `/history` intervals a scrip chart offers, and how many calendar days back each asks
 * for — short enough to stay under the hub's 92-day-per-request cap, long enough to warm up a
 * 14-period ATR with room to spare.
 */
export interface CandleInterval {
  value: string;
  label: string;
  days: number;
  /** One candle, seconds: when a live candle closes and the next opens. */
  seconds: number;
}

export const CANDLE_INTERVALS: readonly CandleInterval[] = [
  { value: "5m", label: "5m", days: 15, seconds: 300 },
  { value: "15m", label: "15m", days: 30, seconds: 900 },
  { value: "60m", label: "1h", days: 60, seconds: 3600 },
  { value: "1d", label: "1D", days: 90, seconds: 86_400 },
];

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
  loading: boolean;
  error: string | null;
  /** Said while a request waits on the hub's history allowance, so a slow load is not silent. */
  note: string | null;
}

/**
 * `id`'s candles for the last `days`, asked again whenever the instrument, interval or range
 * changes. A new interval of the same instrument keeps the candles on screen until its own
 * arrive, so the chart is not torn down and rebuilt on every switch; a 429 from the hub waits and
 * asks again rather than failing the chart.
 */
export function useCandles(id: string, interval: string, days: number): CandleState {
  const [state, setState] = useState<CandleState>({ candles: [], loading: false, error: null, note: null });
  const [shownId, setShownId] = useState(id);
  useEffect(() => {
    if (!id) {
      setState({ candles: [], loading: false, error: null, note: null });
      return;
    }
    let cancelled = false;
    let timer = 0;
    const sameInstrument = id === shownId;
    setShownId(id);
    setState((was) => ({ candles: sameInstrument ? was.candles : [], loading: true, error: null, note: null }));
    const ask = (attempt: number) => {
      candlesFor(id, interval, days)
        .then((candles) => {
          if (!cancelled) setState({ candles, loading: false, error: null, note: null });
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
  }, [id, interval, days]);
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
