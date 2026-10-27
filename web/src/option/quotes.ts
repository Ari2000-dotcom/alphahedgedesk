import { useSyncExternalStore } from "react";

/**
 * Live option prices, one listener set per contract: a tick redraws the one cell that shows it,
 * not the whole table (AlphaHedge's chain works the same way). Prices live here, outside React,
 * and each cell reads only its own contract.
 */

const prices = new Map<string, number>();
const byId = new Map<string, Set<() => void>>();
const everyone = new Set<() => void>();

export const priceOf = (id: string): number | undefined => prices.get(id);

export function setPrice(id: string, price: number): void {
  if (prices.get(id) === price) return;
  prices.set(id, price);
  byId.get(id)?.forEach((fn) => fn());
  everyone.forEach((fn) => fn());
}

function subscribe(id: string, fn: () => void): () => void {
  let set = byId.get(id);
  if (!set) byId.set(id, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) byId.delete(id);
  };
}

/** One contract's last price; the component re-renders only when this one changes. */
export const useQuote = (id: string): number | undefined =>
  useSyncExternalStore(
    (fn) => subscribe(id, fn),
    () => prices.get(id),
  );

/** How many of `ids` have a price: re-renders only when that count changes. */
export function usePricedCount(ids: readonly string[]): number {
  return useSyncExternalStore(
    (fn) => {
      everyone.add(fn);
      return () => everyone.delete(fn);
    },
    () => {
      let n = 0;
      for (const id of ids) if (prices.has(id)) n++;
      return n;
    },
  );
}
