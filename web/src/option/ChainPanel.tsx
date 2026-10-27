import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { impliedVol, yearsToExpiry } from "../core/black76";
import { fmt2, nearestExpiry } from "../core/format";
import { ATM_COLOUR, MAX_STRADDLES, clearPicks, countFor, picksFor, togglePick, useCompare } from "../desk/compare";
import type { Hub } from "../hub/client";
import type { Underlying } from "../hub/types";
import { freshPick, PICK_EVENT, readPick, type Pick } from "../straddle/StraddlePage";
import { Dropdown } from "../ui/Dropdown";
import { CheckIcon, CloseIcon, PlusIcon, SearchIcon, Spinner } from "../ui/icons";
import { useQuote } from "./quotes";
import { useChain, type ChainRow } from "./useChain";
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
  const [pick, setPick] = useState<Pick | null>(() => (initialPick ? freshPick(initialPick) : readPick()));
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
  const scroller = useRef<HTMLDivElement>(null);
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
    setPick({ underlying: u, expiry: nearestExpiry(u.expiries), day: "live" });
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
  const toggle = useCallback((strike: number) => togglePick(id, expiry, strike), [id, expiry]);

  // The money row in the middle of the view, once per chain, as it is drawn.
  const ROW_H = 34;
  const HEAD_H = 30;
  const reportView = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const first = Math.floor((box.scrollTop - 0) / ROW_H);
    const last = Math.ceil((box.scrollTop + box.clientHeight - HEAD_H) / ROW_H);
    chain.onView(first, last);
  }, [chain.onView]); // eslint-disable-line react-hooks/exhaustive-deps
  const scrolledFor = useRef("");
  useLayoutEffect(() => {
    if (!chain.ready || !chain.scrollKey || scrolledFor.current === chain.scrollKey) return;
    const box = scroller.current;
    const atm = box?.querySelector<HTMLElement>(".mh-atm");
    if (box && atm) {
      box.scrollTop = atm.offsetTop - box.clientHeight / 2 + atm.offsetHeight / 2;
      scrolledFor.current = chain.scrollKey;
      reportView();
    }
  }, [chain.ready, chain.scrollKey, chain.rows]);

  // The forward for IV: call - put + strike at the money, settled to once a second so IV does not
  // redraw every cell on every tick.
  const atmRow = chain.rows.find((r) => r.strike === chain.atm);
  const atmCe = useQuote(atmRow?.callId ?? "");
  const atmPe = useQuote(atmRow?.putId ?? "");
  const forward = useSettled(atmRow && atmCe !== undefined && atmPe !== undefined ? atmCe - atmPe + atmRow.strike : null, 1000);
  const mcx = id.startsWith("mcx:");
  const years = Math.round(yearsToExpiry(expiry, mcx) * 525_600) / 525_600;

  const exchange = id ? id.split(":")[0]!.toUpperCase() : "";

  return (
    <div className="mh-chain" ref={box} data-narrow={narrow || undefined}>
      <div className="mh-chain-strip">
        <div className="mh-chain-find" data-has-pick={pick ? "" : undefined} onClick={() => input.current?.focus()}>
          <SearchIcon size={14} />
          <input
            ref={input}
            className="mh-chain-input"
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
            <span className="mh-chain-subject" aria-hidden>
              {pick.underlying.name} <span className="mh-chip">{exchange}</span>
            </span>
          ) : null}
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
        {chain.spot !== null ? (
          <span className="mh-chain-spot">
            {pick?.underlying.name} <b>{fmt2(chain.spot)}</b>
          </span>
        ) : null}
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
      ) : !chain.ready ? (
        <div className="mh-chain-wait" aria-busy>
          <Spinner size={18} />
          <span>
            {chain.waiting === "Loading prices" ? `Loading ${pick.underlying.name} ${shortDate(expiry)} prices` : `${chain.waiting}${chain.waiting === "Finding the price" ? ` of ${pick.underlying.name}` : ""}`}
          </span>
          {chain.total > 0 ? (
            <span className="mh-chain-progress">
              {chain.priced} of {chain.total}
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <div className="mh-chain-scroll" ref={scroller} onScroll={reportView}>
            <table className="mh-chain-table">
              <colgroup>
                {narrow ? null : <col className="mh-col-iv" />}
                <col />
                <col className="mh-col-strike" />
                <col className="mh-col-straddle" />
                <col className="mh-col-add" />
                <col />
                {narrow ? null : <col className="mh-col-iv" />}
              </colgroup>
              <thead>
                <tr>
                  {narrow ? null : <th className="mh-th-ce">Call IV</th>}
                  <th className="mh-th-ce">Call LTP</th>
                  <th>Strike</th>
                  <th className="mh-th-ce">Straddle</th>
                  <th />
                  <th className="mh-th-pe">Put LTP</th>
                  {narrow ? null : <th className="mh-th-pe">Put IV</th>}
                </tr>
              </thead>
              <tbody>
                {chain.rows.map((row) => (
                  <Row
                    key={row.strike}
                    row={row}
                    atm={row.strike === chain.atm}
                    ceItm={chain.spot !== null && row.strike < chain.spot}
                    peItm={chain.spot !== null && row.strike > chain.spot}
                    narrow={narrow}
                    colour={row.strike === chain.atm ? ATM_COLOUR : colourOf.get(row.strike)}
                    disabled={full}
                    forward={forward}
                    years={years}
                    onToggle={toggle}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mh-chain-foot">
            <span>
              {count} of {MAX_STRADDLES} straddles on the chart
            </span>
            {chain.limited ? (
              <span className="mh-chain-limit" title="The hub lets each visitor hold only so many live prices, so rows far from the view wait to be scrolled to. Raising max_topics in its config.toml keeps more of them live.">
                Live prices near the view: hub limit
              </span>
            ) : null}
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

/** A value that follows `value` at most once per `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, ms - (Date.now() - last.current));
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

const money = (v: number | undefined) => (v === undefined ? "—" : fmt2(v));
const vol = (v: number | null) => (v === null ? "—" : v.toFixed(1));

/**
 * One strike. Each price cell reads only its own contract from the quote store, so a tick redraws
 * this row and no other; the row is memoised on plain values, so the table is not redrawn by it.
 */
const Row = memo(function Row({
  row,
  atm,
  ceItm,
  peItm,
  narrow,
  colour,
  disabled,
  forward,
  years,
  onToggle,
}: Readonly<{
  row: ChainRow;
  atm: boolean;
  ceItm: boolean;
  peItm: boolean;
  narrow: boolean;
  /** The straddle's colour on the chart when it is on it. */
  colour: string | undefined;
  /** Five on the chart already: no more can be added. */
  disabled: boolean;
  forward: number | null;
  years: number;
  onToggle: (strike: number) => void;
}>) {
  const ce = useQuote(row.callId);
  const pe = useQuote(row.putId);
  const straddle = ce !== undefined && pe !== undefined ? ce + pe : null;
  const ceIv = forward !== null && ce !== undefined ? impliedVol(ce, forward, row.strike, years, true) : null;
  const peIv = forward !== null && pe !== undefined ? impliedVol(pe, forward, row.strike, years, false) : null;
  const on = atm || colour !== undefined;
  return (
    <tr className={atm ? "mh-atm" : undefined}>
      {narrow ? null : <td className={ceItm ? "mh-ce mh-itm mh-quiet" : "mh-ce mh-quiet"}>{vol(ceIv)}</td>}
      <td className={ceItm ? "mh-ce mh-itm" : "mh-ce"}>
        <span className="mh-ltp">{money(ce)}</span>
      </td>
      <td className="mh-strike">{row.strike.toLocaleString("en-IN")}</td>
      <td className="mh-straddle">
        <i style={{ background: on ? colour : "transparent" }} />
        <span className={on ? "mh-on" : undefined}>{straddle === null ? "—" : fmt2(straddle)}</span>
      </td>
      <td className="mh-add">
        <button
          type="button"
          className="mh-chain-pick"
          aria-pressed={on}
          disabled={atm || (disabled && !on)}
          style={on && colour ? { color: colour } : undefined}
          aria-label={`${on ? "Remove" : "Add"} the ${row.strike} straddle`}
          onClick={() => onToggle(row.strike)}
        >
          {on ? <CheckIcon size={11} /> : <PlusIcon size={11} />}
        </button>
      </td>
      <td className={peItm ? "mh-pe mh-itm" : "mh-pe"}>
        <span className="mh-ltp">{money(pe)}</span>
      </td>
      {narrow ? null : <td className={peItm ? "mh-pe mh-itm mh-quiet" : "mh-pe mh-quiet"}>{vol(peIv)}</td>}
    </tr>
  );
});
