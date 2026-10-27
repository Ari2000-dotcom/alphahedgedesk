import { useSyncExternalStore } from "react";

/**
 * The straddles picked on the option chain to sit on the chart beside the ATM one: up to five in
 * all, the ATM straddle counting as the first. One list for the whole desk, so a "+" in a chain
 * panel shows up at once on every chart of the same underlying and expiry, and the chips,
 * details and chain panels all read the same colours.
 */

export const MAX_STRADDLES = 5;

/** The ATM straddle's colour first, then the picks', all told apart on the dark ground. */
export const PICK_COLOURS = ["#ff7ac6", "#a78bfa", "#c3e66e", "#ffab85", "#4fd1ff"] as const;
export const ATM_COLOUR = PICK_COLOURS[0];

export interface Compare {
  /** `nse:nifty` and the expiry the picks belong to; a chart on another pair shows none of them. */
  underlying: string;
  expiry: string;
  picks: readonly { strike: number; colour: string }[];
}

const EMPTY: Compare = { underlying: "", expiry: "", picks: [] };
const KEY = "mh.compare";

function read(): Compare {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Compare;
      if (typeof v.underlying === "string" && Array.isArray(v.picks)) return v;
    }
  } catch {
    // Nothing stored, or storage is off: start empty.
  }
  return EMPTY;
}

let state: Compare = read();
const listeners = new Set<() => void>();

function set(next: Compare) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A per-viewer convenience only.
  }
  for (const fn of listeners) fn();
}

export const useCompare = (): Compare =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );

/** How many straddles are on a chart for this pair: the ATM one and the picks. */
export const countFor = (c: Compare, underlying: string, expiry: string) => 1 + (c.underlying === underlying && c.expiry === expiry ? c.picks.length : 0);

/** The picks of a pair, or none when the list belongs to another one. */
export const picksFor = (c: Compare, underlying: string, expiry: string) => (c.underlying === underlying && c.expiry === expiry ? c.picks : []);

export function togglePick(underlying: string, expiry: string, strike: number): void {
  const same = state.underlying === underlying && state.expiry === expiry;
  const picks = same ? state.picks : [];
  const have = picks.find((p) => p.strike === strike);
  if (have) {
    set({ underlying, expiry, picks: picks.filter((p) => p.strike !== strike) });
    return;
  }
  if (1 + picks.length >= MAX_STRADDLES) return;
  const used = new Set(picks.map((p) => p.colour));
  const colour = PICK_COLOURS.slice(1).find((c) => !used.has(c)) ?? PICK_COLOURS[1];
  set({ underlying, expiry, picks: [...picks, { strike, colour }] });
}

export function clearPicks(): void {
  set({ ...state, picks: [] });
}
