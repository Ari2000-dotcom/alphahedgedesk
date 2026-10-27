import { useEffect, useMemo, useRef, useState } from "react";
import type { SeriesDataItem } from "openalgo-charts";

import { istDate } from "../core/format";
import type { Hub } from "../hub/client";
import type { Bar, TopicMessage } from "../hub/types";

/**
 * The straddles picked on the option chain, as lines for the chart: each strike's call plus its
 * put, one point a minute, on the same minutes as the ATM straddle.
 *
 * The hub has no straddle for a fixed strike, so it is put together here from what it does have:
 * each leg's one-minute candles for the session (the `/history` request, one day per leg) and,
 * for today, the leg's live quotes, kept by minute so the minutes after the history was asked for
 * fill in as they happen. A minute a leg did not trade carries the one before it forward, as the
 * hub does for the ATM straddle.
 */

export interface StrikeLine {
  strike: number;
  colour: string;
  /** The chart's points, on `bars`' minutes; a minute with no price is a gap. */
  points: SeriesDataItem[];
  /** Value by minute (epoch seconds), for the crosshair's tooltip. */
  byTime: Map<number, number>;
  first: number | null;
  last: number | null;
}

type Closes = Map<number, number>;

const sec = (ms: number) => Math.floor(ms / 1000);

async function legCloses(id: string, day: string): Promise<Closes> {
  const q = new URLSearchParams({ id, interval: "1m", from: day, to: day });
  const res = await fetch(`/history?${q}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { pieces: { candles?: number[][] }[] };
  const out: Closes = new Map();
  for (const piece of body.pieces) for (const c of piece.candles ?? []) out.set(c[0]!, c[4]!);
  return out;
}

export function useStrikeLines(
  hub: Hub,
  underlying: string,
  expiry: string,
  day: string,
  bars: readonly Bar[],
  picks: readonly { strike: number; colour: string }[],
): StrikeLine[] {
  const live = day === "live";
  const sessionDay = live ? istDate(Date.now()) : day;
  const legs = useMemo(
    () => picks.flatMap((p) => [`${underlying}:${expiry}:${p.strike}:CE`, `${underlying}:${expiry}:${p.strike}:PE`]),
    [picks, underlying, expiry],
  );
  const legKey = legs.join("|");

  const [history, setHistory] = useState<Map<string, Closes>>(() => new Map());
  const asked = useRef(new Set<string>());
  const liveByMinute = useRef(new Map<string, Closes>());
  const [tick, setTick] = useState(0);

  // A different pair or session starts from nothing.
  useEffect(() => {
    asked.current = new Set();
    liveByMinute.current = new Map();
    setHistory(new Map());
  }, [underlying, expiry, sessionDay]);

  // Each leg's candles for the session, once.
  useEffect(() => {
    let cancelled = false;
    for (const id of legs) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      legCloses(id, sessionDay)
        .catch(() => new Map() as Closes)
        .then((closes) => {
          if (cancelled) return;
          setHistory((was) => new Map(was).set(id, closes));
        });
    }
    return () => {
      cancelled = true;
      // Asked but not heard back from: ask again next time.
      for (const id of legs) if (!history.has(id)) asked.current.delete(id);
    };
  }, [legKey, sessionDay]); // eslint-disable-line react-hooks/exhaustive-deps

  // Today: each leg's live quotes, by minute, a render at most per frame.
  useEffect(() => {
    if (!live || legs.length === 0) return;
    let frame: number | null = null;
    const bump = () => {
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          setTick((n) => n + 1);
        });
      }
    };
    const stops = legs.map((id) =>
      hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
        const p = (msg as { ltp?: number }).ltp;
        if (msg.t !== "q" || typeof p !== "number" || !(p > 0)) return;
        const minute = Math.floor(Date.now() / 60_000) * 60;
        let m = liveByMinute.current.get(id);
        if (!m) liveByMinute.current.set(id, (m = new Map()));
        m.set(minute, p);
        bump();
      }),
    );
    return () => {
      for (const stop of stops) stop();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [hub, legKey, live]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    void tick;
    if (bars.length === 0) return [];
    return picks.map((p) => {
      const ce = `${underlying}:${expiry}:${p.strike}:CE`;
      const pe = `${underlying}:${expiry}:${p.strike}:PE`;
      let lastCe: number | null = null;
      let lastPe: number | null = null;
      const byTime = new Map<number, number>();
      const points: SeriesDataItem[] = [];
      let first: number | null = null;
      let last: number | null = null;
      for (const bar of bars) {
        const t = sec(bar.t);
        lastCe = liveByMinute.current.get(ce)?.get(t) ?? history.get(ce)?.get(t) ?? lastCe;
        lastPe = liveByMinute.current.get(pe)?.get(t) ?? history.get(pe)?.get(t) ?? lastPe;
        if (lastCe !== null && lastPe !== null) {
          const v = lastCe + lastPe;
          points.push({ time: t, value: v });
          byTime.set(t, v);
          if (first === null) first = v;
          last = v;
        } else {
          points.push({ time: t });
        }
      }
      return { strike: p.strike, colour: p.colour, points, byTime, first, last };
    });
  }, [bars, picks, history, tick, underlying, expiry]);
}
