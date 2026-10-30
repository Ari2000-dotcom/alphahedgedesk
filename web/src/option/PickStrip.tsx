import { useEffect, useRef, useState, type ReactNode } from "react";

import { fmt2, nearestExpiry } from "../core/format";
import type { Hub } from "../hub/client";
import type { Underlying } from "../hub/types";
import { freshPick, PICK_EVENT, readPick, type Pick } from "../straddle/StraddlePage";
import { Dropdown } from "../ui/Dropdown";
import { CloseIcon, SearchIcon } from "../ui/icons";
import "./pick.css";

/**
 * The strip every option panel opens with (the chain's, and the delta x OI panel's): a search box
 * for the underlying, the expiry beside it, the spot at its right end, and whatever else the panel
 * wants after that.
 *
 * Until its own search is used, a panel follows whatever the charts last picked, so a desk of
 * panels moves together; the first search, quick button or expiry change makes it the panel's own
 * (`useFollowedPick`), and from then on it stays where it was put.
 */

const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (ymd: string) => {
  const [, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
};
export const daysTo = (ymd: string) => {
  const n = Math.round((new Date(`${ymd}T12:00:00+05:30`).getTime() - Date.now()) / 86_400_000);
  return n <= 0 ? "0D" : `${n}D`;
};

/**
 * A panel's pick: the charts' last one until this panel is given one of its own, and that one from
 * then on. `setOwn` is what a search, a quick button or an expiry change calls.
 */
export function useFollowedPick(initialPick?: Pick | null): [Pick | null, (pick: Pick | null) => void] {
  const [pick, setPick] = useState<Pick | null>(() => (initialPick ? freshPick(initialPick) : readPick()));
  const own = useRef(Boolean(initialPick));
  useEffect(() => {
    const follow = () => {
      if (!own.current) setPick(readPick());
    };
    window.addEventListener(PICK_EVENT, follow);
    return () => window.removeEventListener(PICK_EVENT, follow);
  }, []);
  const setOwn = (next: Pick | null) => {
    own.current = true;
    setPick(next);
  };
  return [pick, setOwn];
}

/** Asks the hub for `name` and picks the first match; a failed search leaves the panel as it was. */
export function quickPick(hub: Hub, name: string, onPick: (pick: Pick) => void): Promise<void> {
  return hub
    .request<{ results: Underlying[] }>({ op: "search", q: name }, "search")
    .then((r) => {
      const u = r.results[0];
      if (u) onPick({ underlying: u, expiry: nearestExpiry(u.expiries), day: "live" });
    })
    .catch(() => undefined);
}

/** The row of well-known underlyings an empty panel offers. */
export function QuickPicks({ hub, onPick, disabled }: Readonly<{ hub: Hub; onPick: (pick: Pick) => void; disabled?: boolean }>) {
  return (
    <div className="mh-quick">
      {QUICK.map((name) => (
        <button key={name} type="button" className="mh-btn" disabled={disabled} onClick={() => void quickPick(hub, name, onPick)}>
          {name}
        </button>
      ))}
    </div>
  );
}

export function PickStrip({
  hub,
  pick,
  onPick,
  spot,
  children,
}: Readonly<{
  hub: Hub;
  pick: Pick | null;
  onPick: (pick: Pick) => void;
  /** Shown at the right end beside the underlying's name, when it is known. */
  spot?: number | null;
  /** Anything the panel wants after the spot (a band picker, a unit toggle). */
  children?: ReactNode;
}>) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Underlying[]>([]);
  const [active, setActive] = useState(0);
  /** What the search is doing, so the box never looks dead: "", searching, none, or an error. */
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [connected, setConnected] = useState(hub.state === "open");
  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setNote("");
      return;
    }
    if (q.length < 2) {
      setResults([]);
      setNote("Type at least 2 letters");
      return;
    }
    if (!connected) {
      setResults([]);
      setNote("Connecting to the data feed…");
      return;
    }
    let cancelled = false;
    setNote("Searching…");
    const timer = setTimeout(() => {
      hub
        .request<{ results: Underlying[] }>({ op: "search", q }, "search", 20_000)
        .then((r) => {
          if (cancelled) return;
          setResults(r.results);
          setNote(r.results.length === 0 ? `No underlying matches “${q}”` : "");
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setResults([]);
          setNote(`Search failed: ${e.message}`);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, hub, connected]);

  const choose = (u: Underlying) => {
    onPick({ underlying: u, expiry: nearestExpiry(u.expiries), day: "live" });
    setQuery("");
    setResults([]);
  };
  const exchange = pick ? pick.underlying.id.split(":")[0]!.toUpperCase() : "";

  return (
    <div className="mh-pick-strip">
      <div className="mh-pick-find" data-has-pick={pick ? "" : undefined} onClick={() => input.current?.focus()}>
        <SearchIcon size={14} />
        <input
          ref={input}
          className="mh-pick-input"
          value={query}
          placeholder={pick ? "" : "Search: nifty, sensex, crudeoil"}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && results.length > 0) {
              e.preventDefault();
              setActive((i) => (i + 1) % results.length);
            } else if (e.key === "ArrowUp" && results.length > 0) {
              e.preventDefault();
              setActive((i) => (i - 1 + results.length) % results.length);
            } else if (e.key === "Enter" && results[active]) {
              choose(results[active]!);
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setQuery("");
              setResults([]);
              e.currentTarget.blur();
            }
          }}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-label="Search an underlying"
        />
        {pick && !query ? (
          <span className="mh-pick-subject" aria-hidden>
            <span className="mh-pick-subject-name">{pick.underlying.name}</span> <span className="mh-chip">{exchange}</span>
          </span>
        ) : null}
        {query ? (
          <button type="button" className="mh-pick-clear" aria-label="Clear" onClick={() => setQuery("")}>
            <CloseIcon size={12} />
          </button>
        ) : null}
        {results.length === 0 && note ? (
          <div className="mh-menu mh-pick-results mh-pick-note" role="status">
            {note}
          </div>
        ) : null}
        {results.length > 0 ? (
          <ul className="mh-menu mh-pick-results" role="listbox">
            {results.map((u, i) => (
              <li
                key={u.id}
                className={i === active ? "mh-menu-item mh-active" : "mh-menu-item"}
                role="option"
                aria-selected={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={(e) => {
                  e.stopPropagation();
                  choose(u);
                }}
              >
                <span className="mh-menu-text">{u.name}</span>
                <span className="mh-chip">{u.id.split(":")[0]!.toUpperCase()}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {pick ? (
        <Dropdown
          label="Expiry"
          value={pick.expiry}
          onChange={(e) => onPick({ ...pick, expiry: e })}
          options={pick.underlying.expiries.map((e) => ({ value: e, label: shortDate(e), note: daysTo(e) }))}
        />
      ) : null}
      <span className="mh-spacer" />
      {spot !== null && spot !== undefined ? (
        <span className="mh-pick-spot">
          <span className="mh-pick-spot-name">{pick?.underlying.name} </span>
          <b>{fmt2(spot)}</b>
        </span>
      ) : null}
      {children}
    </div>
  );
}
