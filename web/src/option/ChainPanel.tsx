import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { impliedVol, yearsToExpiry } from "../core/black76";
import { fmt2 } from "../core/format";
import { ATM_COLOUR, MAX_STRADDLES, clearPicks, countFor, picksFor, togglePick, useCompare } from "../desk/compare";
import type { Hub } from "../hub/client";
import type { Pick } from "../straddle/StraddlePage";
import { CheckIcon, PlusIcon, Spinner } from "../ui/icons";
import { PickStrip, QuickPicks, shortDate, useFollowedPick } from "./PickStrip";
import { useQuote } from "./quotes";
import { useChain, type ChainRow } from "./useChain";
import "./chain.css";

const NARROW = 460;

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
  const [pick, setPick] = useFollowedPick(initialPick);
  const [connected, setConnected] = useState(hub.state === "open");
  const [narrow, setNarrow] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

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

  return (
    <div className="mh-chain" ref={box} data-narrow={narrow || undefined}>
      <PickStrip hub={hub} pick={pick} onPick={setPick} spot={chain.spot} />

      {!pick ? (
        <div className="mh-empty">
          <div className="mh-empty-title">Pick an underlying</div>
          <div className="mh-empty-text">Its option chain, with the straddle at every strike.</div>
          <QuickPicks hub={hub} onPick={setPick} disabled={!connected} />
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
