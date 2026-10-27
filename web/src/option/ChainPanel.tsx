import { useEffect, useMemo, useRef, useState } from "react";

import { fmt2 } from "../core/format";
import { ATM_COLOUR, MAX_STRADDLES, clearPicks, countFor, picksFor, togglePick, useCompare } from "../desk/compare";
import type { Hub } from "../hub/client";
import type { Underlying } from "../hub/types";
import { PICK_EVENT, readPick, type Pick } from "../straddle/StraddlePage";
import { Dropdown } from "../ui/Dropdown";
import { CheckIcon, CloseIcon, PlusIcon, SearchIcon } from "../ui/icons";
import { useChain } from "./useChain";
import "./chain.css";

const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];
const NARROW = 460;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (ymd: string) => {
  const [, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
};
const daysTo = (ymd: string) => {
  const n = Math.round((new Date(`${ymd}T12:00:00+05:30`).getTime() - Date.now()) / 86_400_000);
  return n <= 0 ? "0D" : `${n}D`;
};
const iv = (v: number | null) => (v === null ? "—" : v.toFixed(1));

/**
 * One option chain: the strikes around the money with each leg's price, the straddle at that
 * strike (call + put) and the leg's IV; "+" on a row puts that straddle on the chart beside the
 * ATM one (up to five), "✓" takes it off. Shaded rows are in the money.
 */
export function ChainPanel({
  hub,
  initialPick,
  onPick,
}: Readonly<{ hub: Hub; initialPick?: Pick | null; onPick?: (pick: Pick | null) => void }>) {
  const [pick, setPick] = useState<Pick | null>(() => (initialPick ? initialPick : readPick()));
  // Until the chain's own search is used, it follows whatever the charts last picked.
  const own = useRef(Boolean(initialPick));
  useEffect(() => {
    const follow = () => {
      if (!own.current) setPick(readPick());
    };
    window.addEventListener(PICK_EVENT, follow);
    return () => window.removeEventListener(PICK_EVENT, follow);
  }, []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Underlying[]>([]);
  const [active, setActive] = useState(0);
  /** What the search is doing, so the box never looks dead: "", searching, none, or an error. */
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [connected, setConnected] = useState(hub.state === "open");
  const [narrow, setNarrow] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const spotRow = useRef<HTMLDivElement>(null);
  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  useEffect(() => {
    onPick?.(pick);
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  // The panel's width picks its columns: IV columns only when there is room for them.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? NARROW) < NARROW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      setNote("Not connected to the hub yet");
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
    own.current = true;
    setPick({ underlying: u, expiry: u.expiries[0] ?? "", day: "live" });
    setQuery("");
    setResults([]);
  };
  const quick = (name: string) =>
    hub
      .request<{ results: Underlying[] }>({ op: "search", q: name }, "search")
      .then((r) => r.results[0] && choose(r.results[0]))
      .catch(() => setQuery(name));

  const id = pick?.underlying.id ?? "";
  const expiry = pick?.expiry ?? "";
  const chain = useChain(hub, id, expiry);
  const compare = useCompare();
  const picks = picksFor(compare, id, expiry);
  const count = countFor(compare, id, expiry);
  const full = count >= MAX_STRADDLES;
  const colourOf = useMemo(() => new Map(picks.map((p) => [p.strike, p.colour])), [picks]);

  // Keep the money in view as the strikes come in.
  const centred = useRef("");
  useEffect(() => {
    if (chain.rows.length === 0 || centred.current === `${id}|${expiry}`) return;
    centred.current = `${id}|${expiry}`;
    spotRow.current?.scrollIntoView({ block: "center" });
  }, [chain.rows.length, id, expiry]);

  const exchange = id ? id.split(":")[0]!.toUpperCase() : "";
  const spotAt = chain.spot === null ? -1 : chain.rows.findIndex((r) => r.strike > chain.spot!);

  return (
    <div className="mh-chain" ref={box} data-narrow={narrow || undefined}>
      <div className="mh-chain-strip">
        <div className="mh-chain-find" data-has-pick={pick ? "" : undefined} onClick={() => input.current?.focus()}>
          <SearchIcon size={14} />
          <input
            ref={input}
            className="mh-chain-input"
            value={query}
            placeholder={pick ? `${pick.underlying.name}  ${exchange}` : "Search: nifty, sensex, crudeoil"}
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
          {query ? (
            <button type="button" className="mh-chain-clear" aria-label="Clear" onClick={() => setQuery("")}>
              <CloseIcon size={12} />
            </button>
          ) : null}
          {results.length === 0 && note ? (
            <div className="mh-menu mh-chain-results mh-chain-note" role="status">
              {note}
            </div>
          ) : null}
          {results.length > 0 ? (
            <ul className="mh-menu mh-chain-results" role="listbox">
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
            value={expiry}
            onChange={(e) => {
              own.current = true;
              setPick({ ...pick, expiry: e });
            }}
            options={pick.underlying.expiries.map((e) => ({ value: e, label: shortDate(e), note: daysTo(e) }))}
          />
        ) : null}
        <span className="mh-spacer" />
        {chain.spot !== null ? <span className="mh-chain-spot">{fmt2(chain.spot)}</span> : null}
      </div>

      {!pick ? (
        <div className="mh-empty">
          <div className="mh-empty-title">Pick an underlying</div>
          <div className="mh-empty-text">Its option chain, with the straddle at every strike.</div>
          <div className="mh-quick">
            {QUICK.map((name) => (
              <button key={name} type="button" className="mh-btn" disabled={!connected} onClick={() => void quick(name)}>
                {name}
              </button>
            ))}
          </div>
        </div>
      ) : chain.error ? (
        <div className="mh-empty">
          <div className="mh-empty-title">Nothing to show</div>
          <div className="mh-empty-text">{chain.error}</div>
        </div>
      ) : (
        <>
          <div className="mh-chain-head" role="row">
            {narrow ? null : <span>IV</span>}
            <span>LTP</span>
            <span className="mh-chain-mid">Strike</span>
            <span className="mh-chain-mid mh-chain-straddle">Straddle</span>
            <span className="mh-chain-mid" />
            <span className="mh-chain-put">LTP</span>
            {narrow ? null : <span className="mh-chain-put">IV</span>}
          </div>
          <div className="mh-chain-body">
            {chain.rows.length === 0 ? <div className="mh-chain-wait">{chain.loading ? "Loading the strikes…" : "Waiting for prices…"}</div> : null}
            {chain.rows.map((r, i) => {
              const colour = colourOf.get(r.strike);
              const isAtm = r.strike === chain.atm;
              const on = isAtm || colour !== undefined;
              const shownColour = isAtm ? ATM_COLOUR : colour;
              return (
                <div key={r.strike}>
                  {i === spotAt ? (
                    <div className="mh-chain-spotrow" ref={spotRow}>
                      <span />
                      <b>
                        {pick.underlying.name} {fmt2(chain.spot!)}
                      </b>
                      <span />
                    </div>
                  ) : null}
                  <div className={on ? "mh-chain-row mh-picked" : "mh-chain-row"} role="row">
                    {narrow ? null : <span className={chain.spot !== null && r.strike < chain.spot ? "mh-itm" : undefined}>{iv(r.ceIv)}</span>}
                    <span className={chain.spot !== null && r.strike < chain.spot ? "mh-itm mh-ltp" : "mh-ltp"}>{r.ce === null ? "—" : fmt2(r.ce)}</span>
                    <span className="mh-chain-mid mh-strike">
                      {r.strike.toLocaleString("en-IN")}
                      {isAtm ? <em>ATM</em> : null}
                    </span>
                    <span className="mh-chain-mid mh-chain-straddle">
                      <i style={{ background: shownColour ?? "transparent" }} />
                      {r.straddle === null ? "—" : fmt2(r.straddle)}
                    </span>
                    <span className="mh-chain-mid">
                      <button
                        type="button"
                        className="mh-chain-pick"
                        aria-pressed={on}
                        disabled={isAtm || (full && !on)}
                        style={shownColour ? { color: shownColour } : undefined}
                        aria-label={`${on ? "Remove" : "Add"} the ${r.strike} straddle`}
                        onClick={() => togglePick(id, expiry, r.strike)}
                      >
                        {on ? <CheckIcon size={11} /> : <PlusIcon size={11} />}
                      </button>
                    </span>
                    <span className={chain.spot !== null && r.strike > chain.spot ? "mh-itm mh-ltp mh-chain-put" : "mh-ltp mh-chain-put"}>{r.pe === null ? "—" : fmt2(r.pe)}</span>
                    {narrow ? null : <span className={chain.spot !== null && r.strike > chain.spot ? "mh-itm mh-chain-put" : "mh-chain-put"}>{iv(r.peIv)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mh-chain-foot">
            <span>
              {count} of {MAX_STRADDLES} straddles on the chart
            </span>
            <span className="mh-spacer" />
            <button type="button" className="mh-link-btn" onClick={clearPicks} disabled={picks.length === 0}>
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}
