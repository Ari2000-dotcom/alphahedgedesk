import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSummaries } from "../desk/summary";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";
import { clearPrice, setPrice, usePricedCount } from "./quotes";

/**
 * One option chain, live, built the way AlphaHedge's is:
 *
 * - Every strike is a row, and the table opens with the money row in the middle: centred once the
 *   spot is known and then held, so rows never jump under the pointer. A new underlying waits up
 *   to SPOT_WAIT_MS for its spot before it centres without it (on the middle strike, and once
 *   more on the price when it lands): it never centres on a guess.
 * - Live prices are kept for the rows nearest the view only (ChainPanel calls `onView` on scroll),
 *   LIVE_ROWS at a time, and follow it as it scrolls. A row that leaves it shows "—" until scrolled
 *   back to; the budget shrinks if the hub refuses more and is remembered for the next chain.
 * - The table shows once most of its prices are in (REVEAL_SHARE), or after REVEAL_WAIT_MS:
 *   strikes and prices land together, and stays shown for that chain.
 * - Prices go to the quote store (option/quotes.ts), where each cell reads only its own
 *   contract: a tick redraws a cell, not the table.
 *
 * Cheap on the hub when many people look: the strike list is asked for once per underlying and
 * expiry and shared; the centre snaps to a grid of strikes so everyone on one underlying
 * subscribes the same legs (the hub holds one broker subscription per leg for all of them); and
 * the legs go out as one message.
 *
 * The hub's feed carries the last price, bid, ask and volume, not open interest, so the chain
 * shows prices, the straddle at each strike and IV worked out in the browser.
 */

export interface ChainRow {
  strike: number;
  callId: string;
  putId: string;
}

export interface ChainState {
  rows: ChainRow[];
  spot: number | null;
  /** The strike nearest spot. */
  atm: number | null;
  /** Key of the chain and its centre: the table scrolls to the money once per key. */
  scrollKey: string;
  /** True once the table may be drawn. */
  ready: boolean;
  /** What it is waiting for, when not ready. */
  waiting: string;
  priced: number;
  total: number;
  error: string;
  /** True when the hub won't hold a live price for every row at once: some wait to be scrolled to. */
  limited: boolean;
  /** The rows (by index into `rows`) actually on screen, so their prices are the ones kept live. */
  onView: (first: number, last: number) => void;
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

const NONE: Strike[] = [];

/**
 * The whole chain is the table: every strike the hub lists is a row. Live prices are kept only for
 * the rows nearest the view, LIVE_ROWS at a time (two legs each, so about 90 topics), and follow the
 * view as it scrolls; a row that leaves it drops its price and shows "—" until it is scrolled to.
 * The budget shrinks when the hub answers "topic limit reached" (an older hub allows 50 live
 * prices), and is remembered for the next chain, so the hub's real limit is learned once.
 */
const LIVE_ROWS = 45;
let liveRows = LIVE_ROWS;
const MIN_ROWS = 11;
/** The live set follows the view in steps of this many rows, so a scroll does not resubscribe at every row. */
const CHUNK = 6;

/** A new chain waits this long for its spot before centring without it. */
const SPOT_WAIT_MS = 1500;
/** The table shows once this share of its prices is in, or after REVEAL_WAIT_MS. */
const REVEAL_SHARE = 0.7;
const REVEAL_WAIT_MS = 1200;
/** The window's centre snaps to this many strikes, so people on one underlying share their legs. */
const GRID = 4;

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

/** True once `ms` have passed since `key` last changed. */
function useWaited(key: string, ms: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    setDone(false);
    if (!key) return;
    const timer = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return done;
}

function nearest(strikes: readonly Strike[], spot: number): number {
  let best = 0;
  for (let i = 1; i < strikes.length; i++) if (Math.abs(strikes[i]!.strike - spot) < Math.abs(strikes[best]!.strike - spot)) best = i;
  return best;
}

/**
 * The `budget` row indices nearest the [first, last] band, or every row once that covers them all.
 * `pin`, when given and not already among them, replaces the one picked row furthest from the
 * band — the set stays exactly `budget` long, so pinning a row never asks the hub for one more
 * than it already allows.
 */
function nearViewed(total: number, first: number, last: number, budget: number, pin?: number): number[] {
  if (budget >= total) return Array.from({ length: total }, (_, i) => i);
  const dist = (i: number) => (i < first ? first - i : i > last ? i - last : 0);
  const order = Array.from({ length: total }, (_, i) => i).sort((a, b) => dist(a) - dist(b) || a - b);
  const picked = order.slice(0, budget);
  if (pin !== undefined && !picked.includes(pin)) picked[picked.length - 1] = pin;
  return picked.sort((a, b) => a - b);
}

export function useChain(hub: Hub, underlying: string, expiry: string): ChainState {
  const chainKey = underlying && expiry ? `${underlying}|${expiry}` : "";
  const chainKeyRef = useRef(chainKey);
  chainKeyRef.current = chainKey;
  const [rowBudget, setRowBudget] = useState(liveRows);
  // Everything loaded is tagged with the chain it belongs to and ignored for any other: after a
  // switch the first render still holds the last chain's strikes and spot, and a window pinned on
  // those would stay at the wrong end of the new list.
  const [loaded, setLoaded] = useState<{ key: string; strikes: Strike[]; reference: string } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [spotOf, setSpotOf] = useState<{ name: string; value: number } | null>(null);
  const [refSpotOf, setRefSpotOf] = useState<{ name: string; value: number } | null>(null);
  const [connected, setConnected] = useState(hub.state === "open");
  const summaries = useSummaries();
  const strikes = loaded && loaded.key === chainKey ? loaded.strikes : NONE;
  const reference = loaded && loaded.key === chainKey ? loaded.reference : "";
  const error = failed && failed.key === chainKey ? failed.message : "";
  const spotA = spotOf && spotOf.name === underlying ? spotOf.value : null;
  const spotB = refSpotOf && refSpotOf.name === reference ? refSpotOf.value : null;

  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  // Which spot to trust: the underlying's own price first, then the expiry's reference, then what a
  // chart on the same underlying has seen. A price nowhere near the strikes (a wrong instrument, a
  // stray tick) is ignored, so it cannot put the window at the wrong end of the list.
  const lo = strikes[0]?.strike ?? 0;
  const hi = strikes[strikes.length - 1]?.strike ?? 0;
  const plausible = (v: number | null): v is number => v !== null && v > 0 && (strikes.length === 0 || (v >= lo * 0.6 && v <= hi * 1.6));
  const chartSpot = summaries.find((x) => x.key.startsWith(`${underlying}|`))?.last.spot ?? null;
  const spot = [spotA, spotB, chartSpot].find(plausible) ?? null;

  // The strikes: kept per pair, shared between panels.
  useEffect(() => {
    if (!chainKey || !connected) return;
    let cancelled = false;
    strikesOf(hub, underlying, expiry)
      .then((r) => {
        if (cancelled) return;
        setLoaded({ key: chainKey, strikes: r.strikes, reference: r.reference ?? "" });
        setFailed(null);
      })
      .catch((e: Error) => !cancelled && setFailed({ key: chainKey, message: e.message }));
    return () => {
      cancelled = true;
    };
  }, [hub, underlying, expiry, chainKey, connected]);

  // Spot: asked for now, in step with the strikes, by the underlying's own name...
  useEffect(() => {
    if (!underlying) return;
    return hub.subscribe(`quote:${underlying}`, (msg: TopicMessage) => {
      const p = (msg as { ltp?: number }).ltp;
      if (msg.t === "q" && typeof p === "number" && p > 0) setSpotOf({ name: underlying, value: p });
    });
  }, [hub, underlying]);
  // ...and by the reference the hub names for this expiry when that is another instrument.
  useEffect(() => {
    if (!reference || reference === underlying) return;
    return hub.subscribe(`quote:${reference}`, (msg: TopicMessage) => {
      const p = (msg as { ltp?: number }).ltp;
      if (msg.t === "q" && typeof p === "number" && p > 0) setRefSpotOf({ name: reference, value: p });
    });
  }, [hub, reference, underlying]);

  // The window's centre: pinned once known. Before the spot arrives it waits (SPOT_WAIT_MS), then
  // takes the middle strike, and moves once to the price when it lands.
  const spotLate = useWaited(strikes.length > 0 ? chainKey : "", SPOT_WAIT_MS);
  const [pinned, setPinned] = useState<{ key: string; index: number; onSpot: boolean } | null>(null);
  useEffect(() => {
    if (strikes.length === 0 || !chainKey) return;
    if (spot === null && !spotLate) return;
    if (pinned && pinned.key === chainKey && (pinned.onSpot || spot === null)) return;
    const best = spot === null ? Math.floor(strikes.length / 2) : nearest(strikes, spot);
    const snapped = Math.min(strikes.length - 1, Math.max(0, Math.round(best / GRID) * GRID));
    setPinned({ key: chainKey, index: snapped, onSpot: spot !== null });
  }, [strikes, spot, spotLate, chainKey, pinned]);
  const centre = pinned && pinned.key === chainKey ? pinned.index : -1;

  // Every strike is a row; the table opens on the pinned one.
  const window = useMemo(() => (centre < 0 ? [] : strikes), [strikes, centre]);
  const fullIds = useMemo(() => window.flatMap((s) => [s.call, s.put]), [window]);
  const centreRow = Math.max(0, centre);

  // What ChainPanel last reported as on screen (row indices into `window`); unset until its first
  // scroll, when it defaults to the centre row so the initial live set is still the money.
  const [viewed, setViewed] = useState<{ key: string; first: number; last: number } | null>(null);
  const onView = useCallback((first: number, last: number) => {
    const key = chainKeyRef.current;
    const from = Math.floor(Math.max(0, first) / CHUNK) * CHUNK;
    const to = Math.ceil(Math.max(0, last) / CHUNK) * CHUNK;
    setViewed((v) => (v && v.key === key && v.first === from && v.last === to ? v : { key, first: from, last: to }));
  }, []);
  const viewFirst = viewed && viewed.key === chainKey ? Math.max(0, Math.min(window.length - 1, viewed.first)) : centreRow;
  const viewLast = viewed && viewed.key === chainKey ? Math.max(viewFirst, Math.min(window.length - 1, viewed.last)) : centreRow;

  // The legs actually subscribed: every one of them while the hub allows it; once it doesn't, the
  // ones nearest the view, so scrolling trades a far row's price for a closer one instead of
  // thrashing subscriptions on every tick. Returns `fullIds` itself (not a new array) when
  // unlimited, so scrolling an ordinary chain never re-triggers the subscribe effect below.
  const ids = useMemo(() => {
    if (rowBudget >= window.length) return fullIds;
    const money = spot !== null && window.length > 0 ? nearest(window, spot) : undefined;
    return nearViewed(window.length, viewFirst, viewLast, rowBudget, money).flatMap((i) => [window[i]!.call, window[i]!.put]);
  }, [window, fullIds, rowBudget, viewFirst, viewLast, spot]);

  // The live legs: one batched subscribe; prices go straight to the quote store. A leg dropped from
  // the active set (scrolled out of reach) forgets its price, so it shows "—" rather than one that
  // can no longer change.
  const activeFor = useRef<string[]>([]);
  useEffect(() => {
    const next = new Set(ids);
    for (const id of activeFor.current) if (!next.has(id)) clearPrice(id);
    activeFor.current = ids;
    if (ids.length === 0) return;
    const stops = ids.map((id) =>
      hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
        const p = (msg as { ltp?: number }).ltp;
        if (msg.t === "q" && typeof p === "number" && p > 0) setPrice(id, p);
        else if (msg.t === "err" && /topic limit/i.test(String((msg as { error?: unknown }).error ?? ""))) {
          // The hub will not hold this many: keep fewer live at once, and remember it for next time.
          liveRows = Math.max(MIN_ROWS, Math.floor(liveRows * 0.6));
          setRowBudget((r) => Math.min(r, liveRows));
        }
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [hub, ids]);

  // Strikes and prices land together: wait (at most REVEAL_WAIT_MS) for most of the prices, then
  // show; once shown, stay shown for this chain.
  const windowKey = centre >= 0 ? `${chainKey}|${centre}` : "";
  const shownFor = useRef("");
  const shownOnce = shownFor.current === chainKey;
  const priced = usePricedCount(shownOnce ? [] : ids);
  const timedOut = useWaited(windowKey, REVEAL_WAIT_MS);
  const ready = shownOnce || (ids.length > 0 && (priced >= ids.length * REVEAL_SHARE || timedOut));
  if (ready && chainKey) shownFor.current = chainKey;

  const rows = useMemo<ChainRow[]>(() => window.map((s) => ({ strike: s.strike, callId: s.call, putId: s.put })), [window]);
  const atm = spot !== null && rows.length > 0 ? rows.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a)).strike : null;
  const waiting = strikes.length === 0 ? "Loading the strikes" : centre < 0 ? "Finding the price" : "Loading prices";

  return {
    rows,
    spot,
    atm,
    scrollKey: windowKey,
    ready,
    waiting,
    priced: shownOnce ? ids.length : priced,
    total: ids.length,
    error,
    // True only when the hub has actually refused prices (the budget shrank), not merely because the chain is long.
    limited: rowBudget < LIVE_ROWS,
    onView,
  };
}
