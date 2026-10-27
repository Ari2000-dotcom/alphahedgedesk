import { useEffect, useMemo, useRef, useState } from "react";

import { impliedVol, yearsToExpiry } from "../core/black76";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";

/**
 * One option chain, live: the strikes from the hub's `chain` request, then the quotes of the
 * strikes around the money only (the hub lets a connection hold 50 live topics, and the page
 * holds a few for the indices and the chart). The window re-centres when spot has moved three
 * strikes, not on every tick, so subscriptions do not churn.
 *
 * What the hub's feed carries is the last price, bid, ask and volume; open interest is not in
 * it, so the chain shows prices, the straddle at each strike and the IV worked out here
 * (Black-76 on the straddle's own forward, as the hub does for the ATM IV).
 */

export interface ChainRow {
  strike: number;
  callId: string;
  putId: string;
  ce: number | null;
  pe: number | null;
  /** Call + put, when both are quoted. */
  straddle: number | null;
  ceIv: number | null;
  peIv: number | null;
}

export interface ChainState {
  rows: ChainRow[];
  spot: number | null;
  /** The strike nearest spot. */
  atm: number | null;
  /** Synthetic future at the money: call - put + strike. */
  forward: number | null;
  loading: boolean;
  error: string;
}

interface Strike {
  strike: number;
  call: string;
  put: string;
}

const RECENTRE_AT = 3;

export function useChain(hub: Hub, underlying: string, expiry: string, reach = 8): ChainState {
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(hub.state === "open");
  const [spot, setSpot] = useState<number | null>(null);
  const [centre, setCentre] = useState(-1);
  const [tick, setTick] = useState(0);
  const ltp = useRef(new Map<string, number>());

  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  // The strikes, once per pair.
  useEffect(() => {
    if (!underlying || !expiry || !connected) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    hub
      .request<{ reference: string; strikes: Strike[] }>({ op: "chain", underlying, expiry }, "chain")
      .then((r) => {
        if (cancelled) return;
        setReference(r.reference);
        setStrikes([...r.strikes].sort((a, b) => a.strike - b.strike));
        setCentre(-1);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hub, underlying, expiry, connected]);

  // Spot.
  useEffect(() => {
    if (!reference) return;
    return hub.subscribe(`quote:${reference}`, (msg: TopicMessage) => {
      const p = (msg as { ltp?: number }).ltp;
      if (msg.t === "q" && typeof p === "number" && p > 0) setSpot(p);
    });
  }, [hub, reference]);

  // The window's centre: the first time, and again when spot has moved RECENTRE_AT strikes.
  useEffect(() => {
    if (spot === null || strikes.length === 0) return;
    let best = 0;
    for (let i = 1; i < strikes.length; i++) if (Math.abs(strikes[i]!.strike - spot) < Math.abs(strikes[best]!.strike - spot)) best = i;
    setCentre((was) => (was < 0 || Math.abs(best - was) >= RECENTRE_AT ? best : was));
  }, [spot, strikes]);

  const windowed = useMemo(() => {
    if (centre < 0) return [];
    return strikes.slice(Math.max(0, centre - reach), centre + reach + 1);
  }, [strikes, centre, reach]);

  // The window's legs, a render at most per frame.
  useEffect(() => {
    if (windowed.length === 0) return;
    let frame: number | null = null;
    const bump = () => {
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          setTick((n) => n + 1);
        });
      }
    };
    const stops: (() => void)[] = [];
    for (const s of windowed) {
      for (const id of [s.call, s.put]) {
        stops.push(
          hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
            const p = (msg as { ltp?: number }).ltp;
            if (msg.t === "q" && typeof p === "number" && p > 0) {
              ltp.current.set(id, p);
              bump();
            }
          }),
        );
      }
    }
    return () => {
      for (const stop of stops) stop();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [hub, windowed]);

  return useMemo<ChainState>(() => {
    void tick;
    const mcx = underlying.startsWith("mcx:");
    const t = yearsToExpiry(expiry, mcx);
    const priced = windowed.map((s) => ({ s, ce: ltp.current.get(s.call) ?? null, pe: ltp.current.get(s.put) ?? null }));
    let atm: number | null = null;
    let forward: number | null = null;
    if (spot !== null && priced.length > 0) {
      const near = priced.reduce((a, b) => (Math.abs(b.s.strike - spot) < Math.abs(a.s.strike - spot) ? b : a));
      atm = near.s.strike;
      if (near.ce !== null && near.pe !== null) forward = near.ce - near.pe + near.s.strike;
    }
    const rows = priced.map(({ s, ce, pe }) => ({
      strike: s.strike,
      callId: s.call,
      putId: s.put,
      ce,
      pe,
      straddle: ce !== null && pe !== null ? ce + pe : null,
      ceIv: forward !== null && ce !== null ? impliedVol(ce, forward, s.strike, t, true) : null,
      peIv: forward !== null && pe !== null ? impliedVol(pe, forward, s.strike, t, false) : null,
    }));
    return { rows, spot, atm, forward, loading, error };
  }, [windowed, tick, spot, loading, error, underlying, expiry]);
}
