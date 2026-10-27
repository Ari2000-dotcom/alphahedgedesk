import { useEffect, useMemo, useRef, useState } from "react";

import { impliedVol, yearsToExpiry } from "../core/black76";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";

/**
 * One option chain, live: the strikes from the hub's `chain` request, then the quotes of the
 * strikes around the money only (the hub lets a connection hold 50 live topics, and the page
 * holds a few for the indices and the chart).
 *
 * Built to show something at once, and to cost the hub little when many people open chains:
 *
 * - The strike list is asked for once per underlying and expiry and kept (it does not change in
 *   a day), and a second chain asking while the first is in flight shares the one request.
 * - Spot is subscribed at the same moment as the strikes are asked for, not after them, and the
 *   rows show as soon as the strikes are in, centred on the last spot this computer saw until
 *   the live one arrives.
 * - The window's centre snaps to a grid of strikes, so everyone looking at the same underlying
 *   subscribes the same legs: the hub holds one broker subscription per leg for all of them.
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

interface Reply {
  reference: string | null;
  strikes: Strike[];
}

/** Strike lists by underlying and expiry: one request each, shared and kept for the session. */
const replies = new Map<string, Promise<Reply>>();
const KEEP_MS = 30 * 60_000;

function strikesOf(hub: Hub, underlying: string, expiry: string): Promise<Reply> {
  const key = `${underlying}|${expiry}`;
  let pending = replies.get(key);
  if (!pending) {
    pending = hub
      .request<{ reference: string | null; strikes: Strike[] }>({ op: "chain", underlying, expiry }, "chain")
      .then((r) => ({ reference: r.reference, strikes: [...r.strikes].sort((a, b) => a.strike - b.strike) }));
    replies.set(key, pending);
    pending.catch(() => replies.delete(key));
    setTimeout(() => replies.delete(key), KEEP_MS);
  }
  return pending;
}

/** The last spot seen for an underlying on this computer: where to centre before the live one. */
const spotKey = (underlying: string) => `mh.spot.${underlying}`;
function lastSpot(underlying: string): number | null {
  try {
    const v = Number(localStorage.getItem(spotKey(underlying)));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** The window moves in steps of this many strikes, so people on one underlying share their legs. */
const GRID = 4;
/** Spot has to be this many strikes from the centre before the window moves. */
const MOVE_AT = 5;

function nearest(strikes: readonly Strike[], spot: number): number {
  let best = 0;
  for (let i = 1; i < strikes.length; i++) if (Math.abs(strikes[i]!.strike - spot) < Math.abs(strikes[best]!.strike - spot)) best = i;
  return best;
}

export function useChain(hub: Hub, underlying: string, expiry: string, reach = 8): ChainState {
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(hub.state === "open");
  const [spotA, setSpotA] = useState<number | null>(null);
  const [spotB, setSpotB] = useState<number | null>(null);
  const [centre, setCentre] = useState(-1);
  const [tick, setTick] = useState(0);
  const ltp = useRef(new Map<string, number>());
  const spot = spotB ?? spotA;

  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  // A different underlying starts clean.
  useEffect(() => {
    setStrikes([]);
    setReference("");
    setSpotA(null);
    setSpotB(null);
    setCentre(-1);
    setError("");
  }, [underlying, expiry]);

  // The strikes: kept per pair, shared between panels.
  useEffect(() => {
    if (!underlying || !expiry || !connected) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    strikesOf(hub, underlying, expiry)
      .then((r) => {
        if (cancelled) return;
        setReference(r.reference ?? "");
        setStrikes(r.strikes);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hub, underlying, expiry, connected]);

  // Spot: asked for now, in step with the strikes, by the underlying's own name...
  useEffect(() => {
    if (!underlying) return;
    return hub.subscribe(`quote:${underlying}`, (msg: TopicMessage) => {
      const p = (msg as { ltp?: number }).ltp;
      if (msg.t === "q" && typeof p === "number" && p > 0) setSpotA(p);
    });
  }, [hub, underlying]);
  // ...and by the reference the hub names for this expiry when that is another instrument (a future).
  useEffect(() => {
    if (!reference || reference === underlying) return;
    return hub.subscribe(`quote:${reference}`, (msg: TopicMessage) => {
      const p = (msg as { ltp?: number }).ltp;
      if (msg.t === "q" && typeof p === "number" && p > 0) setSpotB(p);
    });
  }, [hub, reference, underlying]);

  // Remember the spot for the next visit, at most every few seconds.
  const saved = useRef(0);
  useEffect(() => {
    if (spot === null || !underlying || Date.now() - saved.current < 5000) return;
    saved.current = Date.now();
    try {
      localStorage.setItem(spotKey(underlying), String(spot));
    } catch {
      // A per-viewer convenience only.
    }
  }, [spot, underlying]);

  // The window's centre: from the live spot, else the last one seen, else the middle of the list.
  useEffect(() => {
    if (strikes.length === 0) return;
    const at = spot ?? lastSpot(underlying);
    const best = at !== null ? nearest(strikes, at) : Math.floor(strikes.length / 2);
    const snapped = Math.min(strikes.length - 1, Math.max(0, Math.round(best / GRID) * GRID));
    setCentre((was) => (was < 0 || Math.abs(best - was) > MOVE_AT ? snapped : was));
  }, [spot, strikes, underlying]);

  const windowed = useMemo(() => {
    if (centre < 0) return [];
    return strikes.slice(Math.max(0, centre - reach), centre + reach + 1);
  }, [strikes, centre, reach]);

  // The window's legs, a render at most per frame. Subscribed together: the client sends them as one message.
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
