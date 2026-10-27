import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { dayLabel, fmt0, fmt2, istDate, pastWeekdays } from "../core/format";
import type { Hub } from "../hub/client";
import type { Bar, StraddleSnapshot, StraddleUpdate, TopicMessage, Underlying } from "../hub/types";
import { Dropdown } from "../ui/Dropdown";
import { AlertIcon, ChartIcon, CloseIcon, PlusIcon, SearchIcon, Spinner } from "../ui/icons";
import { StraddleChart, toggleLine, useHidden, type HistoryStatus, type LineId } from "./StraddleChart";
import { ATM_COLOUR, MAX_STRADDLES } from "../desk/compare";
import "./chips.css";
import { picksFor, togglePick, useCompare } from "../desk/compare";
import { useStrikeLines } from "./useStrikeLines";
import { dropSummary, publishSummary } from "../desk/summary";

/**
 * Pick an underlying (any NSE, BSE or MCX name with options), an expiry, and
 * Today or one of the last three trading days.
 *
 * Today subscribes to `straddle:<underlying>:<expiry>`: the hub sends the
 * session so far (backfilled from the open the first time anyone opens it,
 * shared by everyone) and then one update a second. A past day is one request.
 */

const PAST_DAYS = 3;
const SEARCH_DELAY_MS = 200;
const LAST_PICK = "mh.straddle.pick";
/** Fired on this window when a chart picks something, so a chain beside it can follow. */
export const PICK_EVENT = "mh-pick";
const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];

type Day = "live" | string;

export interface Pick {
  underlying: Underlying;
  expiry: string;
  day: Day;
}

/** The last pick on this computer: a new tab opens on it when it has nothing of its own. */
export function readPick(): Pick | null {
  try {
    const raw = localStorage.getItem(LAST_PICK);
    return raw ? (JSON.parse(raw) as Pick) : null;
  } catch {
    return null;
  }
}

/** Puts `bar` in its minute: replaces that minute's bar, or adds it in order. */
function upsert(bars: Bar[], bar: Bar) {
  const last = bars[bars.length - 1];
  if (!last || last.t < bar.t) {
    bars.push(bar);
    return;
  }
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    if (b.t === bar.t) {
      bars[i] = bar;
      return;
    }
    if (b.t < bar.t) {
      bars.splice(i + 1, 0, bar);
      return;
    }
  }
  bars.unshift(bar);
}

/**
 * One straddle: the page a dock tab shows. Each tab has its own pick (underlying, expiry,
 * session), kept in the tab's own params so the saved layout brings it back; `onPick` hands each
 * change out for that. `autoPick` names an underlying a layout preset opens the tab on.
 * `active`: the tab in front of the focused container, the one "/" searches in.
 */
export function StraddlePage({
  hub,
  themeKey,
  initialPick,
  autoPick,
  active: inFront = true,
  onPick,
}: Readonly<{
  hub: Hub;
  themeKey: string;
  initialPick?: Pick | null;
  autoPick?: string;
  active?: boolean;
  onPick?: (pick: Pick | null) => void;
}>) {
  const [pick, setPick] = useState<Pick | null>(() => (initialPick !== undefined ? initialPick : readPick()));
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Underlying[]>([]);
  const [searching, setSearching] = useState(false);
  const [bars, setBars] = useState<Bar[]>([]);
  const [note, setNote] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [resync, setResync] = useState(0);
  const [connected, setConnected] = useState(hub.state === "open");

  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  useEffect(() => {
    try {
      if (pick) localStorage.setItem(LAST_PICK, JSON.stringify(pick));
      if (pick) window.dispatchEvent(new Event(PICK_EVENT));
    } catch {
      // Not remembering the last pick is fine.
    }
    onPickRef.current?.(pick);
  }, [pick]);

  /* -- search, debounced ---------------------------------------------------------------- */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !connected) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      hub
        .request<{ results: Underlying[] }>({ op: "search", q }, "search")
        .then((r) => !cancelled && setResults(r.results))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setSearching(false));
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, hub, connected]);

  const choose = (u: Underlying) => {
    setPick({ underlying: u, expiry: u.expiries[0] ?? "", day: "live" });
    setQuery("");
    setResults([]);
  };

  /* -- today: live topic ------------------------------------------------------------------ */
  const live = pick?.day === "live";
  const topic = pick ? `straddle:${pick.underlying.id}:${pick.expiry}` : "";
  const pending = useRef<Bar[] | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!pick || !live) return;
    setBars([]);
    setError("");
    setNote("Connecting…");
    let current: Bar[] = [];
    const flush = () => {
      frame.current = null;
      if (pending.current) {
        setBars(pending.current);
        pending.current = null;
      }
    };
    // At most one React render per display frame, however many updates arrive.
    const schedule = () => {
      pending.current = current.slice();
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    };
    const stop = hub.subscribe(topic, (msg: TopicMessage) => {
      if (msg.t === "straddle_snapshot") {
        const snap = msg as StraddleSnapshot;
        current = snap.bars.slice();
        setNote(
          snap.backfill === "loading"
            ? "Loading today from the open…"
            : snap.backfill.startsWith("failed")
              ? `Live only (morning unavailable: ${snap.backfill.slice(8)})`
              : "",
        );
        schedule();
      } else if (msg.t === "straddle") {
        const u = msg as StraddleUpdate;
        const finished = current.filter((b) => b.t < u.bar.t).length;
        if (u.n > finished + 1) {
          // Missed more than a minute (tab asleep): ask for the session again.
          setResync((n) => n + 1);
          return;
        }
        if (u.prev) upsert(current, u.prev);
        upsert(current, u.bar);
        schedule();
      } else if (msg.t === "err") {
        setError(String((msg as { error: string }).error));
        setNote("");
      }
    });
    return () => {
      stop();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = null;
    };
  }, [hub, topic, live, resync]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -- a past day: one plain HTTP request, so the browser keeps the answer (a past day never
     changes) and reopening it doesn't reach the hub at all --------------------------------------- */
  useEffect(() => {
    if (!pick || live) return;
    let cancelled = false;
    setBars([]);
    setError("");
    setNote("");
    setLoading(true);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 180_000);
    const q = new URLSearchParams({ underlying: pick.underlying.id, expiry: pick.expiry, date: pick.day });
    fetch(`/straddle_history?${q}`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        return (await res.json()) as { bars: Bar[] };
      })
      .then((r) => !cancelled && setBars(r.bars))
      .catch((e: Error) => !cancelled && setError(e.name === "AbortError" ? "the hub took too long; try again" : e.message))
      .finally(() => {
        clearTimeout(timer);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [pick, live]);

  /* -- earlier sessions, paged in on a pan back (openalgo-charts' lazy history) ------------------
     Panning to the first loaded minute asks for the trading day before it, newest first, and puts
     it in front; the chart keeps the same minutes in view. A day the hub has nothing for (a
     holiday: it answers 400) is skipped for the one before; a busy or unreachable hub stops with a
     Retry. The hub keeps the last PAST_DAYS trading days. */
  const [older, setOlder] = useState<{ day: string; bars: Bar[] }[]>([]);
  const [history, setHistory] = useState<HistoryStatus>("idle");
  const [historyDay, setHistoryDay] = useState("");
  const pickKey = pick ? `${pick.underlying.id}|${pick.expiry}|${pick.day}` : "";
  const pickKeyRef = useRef(pickKey);
  pickKeyRef.current = pickKey;
  const paging = useRef(false);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    setOlder([]);
    setHistory("idle");
    setHistoryDay("");
    tried.current = new Set();
    paging.current = false;
  }, [pickKey]);

  const loadOlder = useCallback(async () => {
    if (!pick || paging.current || bars.length === 0) return;
    const before = pick.day === "live" ? istDate(Date.now()) : pick.day;
    const candidates = pastWeekdays(PAST_DAYS).filter((d) => d < before && d <= pick.expiry && !tried.current.has(d));
    if (candidates.length === 0) {
      setHistory("exhausted");
      return;
    }
    paging.current = true;
    const key = pickKeyRef.current;
    for (const day of candidates) {
      tried.current.add(day);
      setHistoryDay(dayLabel(day));
      setHistory("loading");
      const q = new URLSearchParams({ underlying: pick.underlying.id, expiry: pick.expiry, date: day });
      try {
        const res = await fetch(`/straddle_history?${q}`);
        if (pickKeyRef.current !== key) return;
        if (res.status === 400) continue; // nothing that day (a holiday): the one before
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const got = ((await res.json()) as { bars: Bar[] }).bars;
        if (pickKeyRef.current !== key) return;
        if (got.length === 0) continue;
        setOlder((was) => [{ day, bars: got }, ...was]);
        paging.current = false;
        setHistory("idle");
        return;
      } catch {
        if (pickKeyRef.current !== key) return;
        tried.current.delete(day);
        paging.current = false;
        setHistory("error");
        return;
      }
    }
    paging.current = false;
    setHistory("exhausted");
  }, [pick, bars.length]);

  // The chart's minutes: earlier sessions in front of the one picked (its time axis marks each day).
  const chartBars = useMemo(() => (older.length > 0 ? [...older.flatMap((o) => o.bars), ...bars] : bars), [older, bars]);

  /* -- search box: ↑/↓ move, Enter picks, Escape clears; "/" focuses it ------------------------ */
  const searchBox = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [results]);
  useEffect(() => {
    // Several tabs are mounted at once: only the one in front takes "/".
    if (!inFront) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "/" || target?.closest("input, select, textarea")) return;
      e.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inFront]);
  const open = results.length > 0 || (searching && query.trim().length >= 2);

  /** A quick pick on the empty page: search the name, take the first match. */
  const [quick, setQuick] = useState("");
  const quickPick = (name: string) => {
    setQuick(name);
    hub
      .request<{ results: Underlying[] }>({ op: "search", q: name }, "search")
      .then((r) => {
        if (r.results[0]) choose(r.results[0]);
        else setQuery(name);
      })
      .catch(() => setQuery(name))
      .finally(() => setQuick(""));
  };

  // A layout preset's tab opens on its underlying once the hub is there.
  const autoDone = useRef(false);
  useEffect(() => {
    if (!autoPick || pick || autoDone.current || !connected) return;
    autoDone.current = true;
    quickPick(autoPick);
  }, [autoPick, pick, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => pastWeekdays(PAST_DAYS), []);
  const viewKey = `${topic}|${pick?.day ?? ""}|${bars.length > 0 ? bars[0]!.t : 0}`;
  // What this chart knows, for the table and details panels (they add no topics of their own).
  const summaryKey = pick ? `${pick.underlying.id}|${pick.expiry}` : "";
  useEffect(() => {
    if (!pick || pick.day !== "live" || bars.length === 0) return;
    publishSummary({
      key: summaryKey,
      name: pick.underlying.name,
      exchange: pick.underlying.id.split(":")[0]!.toUpperCase(),
      expiry: dayLabel(pick.expiry),
      lot: pick.underlying.lot,
      open: bars[0]!,
      last: bars[bars.length - 1]!,
      live: true,
      at: Date.now(),
    });
  }, [bars, pick, summaryKey]);
  useEffect(() => () => dropSummary(summaryKey), [summaryKey]);

  const compare = useCompare();
  const picks = pick ? picksFor(compare, pick.underlying.id, pick.expiry) : [];
  const strikeLines = useStrikeLines(hub, pick?.underlying.id ?? "", pick?.expiry ?? "", pick?.day ?? "live", bars, picks);
  const hiddenLines = useHidden();
  const first = bars[0];
  const last = bars[bars.length - 1];
  const exchange = pick ? pick.underlying.id.split(":")[0]!.toUpperCase() : "";

  const status = error ? (
    <span className="mh-hint mh-error" role="alert">
      <AlertIcon size={14} />
      {error}
    </span>
  ) : loading ? (
    <span className="mh-hint">
      <Spinner size={13} />
      Loading {pick ? dayLabel(pick.day) : ""}
    </span>
  ) : note ? (
    <span className="mh-hint mh-warn">
      {note.endsWith("…") ? <Spinner size={13} /> : <AlertIcon size={14} />}
      {note.replace(/…$/, "")}
    </span>
  ) : null;

  const sessions = pick ? ["live", ...days.filter((d) => d <= pick.expiry)] : [];

  return (
    <div className="mh-page">
      <section className="mh-container" aria-label="ATM straddle">
        {/* The container's one header strip, QuantDesk's way: what is drawn on the left (the
            underlying, its expiry, the session), quiet readouts of the latest minute on the right. */}
        <div className="mh-strip">
          <div className={pick ? "mh-search mh-has-subject" : "mh-search"}>
            <SearchIcon size={14} />
            <input
              ref={searchBox}
              type="text"
              placeholder={pick ? `${pick.underlying.name}  ${exchange}` : "Search: nifty, sensex, crudeoil"}
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && results.length > 0) {
                  e.preventDefault();
                  setActive((i) => (i + 1) % results.length);
                } else if (e.key === "ArrowUp" && results.length > 0) {
                  e.preventDefault();
                  setActive((i) => (i - 1 + results.length) % results.length);
                } else if (e.key === "Enter" && results[active]) {
                  choose(results[active]);
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
              role="combobox"
              aria-expanded={open}
              aria-controls="mh-search-results"
              aria-label="Search an underlying"
            />
            {query ? (
              <button type="button" className="mh-icon-btn mh-small" aria-label="Clear" title="Clear" onClick={() => setQuery("")}>
                <CloseIcon size={13} />
              </button>
            ) : (
              <kbd className="mh-kbd" aria-hidden>
                /
              </kbd>
            )}
            {open && (
              <ul className="mh-menu mh-results" id="mh-search-results" role="listbox">
                {searching && results.length === 0 ? (
                  <li className="mh-menu-status">
                    <Spinner size={13} />
                    Searching
                  </li>
                ) : null}
                {results.map((u, i) => (
                  <li
                    key={u.id}
                    role="option"
                    aria-selected={i === active}
                    className="mh-menu-item"
                    onMouseDown={() => choose(u)}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span className="mh-result-name">{u.name}</span>
                    <span className="mh-chip">{u.id.split(":")[0]!.toUpperCase()}</span>
                    <span className="mh-spacer" />
                    <span className="mh-result-note">
                      {u.expiries.length} {u.expiries.length === 1 ? "expiry" : "expiries"} · lot {fmt0(u.lot)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {pick && (
            <>
              <Dropdown
                label="Expiry"
                value={pick.expiry}
                onChange={(expiry) => setPick({ ...pick, expiry })}
                renderValue={(o) =>
                  o ? (
                    <>
                      {shortDate(o.value)} <span className="mh-picker-aside">{daysTo(o.value)}</span>
                    </>
                  ) : null
                }
                options={pick.underlying.expiries.map((e) => ({ value: e, label: dayLabel(e), note: daysTo(e), group: monthOf(e) }))}
              />
              <Dropdown
                label="Session"
                value={pick.day}
                onChange={(day) => setPick({ ...pick, day })}
                tone={live ? undefined : "warn"}
                lead={live ? <span className="mh-dot mh-ok" aria-hidden /> : null}
                renderValue={(o) => (o?.value === "live" ? "Today" : o ? dayLabel(o.value) : null)}
                options={sessions.map((d) => (d === "live" ? { value: d, label: "Today", note: "Live" } : { value: d, label: dayLabel(d) }))}
              />
            </>
          )}

          <span className="mh-spacer" />

          {pick ? (
            <div className="mh-readouts">
              {status ??
                (last ? (
                  <>
                    <Readout label="ATM" value={`${fmt0(last.strike)}${last.rolled ? " (rolled)" : ""}`} />
                    <Readout label="Straddle" value={fmt2(last.straddle)} change={first ? move(last.straddle, first.straddle) : null} />
                    <Readout label="IV" value={last.iv != null ? `${last.iv.toFixed(2)}%` : "—"} change={first?.iv != null && last.iv != null ? { text: `${signed(last.iv - first.iv)} pts`, tone: tone(last.iv - first.iv) } : null} />
                    <Readout label="Spot" value={fmt2(last.spot)} change={first ? move(last.spot, first.spot) : null} />
                    <span className="mh-readout mh-quiet">
                      Lot {fmt0(pick.underlying.lot)} · {bars.length} min
                    </span>
                  </>
                ) : null)}
            </div>
          ) : null}
        </div>

        {pick && bars.length > 0 ? (
          <div className="mh-chips" role="toolbar" aria-label="Straddles on the chart">
            <span className="mh-chipbox">
              <i style={{ background: ATM_COLOUR }} />
              <span className="mh-chipbox-name">{last ? fmt0(last.strike) : "ATM"}</span>
              <em>ATM</em>
              <span style={{ color: ATM_COLOUR }}>{last ? fmt2(last.straddle) : "—"}</span>
            </span>
            {picks.map((p) => {
              const line = strikeLines.find((l) => l.strike === p.strike);
              return (
                <span key={p.strike} className="mh-chipbox">
                  <i style={{ background: p.colour }} />
                  <span className="mh-chipbox-name">{fmt0(p.strike)}</span>
                  <span style={{ color: p.colour }}>{line?.last != null ? fmt2(line.last) : "—"}</span>
                  <button type="button" className="mh-chipbox-x" aria-label={`Remove the ${p.strike} straddle`} onClick={() => togglePick(pick.underlying.id, pick.expiry, p.strike)}>
                    <CloseIcon size={10} />
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              className="mh-chip-add"
              disabled={1 + picks.length >= MAX_STRADDLES}
              onClick={() => window.dispatchEvent(new Event("mh-add-straddle"))}
            >
              <PlusIcon size={11} /> Add straddle <span>{1 + picks.length}/{MAX_STRADDLES}</span>
            </button>
            <span className="mh-spacer" />
            {(
              [
                ["vwap", "VWAP", "--mh-line-vwap", "5 3"],
                ["spot", "Spot", "--mh-line-spot", ""],
                ["fut", "Syn fut", "--mh-line-fut", ""],
              ] as [LineId, string, string, string][]
            ).map(([id, label, colour, dash]) => (
              <button key={id} type="button" className="mh-overlay" aria-pressed={!hiddenLines.has(id)} onClick={() => toggleLine(id)}>
                <svg width="14" height="4" viewBox="0 0 14 4" aria-hidden>
                  <path d="M0 2h14" stroke={`var(${colour})`} strokeWidth="2" strokeDasharray={dash} />
                </svg>
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mh-container-body">
          {pick && bars.length > 0 ? (
            <StraddleChart
              bars={chartBars}
              viewKey={viewKey}
              themeKey={themeKey}
              history={history}
              historyLabel={historyDay}
              extras={strikeLines}
              onRemoveExtra={(strike) => pick && togglePick(pick.underlying.id, pick.expiry, strike)}
              onReachStart={loadOlder}
              onRetry={() => {
                setHistory("idle");
                void loadOlder();
              }}
            />
          ) : pick ? (
            <div className="mh-empty">
              {error ? (
                <>
                  <span className="mh-empty-icon mh-error">
                    <AlertIcon size={26} />
                  </span>
                  <div className="mh-empty-title">Nothing to draw</div>
                  <div className="mh-empty-text">{error}</div>
                </>
              ) : (
                <>
                  <Spinner size={20} />
                  <div className="mh-empty-title">{live ? "Waiting for the first minute" : `Loading ${dayLabel(pick.day)}`}</div>
                  <div className="mh-empty-text">
                    {pick.underlying.name}, {dayLabel(pick.expiry)} expiry
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="mh-empty">
              <span className="mh-empty-icon">
                <ChartIcon size={28} />
              </span>
              <div className="mh-empty-title">Pick an underlying</div>
              <div className="mh-empty-text">Spot, synthetic future, the ATM straddle with its VWAP, ATM IV and India VIX, minute by minute.</div>
              <div className="mh-quick">
                {QUICK.map((name) => (
                  <button key={name} type="button" className="mh-btn" disabled={!connected || quick !== ""} onClick={() => quickPick(name)}>
                    {quick === name ? <Spinner size={13} /> : null}
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-10-27` → `27 Oct`; the year only when it is not this one. */
function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const thisYear = Number(istDate(Date.now()).slice(0, 4));
  return `${d} ${MONTHS[m! - 1]}${y === thisYear ? "" : ` ${y}`}`;
}

/** An expiry's section in the menu: `October`, or `March 2027` outside this year. */
function monthOf(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  const thisYear = Number(istDate(Date.now()).slice(0, 4));
  return `${MONTH_NAMES[m! - 1]}${y === thisYear ? "" : ` ${y}`}`;
}

/** Days to expiry, short, QuantDesk's way: `4d`, and `Today` on the day itself. */
function daysTo(ymd: string): string {
  const days = Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${istDate(Date.now())}T00:00:00Z`)) / 86_400_000);
  return days <= 0 ? "Today" : `${days}d`;
}

type Tone = "mh-up" | "mh-down" | "";
const tone = (d: number): Tone => (d > 0 ? "mh-up" : d < 0 ? "mh-down" : "");
const sign = (d: number) => (d > 0 ? "+" : d < 0 ? "−" : "");
const signed = (d: number) => `${sign(d)}${fmt2(Math.abs(d))}`;

/** A move since the session's first minute, as a percent. */
function move(now: number, from: number): { text: string; tone: Tone } {
  const pct = Number((from !== 0 ? ((now - from) / from) * 100 : 0).toFixed(2));
  return { text: `${sign(pct)}${Math.abs(pct).toFixed(2)}%`, tone: tone(pct) };
}

/** One quiet readout on the strip: label one ink tier down, value, and its move since the open. */
function Readout({ label, value, change }: Readonly<{ label: string; value: string; change?: { text: string; tone: Tone } | null }>) {
  return (
    <span className="mh-readout">
      <span className="mh-readout-label">{label}</span>
      <span className="mh-readout-value">{value}</span>
      {change ? <span className={`mh-readout-move ${change.tone}`}>{change.text}</span> : null}
    </span>
  );
}
