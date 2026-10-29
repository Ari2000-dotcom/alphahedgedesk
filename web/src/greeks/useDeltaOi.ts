import { useEffect, useMemo, useRef, useState } from "react";

import { delta76, impliedVol, yearsToExpiry } from "../core/black76";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";
import { oiOf, priceOf, setOi, setPrice } from "../option/quotes";
import { strikesOf, useSpot, type Strike } from "../option/useChain";

/**
 * Delta x open interest, strike by strike, for one underlying and expiry.
 *
 * What it is: how much of the underlying each side of the book is effectively long or short. One
 * contract's open interest says how many are outstanding; its delta says how much of the
 * underlying one of them behaves like. Multiplied and added up, the calls give one number and the
 * puts another, and the two together say where the written and bought exposure sits.
 *
 * How it is worked out here, which is the same arithmetic the chain's IV column uses:
 *
 * - **Open interest** comes from the feed (`oi` on the hub's quote), one number per leg, and lands
 *   in the quote store. Nothing is inferred: a leg whose OI has not arrived is left out of the
 *   totals and counted as not covered, so a half-loaded band never reads as a small one.
 * - **Delta** is Black-76 on the forward (`core/black76.ts`, the hub's own model), at the leg's own
 *   implied vol worked back from its price. Where a price sits below intrinsic and no vol solves,
 *   the ATM vol stands in rather than dropping the strike — a deep ITM leg's delta is ~1 either
 *   way, and its OI is often the largest on the board.
 * - **The forward** is call - put + strike at the money (put-call parity), not the spot: it carries
 *   the basis the options are actually priced against. The spot stands in before the ATM legs are
 *   priced.
 * - Puts keep their sign. A put's delta is negative, so the put total is negative, and the net is
 *   the two added — the one number that says which way the board leans.
 *
 * Only a band around the money is live, `band` strikes each side. That is a hub limit, not a
 * preference: a browser tab holds one socket with a topic budget shared with every other panel
 * (an option chain alone takes ~90), so a whole chain of legs cannot be subscribed as well. The
 * band is where almost all of the delta-weighted exposure sits anyway, and `covered` /
 * `strikesTotal` always say how much of the board the numbers cover. The budget shrinks itself if
 * the hub refuses more.
 *
 * Reads the store on a one-second clock rather than on every tick: a band of 40 legs ticks many
 * times a second, and a figure a person reads does not need to move faster than that.
 */

export interface DeltaOiRow {
  strike: number;
  callId: string;
  putId: string;
  callOi: number | null;
  putOi: number | null;
  /** 0..1 for the call, -1..0 for the put; null until its leg is priced. */
  callDelta: number | null;
  putDelta: number | null;
  /** delta x OI, the put's negative. Null unless both that leg's delta and its OI are known. */
  callDeltaOi: number | null;
  putDeltaOi: number | null;
  atm: boolean;
}

export interface DeltaOiState {
  rows: DeltaOiRow[];
  spot: number | null;
  /** The forward the deltas are taken on (call - put + strike at the money), or the spot. */
  forward: number | null;
  atm: number | null;
  /** ATM implied vol in percent, the vol that stands in for a leg that solves for none. */
  atmIv: number | null;
  /** Sum of the calls' delta x OI: positive. */
  callTotal: number;
  /** Sum of the puts': negative. */
  putTotal: number;
  /** callTotal + putTotal, signed. */
  net: number;
  callOiTotal: number;
  putOiTotal: number;
  /** Strikes whose two legs are both counted, out of the band, out of the whole expiry. */
  covered: number;
  inBand: number;
  strikesTotal: number;
  /** Legs subscribed right now. */
  legs: number;
  ready: boolean;
  /** What it is waiting for, when not ready. */
  waiting: string;
  error: string;
  /** True when prices are coming but no open interest is: a hub that does not send it yet. */
  noOi: boolean;
  /** True when the hub refused the band's legs and a smaller one is live. */
  limited: boolean;
}

/** Strikes each side of the money a band can be. */
export const BANDS = [5, 10, 20] as const;
export type Band = (typeof BANDS)[number];
export const DEFAULT_BAND: Band = 10;

/**
 * Legs the hub will hold for this panel: enough for the widest band to start with, shrunk and
 * remembered when it says no (as `useChain` does with its rows). So a trimmed band always means
 * the hub actually refused, never that this panel asked for less than it was offered.
 */
let legBudget = (Math.max(...BANDS) * 2 + 1) * 2;
const MIN_LEGS = 10;

/** How often the figures are recomputed from the store. */
const BEAT_MS = 1000;
/** Priced legs but no OI for this long: the hub is one that does not send it. */
const NO_OI_AFTER_MS = 6000;
/** Prices in but nothing fully covered by then: draw what there is, with "—" where it is missing. */
const REVEAL_WAIT_MS = 4000;

/** A counter that steps every `ms`, to recompute from the quote store on a clock. */
function useBeat(ms: number): number {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setBeat((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return beat;
}

const nearestIndex = (strikes: readonly Strike[], spot: number): number => {
  let best = 0;
  for (let i = 1; i < strikes.length; i++) if (Math.abs(strikes[i]!.strike - spot) < Math.abs(strikes[best]!.strike - spot)) best = i;
  return best;
};

const NONE: Strike[] = [];

export function useDeltaOi(hub: Hub, underlying: string, expiry: string, band: Band): DeltaOiState {
  const key = underlying && expiry ? `${underlying}|${expiry}` : "";
  const [loaded, setLoaded] = useState<{ key: string; strikes: Strike[]; reference: string } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [connected, setConnected] = useState(hub.state === "open");
  const [budget, setBudget] = useState(legBudget);
  const strikes = loaded && loaded.key === key ? loaded.strikes : NONE;
  const reference = loaded && loaded.key === key ? loaded.reference : "";
  const error = failed && failed.key === key ? failed.message : "";
  const spot = useSpot(hub, underlying, reference, strikes);
  const beat = useBeat(BEAT_MS);

  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  // The strike list: the same request the chain makes, shared with it.
  useEffect(() => {
    if (!key || !connected) return;
    let cancelled = false;
    strikesOf(hub, underlying, expiry)
      .then((r) => {
        if (cancelled) return;
        setLoaded({ key, strikes: r.strikes, reference: r.reference ?? "" });
        setFailed(null);
      })
      .catch((e: Error) => !cancelled && setFailed({ key, message: e.message }));
    return () => {
      cancelled = true;
    };
  }, [hub, underlying, expiry, key, connected]);

  // The band: `band` strikes each side of the money, trimmed to what the hub will hold.
  const atmIndex = strikes.length > 0 && spot !== null ? nearestIndex(strikes, spot) : -1;
  const inBand = useMemo(() => {
    if (atmIndex < 0) return NONE;
    // Two legs a strike, and the money strike is one of them: (budget / 2 - 1) / 2 each side.
    const each = Math.min(band, Math.max(0, Math.floor((Math.floor(budget / 2) - 1) / 2)));
    return strikes.slice(Math.max(0, atmIndex - each), Math.min(strikes.length, atmIndex + each + 1));
  }, [strikes, atmIndex, band, budget]);
  const ids = useMemo(() => inBand.flatMap((s) => [s.call, s.put]), [inBand]);

  // The band's legs, one batched subscribe; price and OI go to the quote store, which the chain
  // panel reads from too. Legs are not forgotten on the way out: a chain panel open on the same
  // underlying may still be showing them, and outside market hours nothing would refill them.
  useEffect(() => {
    if (ids.length === 0) return;
    const stops = ids.map((id) =>
      hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
        if (msg.t === "err") {
          if (/topic limit/i.test(String((msg as { error?: unknown }).error ?? ""))) {
            legBudget = Math.max(MIN_LEGS, Math.floor(legBudget * 0.6));
            setBudget((b) => Math.min(b, legBudget));
          }
          return;
        }
        if (msg.t !== "q") return;
        const p = (msg as { ltp?: number }).ltp;
        const oi = (msg as { oi?: number }).oi;
        if (typeof oi === "number" && oi >= 0) setOi(id, oi);
        if (typeof p === "number" && p > 0) setPrice(id, p);
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [hub, ids]);

  const mcx = underlying.startsWith("mcx:");
  // Rounded to the minute so a new second alone does not move every delta.
  const years = Math.round(yearsToExpiry(expiry, mcx) * 525_600) / 525_600;

  // The figures, from the store, once a beat.
  const figures = useMemo(() => {
    void beat;
    const atmStrike = atmIndex >= 0 ? strikes[atmIndex]!.strike : null;
    const atmLeg = atmIndex >= 0 ? strikes[atmIndex]! : null;
    const atmCe = atmLeg ? priceOf(atmLeg.call) : undefined;
    const atmPe = atmLeg ? priceOf(atmLeg.put) : undefined;
    // Put-call parity at the money, with the spot standing in until both ATM legs are priced.
    const forward = atmStrike !== null && atmCe !== undefined && atmPe !== undefined ? atmCe - atmPe + atmStrike : spot;
    // The ATM vol, which stands in for any leg that solves for none.
    const atmIv =
      forward !== null && atmStrike !== null
        ? (atmCe !== undefined ? impliedVol(atmCe, forward, atmStrike, years, true) : null) ?? (atmPe !== undefined ? impliedVol(atmPe, forward, atmStrike, years, false) : null)
        : null;

    const volOf = (price: number | undefined, strike: number, call: boolean): number | null => {
      if (price === undefined || forward === null) return null;
      return impliedVol(price, forward, strike, years, call) ?? atmIv;
    };

    let callTotal = 0;
    let putTotal = 0;
    let callOiTotal = 0;
    let putOiTotal = 0;
    let covered = 0;
    let priced = 0;
    let withOi = 0;

    const rows = inBand.map<DeltaOiRow>((s) => {
      const ce = priceOf(s.call);
      const pe = priceOf(s.put);
      const callOi = oiOf(s.call) ?? null;
      const putOi = oiOf(s.put) ?? null;
      if (ce !== undefined) priced++;
      if (pe !== undefined) priced++;
      if (callOi !== null) withOi++;
      if (putOi !== null) withOi++;

      const ceVol = volOf(ce, s.strike, true);
      const peVol = volOf(pe, s.strike, false);
      const callDelta = ceVol !== null && forward !== null ? delta76(forward, s.strike, years, ceVol / 100, true) : null;
      const putDelta = peVol !== null && forward !== null ? delta76(forward, s.strike, years, peVol / 100, false) : null;
      const callDeltaOi = callDelta !== null && callOi !== null ? callDelta * callOi : null;
      const putDeltaOi = putDelta !== null && putOi !== null ? putDelta * putOi : null;

      if (callDeltaOi !== null) {
        callTotal += callDeltaOi;
        callOiTotal += callOi!;
      }
      if (putDeltaOi !== null) {
        putTotal += putDeltaOi;
        putOiTotal += putOi!;
      }
      if (callDeltaOi !== null && putDeltaOi !== null) covered++;

      return { strike: s.strike, callId: s.call, putId: s.put, callOi, putOi, callDelta, putDelta, callDeltaOi, putDeltaOi, atm: atmIndex >= 0 && s.strike === atmStrike };
    });

    return { rows, forward, atm: atmStrike, atmIv, callTotal, putTotal, callOiTotal, putOiTotal, covered, priced, withOi };
  }, [inBand, strikes, atmIndex, spot, years, beat]);

  // Prices in but no open interest at all, for a while: this hub does not send it.
  const since = useRef<{ key: string; at: number } | null>(null);
  if (!since.current || since.current.key !== key) since.current = { key, at: Date.now() };
  const waited = Date.now() - since.current.at;
  const noOi = figures.priced > 0 && figures.withOi === 0 && waited > NO_OI_AFTER_MS;

  const waiting = strikes.length === 0 ? "Loading the strikes" : spot === null ? "Finding the price" : figures.priced === 0 ? "Loading prices" : "Loading open interest";

  return {
    rows: figures.rows,
    spot,
    forward: figures.forward,
    atm: figures.atm,
    atmIv: figures.atmIv,
    callTotal: figures.callTotal,
    putTotal: figures.putTotal,
    net: figures.callTotal + figures.putTotal,
    callOiTotal: figures.callOiTotal,
    putOiTotal: figures.putOiTotal,
    covered: figures.covered,
    inBand: inBand.length,
    strikesTotal: strikes.length,
    legs: ids.length,
    // One covered strike is enough to draw; failing that, whatever is there after REVEAL_WAIT_MS,
    // so a leg the feed is quiet about cannot hold the whole panel on its spinner.
    ready: figures.covered > 0 || noOi || (figures.priced > 0 && waited > REVEAL_WAIT_MS),
    waiting,
    error,
    noOi,
    limited: inBand.length < Math.min(strikes.length, band * 2 + 1),
  };
}
