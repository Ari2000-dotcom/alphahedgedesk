import { useEffect, useState } from "react";

import type { Hub } from "../hub/client";
import type { Underlying } from "../hub/types";

/**
 * Every underlying a plain picker may show — NSE/BSE indices and every MCX
 * commodity, as the hub's own `universe` op already narrows it — fetched once
 * and shared by every open panel, nearest expiry first.
 *
 * A hub a swap has not yet reached (small, swappable: the frontend and the hub
 * it is talking to can briefly be two different builds) answers `universe`
 * with "unknown variant": `FALLBACK_NAMES` through the older `search` op
 * keeps the picker usable, rather than empty, until the hub it is pointed at
 * is current.
 */

/** Names a hub without `universe` can still be asked for by name, one `search` each. */
const FALLBACK_NAMES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "CRUDEOIL", "NATURALGAS", "GOLD", "SILVER", "COPPER", "ZINC"];

async function fallbackUniverse(hub: Hub): Promise<Underlying[]> {
  const hits = await Promise.all(
    FALLBACK_NAMES.map((q) =>
      hub.request<{ results: Underlying[] }>({ op: "search", q }, "search").then(
        (r) => r.results.find((u) => u.name === q) ?? null,
        () => null,
      ),
    ),
  );
  const seen = new Set<string>();
  const out: Underlying[] = [];
  for (const u of hits) {
    if (u && !seen.has(u.id)) {
      seen.add(u.id);
      out.push(u);
    }
  }
  return out;
}

function byNearestExpiry(list: readonly Underlying[]): Underlying[] {
  return [...list].sort((a, b) => (a.expiries[0] ?? "").localeCompare(b.expiries[0] ?? ""));
}

let cached: Promise<Underlying[]> | null = null;
const KEEP_MS = 30 * 60_000;

function fetchUniverse(hub: Hub): Promise<Underlying[]> {
  if (!cached) {
    cached = hub
      .request<{ results: Underlying[] }>({ op: "universe" }, "universe")
      .then((r) => r.results)
      .catch(() => fallbackUniverse(hub))
      .then(byNearestExpiry);
    cached.catch(() => {
      cached = null;
    });
    setTimeout(() => {
      cached = null;
    }, KEEP_MS);
  }
  return cached;
}

/** The picker's list for this tab: empty until the hub answers, then every pick it allows. */
export function useUniverse(hub: Hub): Underlying[] {
  const [list, setList] = useState<Underlying[]>([]);
  const [connected, setConnected] = useState(hub.state === "open");
  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    fetchUniverse(hub)
      .then((r) => !cancelled && setList(r))
      .catch(() => !cancelled && setList([]));
    return () => {
      cancelled = true;
    };
  }, [hub, connected]);
  return list;
}
