/** What the hub sends; see hub/src/api.rs and hub/src/straddle.rs. */

/** One straddle minute. `t` is the minute's start (epoch ms). */
export interface Bar {
  t: number;
  spot: number;
  strike: number;
  atm: number;
  call: number;
  put: number;
  straddle: number;
  synth: number;
  vwap: number | null;
  iv: number | null;
  vix: number | null;
  rolled: boolean;
}

export interface Underlying {
  /** Canonical id, e.g. `nse:nifty`. */
  id: string;
  name: string;
  expiries: string[];
  lot: number;
}

export interface StraddleSnapshot {
  t: "straddle_snapshot";
  topic: string;
  underlying: string;
  expiry: string;
  reference: string;
  /** "loading" | "done" | "none" | "failed: …" */
  backfill: string;
  bars: Bar[];
}

export interface StraddleUpdate {
  t: "straddle";
  topic: string;
  /** Finished bars so far, at the hub. */
  n: number;
  bar: Bar;
  prev: Bar | null;
}

export interface TopicError {
  t: "err";
  topic?: string;
  req?: string;
  error: string;
}

export type TopicMessage = StraddleSnapshot | StraddleUpdate | TopicError | { t: string; topic?: string; [k: string]: unknown };
