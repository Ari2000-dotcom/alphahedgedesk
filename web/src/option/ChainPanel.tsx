import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { impliedVol, yearsToExpiry } from "../core/black76";
import { fmt2, nearestExpiry } from "../core/format";
import { ATM_COLOUR, MAX_STRADDLES, clearPicks, countFor, picksFor, togglePick, useCompare } from "../desk/compare";
import { useSummaries } from "../desk/summary";
import type { Hub } from "../hub/client";
import type { Underlying } from "../hub/types";
import { freshPick, PICK_EVENT, readPick, type Pick } from "../straddle/StraddlePage";
import { Dropdown } from "../ui/Dropdown";
import { CheckIcon, PlusIcon, Spinner } from "../ui/icons";
import { useUniverse } from "../core/universe";
import { useQuote } from "./quotes";
import { useChain, type ChainRow } from "./useChain";
import "./chain.css";

const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];
/** Below this the IV columns go: under it the seven columns cannot all hold their numbers. */
const NARROW = 580;
/** Below this the cells tighten (smaller insets, slimmer strike and straddle columns). */
const COMPACT = 400;
/** A row's height and the header's (chain.css), which place every row without drawing it. */
const ROW_H = 34;
const HEAD_H = 30;
/** Rows drawn past each edge of the view, and the step the drawn range moves in. */
const DRAW_MARGIN = 12;
const DRAW_STEP = 8;

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
  // The width's tier, not the width: a splitter drag changes the width every frame, and the chain
  // re-renders only when it crosses into another tier.
  const [tier, setTier] = useState<"wide" | "narrow" | "compact">("wide");
  const narrow = tier !== "wide";
  const compact = tier === "compact";
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const universe = useUniverse(hub);
  const underlyingOf = useMemo(() => new Map(universe.map((u) => [u.id, u] as const)), [universe]);
  // The underlying in view is always on the list, so the picker names it rather than "Pick an
  // underlying": before the hub's universe answers, and from a hub that has no `universe` op.
  const underlyingOptions = useMemo(() => {
    const option = (u: Underlying) => ({ value: u.id, label: u.name, note: `${daysTo(nearestExpiry(u.expiries))} · ${u.id.split(":")[0]!.toUpperCase()}` });
    const list = universe.map(option);
    return pick && !underlyingOf.has(pick.underlying.id) ? [option(pick.underlying), ...list] : list;
  }, [universe, underlyingOf, pick]);

  useEffect(() => {
    onPick?.(pick);
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  // The panel's width picks its columns: IV columns only when there is room for them.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? NARROW;
      setTier(width < COMPACT ? "compact" : width < NARROW ? "narrow" : "wide");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const choose = (u: Underlying) => {
    own.current = true;
    setPick({ underlying: u, expiry: nearestExpiry(u.expiries), day: "live" });
  };
  const quick = (name: string) => {
    const u = universe.find((x) => x.name === name);
    if (u) choose(u);
  };

  const id = pick?.underlying.id ?? "";
  const expiry = pick?.expiry ?? "";
  const chain = useChain(hub, id, expiry);
  const compare = useCompare();
  const picks = picksFor(compare, id, expiry);
  const count = countFor(compare, id, expiry);
  const full = count >= MAX_STRADDLES;
  const colourOf = useMemo(() => new Map(picks.map((p) => [p.strike, p.colour])), [picks]);
  const toggle = useCallback((strike: number) => togglePick(id, expiry, strike), [id, expiry]);
  // The straddle a live chart of this pair is drawing. The hub keeps the cheapest straddle within
  // two strikes of the money, which is not always the strike nearest spot (the underlined one); with
  // no live chart open on the pair, the nearest strike stands in.
  const summaries = useSummaries();
  const onChart = summaries.find((s) => s.key === `${id}|${expiry}`)?.last.strike ?? chain.atm;

  // Only the rows in view are drawn, with a margin either side, and spacers above and below keep
  // the scroll height: every strike drawn at once was two hundred rows relaid and repainted on
  // each frame of a splitter drag, which is what made dragging next to a chain lag. Rows are a
  // fixed 34 px, so where any row sits is known without drawing it.
  const [drawn, setDrawn] = useState<readonly [number, number]>([0, 2 * DRAW_MARGIN]);
  const reportView = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const first = Math.floor(box.scrollTop / ROW_H);
    const last = Math.ceil((box.scrollTop + box.clientHeight - HEAD_H) / ROW_H);
    chain.onView(first, last);
    // In steps of a few rows, so scrolling re-renders the table now and then, not on every pixel.
    const from = Math.max(0, Math.floor((first - DRAW_MARGIN) / DRAW_STEP) * DRAW_STEP);
    const to = Math.ceil((last + DRAW_MARGIN) / DRAW_STEP) * DRAW_STEP;
    setDrawn((d) => (d[0] === from && d[1] === to ? d : [from, to]));
  }, [chain.onView]); // eslint-disable-line react-hooks/exhaustive-deps
  // A taller or shorter panel shows more or fewer rows.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const ro = new ResizeObserver(() => reportView());
    ro.observe(box);
    return () => ro.disconnect();
  }, [reportView, chain.ready]);
  // The money row in the middle of the view, once per chain, as it is drawn.
  const scrolledFor = useRef("");
  useLayoutEffect(() => {
    if (!chain.ready || !chain.scrollKey || scrolledFor.current === chain.scrollKey) return;
    const box = scroller.current;
    const atm = chain.rows.findIndex((r) => r.strike === chain.atm);
    if (box && atm >= 0) {
      box.scrollTop = HEAD_H + atm * ROW_H - box.clientHeight / 2 + ROW_H / 2;
      scrolledFor.current = chain.scrollKey;
      reportView();
    }
  }, [chain.ready, chain.scrollKey, chain.rows]);
  const drawFrom = Math.min(drawn[0], chain.rows.length);
  const drawTo = Math.min(drawn[1] + 1, chain.rows.length);
  const columns = narrow ? 5 : 7;

  // The forward for IV: call - put + strike at the money, settled to once a second so IV does not
  // redraw every cell on every tick.
  const atmRow = chain.rows.find((r) => r.strike === chain.atm);
  const atmCe = useQuote(atmRow?.callId ?? "");
  const atmPe = useQuote(atmRow?.putId ?? "");
  const forward = useSettled(atmRow && atmCe !== undefined && atmPe !== undefined ? atmCe - atmPe + atmRow.strike : null, 1000);
  const mcx = id.startsWith("mcx:");
  const years = Math.round(yearsToExpiry(expiry, mcx) * 525_600) / 525_600;

  return (
    <div className="mh-chain" ref={box} data-narrow={narrow || undefined} data-compact={compact || undefined}>
      <div className="mh-chain-strip">
        <Dropdown
          label="Underlying"
          caption={false}
          value={id}
          onChange={(pickedId) => {
            const u = underlyingOf.get(pickedId);
            if (u) choose(u);
          }}
          renderValue={(o) =>
            o ? (
              <>
                {o.label} <span className="mh-chip">{o.value.split(":")[0]!.toUpperCase()}</span>
              </>
            ) : (
              "Pick an underlying"
            )
          }
          options={underlyingOptions}
        />
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
              <button key={name} type="button" className="mh-btn" disabled={universe.length === 0} onClick={() => quick(name)}>
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
              {/* With IV, each leg's price keeps a fixed column and its IV takes the slack on the
                  outside, so a row's numbers sit together around the strike instead of the IV
                  drifting to the panel's edge. */}
              <colgroup>
                {narrow ? null : <col />}
                <col className={narrow ? undefined : "mh-col-ltp"} />
                <col className="mh-col-strike" />
                <col className="mh-col-straddle" />
                <col className="mh-col-add" />
                <col className={narrow ? undefined : "mh-col-ltp"} />
                {narrow ? null : <col />}
              </colgroup>
              <thead>
                <tr>
                  {narrow ? null : <th className="mh-th-ce">Call IV</th>}
                  {/* Without the IV columns a leg has one number, so its name is enough. */}
                  <th className="mh-th-ce">{narrow ? "Call" : "Call LTP"}</th>
                  <th>Strike</th>
                  <th className="mh-th-ce">Straddle</th>
                  <th />
                  <th className="mh-th-pe">{narrow ? "Put" : "Put LTP"}</th>
                  {narrow ? null : <th className="mh-th-pe">Put IV</th>}
                </tr>
              </thead>
              <tbody>
                {drawFrom > 0 ? <Gap columns={columns} rows={drawFrom} /> : null}
                {chain.rows.slice(drawFrom, drawTo).map((row) => (
                  <Row
                    key={row.strike}
                    row={row}
                    atm={row.strike === chain.atm}
                    held={row.strike === onChart}
                    ceItm={chain.spot !== null && row.strike < chain.spot}
                    peItm={chain.spot !== null && row.strike > chain.spot}
                    narrow={narrow}
                    colour={row.strike === onChart ? ATM_COLOUR : colourOf.get(row.strike)}
                    disabled={full}
                    forward={forward}
                    years={years}
                    onToggle={toggle}
                  />
                ))}
                {drawTo < chain.rows.length ? <Gap columns={columns} rows={chain.rows.length - drawTo} /> : null}
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

/** The room `rows` undrawn rows would take, so the scrollbar and scroll position stay true. */
function Gap({ columns, rows }: Readonly<{ columns: number; rows: number }>) {
  return (
    <tr className="mh-chain-gap" aria-hidden>
      <td colSpan={columns} style={{ height: rows * ROW_H }} />
    </tr>
  );
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
  held,
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
  /** The strike nearest spot: underlined, and the row the chain opens centred on. */
  atm: boolean;
  /** The chart's own ATM straddle: on the chart already, so it cannot be added or removed here. */
  held: boolean;
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
  const on = held || colour !== undefined;
  return (
    <tr className={atm ? "mh-atm" : undefined}>
      {narrow ? null : <td className={ceItm ? "mh-ce mh-itm mh-quiet" : "mh-ce mh-quiet"}>{vol(ceIv)}</td>}
      <td className={ceItm ? "mh-ce mh-itm" : "mh-ce"}>
        <span className={ce === undefined ? "mh-none" : "mh-ltp"}>{money(ce)}</span>
      </td>
      <td className="mh-strike">{row.strike.toLocaleString("en-IN")}</td>
      <td className="mh-straddle">
        <i style={{ background: on ? colour : "transparent" }} />
        <span className={straddle === null ? "mh-none" : on ? "mh-on" : undefined}>{straddle === null ? "—" : fmt2(straddle)}</span>
      </td>
      <td className="mh-add">
        <button
          type="button"
          className="mh-chain-pick"
          aria-pressed={on}
          disabled={held || (disabled && !on)}
          style={on && colour ? { color: colour } : undefined}
          aria-label={held ? `The ${row.strike} straddle is the chart's ATM straddle` : `${on ? "Remove" : "Add"} the ${row.strike} straddle`}
          onClick={() => onToggle(row.strike)}
        >
          {on ? <CheckIcon size={11} /> : <PlusIcon size={11} />}
        </button>
      </td>
      <td className={peItm ? "mh-pe mh-itm" : "mh-pe"}>
        <span className={pe === undefined ? "mh-none" : "mh-ltp"}>{money(pe)}</span>
      </td>
      {narrow ? null : <td className={peItm ? "mh-pe mh-itm mh-quiet" : "mh-pe mh-quiet"}>{vol(peIv)}</td>}
    </tr>
  );
});
