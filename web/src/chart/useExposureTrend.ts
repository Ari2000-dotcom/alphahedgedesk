import { useMemo, useRef } from "react";

import type { OiProfileData } from "./useOiProfile";

/**
 * Delta x OI per strike, with how each strike's exposure has moved: the profile `OiProfileBars`
 * draws in its layered view, the change being now against a reference a few minutes back (or the
 * first reading, until there is that much). A strike adding exposure draws solid at its outer end;
 * one losing it draws as an outline beyond. Reads on the panel's own one-second beat.
 */

/** How far back the reference is, ms. */
const LOOK_BACK_MS = 2 * 60_000;
/** A new reading is kept this often, ms. */
const KEEP_EVERY_MS = 5_000;
/** A move smaller than this share of the strike's exposure is noise, not a trend. */
const NOISE = 0.0015;

interface Sample {
  at: number;
  call: Map<number, number>;
  put: Map<number, number>;
}

/** One strike's delta x OI on each side, the put's negative; null where a leg has no reading. */
export interface ExposureRow {
  strike: number;
  callDeltaOi: number | null;
  putDeltaOi: number | null;
}

const mag = (v: number | null) => (v === null ? Number.NaN : Math.abs(v));

export function useExposureTrend(rows: readonly ExposureRow[], active: boolean, key: string): OiProfileData | null {
  const samples = useRef<{ key: string; list: Sample[] }>({ key: "", list: [] });
  return useMemo(() => {
    if (!active || rows.length === 0) return null;
    if (samples.current.key !== key) samples.current = { key, list: [] };
    const list = samples.current.list;
    const now = Date.now();
    const call = rows.map((r) => mag(r.callDeltaOi));
    const put = rows.map((r) => mag(r.putDeltaOi));
    const last = list[list.length - 1];
    if (!last || now - last.at >= KEEP_EVERY_MS) {
      list.push({
        at: now,
        call: new Map(rows.map((r, i) => [r.strike, call[i]!])),
        put: new Map(rows.map((r, i) => [r.strike, put[i]!])),
      });
      while (list.length > 0 && now - list[0]!.at > LOOK_BACK_MS * 2) list.shift();
    }
    // A strike's reference: its newest reading at least LOOK_BACK_MS old, or failing that its oldest
    // one (a leg that priced late has no earlier reading than that).
    const reference = (side: "call" | "put", strike: number): number | undefined => {
      let old: number | undefined;
      let first: number | undefined;
      for (const s of list) {
        const v = s[side].get(strike);
        if (v === undefined || !Number.isFinite(v)) continue;
        if (first === undefined) first = v;
        if (now - s.at >= LOOK_BACK_MS) old = v;
      }
      return old ?? first;
    };
    const move = (now_: number, then: number | undefined) => {
      if (!Number.isFinite(now_) || then === undefined) return 0;
      const d = now_ - then;
      return Math.abs(d) < NOISE * Math.max(now_, then) ? 0 : d;
    };
    return {
      strikes: rows.map((r) => r.strike),
      call,
      put,
      callChange: rows.map((r, i) => move(call[i]!, reference("call", r.strike))),
      putChange: rows.map((r, i) => move(put[i]!, reference("put", r.strike))),
    };
  }, [rows, active, key]);
}
