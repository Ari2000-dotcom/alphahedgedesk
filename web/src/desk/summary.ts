import { useSyncExternalStore } from "react";

import type { Bar } from "../hub/types";

/**
 * What each open straddle chart knows, kept for the panels that only read it (the straddle table,
 * the ATM details). They add no topics of their own: the chart already holds the hub's straddle
 * topic, and what it receives is published here, one row per underlying and expiry.
 */

export interface Summary {
  key: string;
  name: string;
  exchange: string;
  expiry: string;
  lot: number;
  /** The session's first and latest minute. */
  open: Bar;
  last: Bar;
  /** True for today's live session; a past day is not a live reading. */
  live: boolean;
  at: number;
}

let rows: readonly Summary[] = [];
const listeners = new Set<() => void>();

export function publishSummary(s: Summary): void {
  const next = rows.filter((r) => r.key !== s.key);
  next.push(s);
  rows = next;
  for (const fn of listeners) fn();
}

export function dropSummary(key: string): void {
  if (!rows.some((r) => r.key === key)) return;
  rows = rows.filter((r) => r.key !== key);
  for (const fn of listeners) fn();
}

export const useSummaries = (): readonly Summary[] =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => rows,
  );
