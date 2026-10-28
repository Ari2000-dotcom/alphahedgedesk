import { useEffect, useState } from "react";

import type { Hub } from "../hub/client";

export type OiProfileMode = "oi" | "change";

/** One snapshot of the profile: ascending strikes, each side's OI, and each side's change since
 *  yesterday's close (NaN where unknown) — QuantDesk's `OiProfileData` (chart/oiProfile.ts there). */
export interface OiProfileData {
  strikes: number[];
  call: number[];
  put: number[];
  callChange: number[];
  putChange: number[];
}

/** The hub's `oi_profile` answer: OI now and at the previous session's settle, null where Nubra
 *  has no figure for a leg (never zero). */
interface OiProfileReply {
  at: number;
  prev_at: number;
  strikes: number[];
  call: (number | null)[];
  put: (number | null)[];
  call_prev: (number | null)[];
  put_prev: (number | null)[];
}

/** How often the profile is asked again. The hub shares one Nubra answer a minute among everyone. */
const REFRESH_MS = 60_000;

const num = (v: number | null | undefined) => (v === null || v === undefined ? Number.NaN : v);

function toData(r: OiProfileReply): OiProfileData {
  const call = r.call.map(num);
  const put = r.put.map(num);
  return {
    strikes: r.strikes,
    call,
    put,
    callChange: call.map((v, i) => v - num(r.call_prev[i])),
    putChange: put.map((v, i) => v - num(r.put_prev[i])),
  };
}

/**
 * The OI profile for one or more expiries of `underlying`: every strike's call and put open
 * interest, summed strike by strike over the picked expiries, as QuantDesk draws it. One hub
 * request (`oi_profile`, from Nubra's `charts/multistrike`) carries the whole chain, refreshed
 * every minute, where a quote subscription per leg would need two topics a strike (a NIFTY expiry
 * lists ~235) against a visitor's 120 and still carry no open interest.
 */
export function useOiProfile(hub: Hub, underlying: string, expiries: readonly string[]): { data: OiProfileData | null; loading: boolean } {
  const expiryKey = [...expiries].sort().join(",");
  const [data, setData] = useState<OiProfileData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    if (!underlying || !expiryKey) return;
    let cancelled = false;
    let timer = 0;
    const ask = () => {
      setLoading(true);
      hub
        .request<OiProfileReply>({ op: "oi_profile", underlying, expiries: expiryKey.split(",") }, "oi_profile")
        .then((r) => !cancelled && setData(toData(r)))
        .catch(() => {
          // Keep the last profile on screen; the next round tries again.
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
          timer = window.setTimeout(ask, REFRESH_MS);
        });
    };
    ask();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hub, underlying, expiryKey]);

  return { data, loading };
}
