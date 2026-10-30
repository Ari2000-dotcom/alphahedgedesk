import { useEffect, useMemo, useState } from "react";

import { dayLabel, fmt0, fmt2, nearestExpiry } from "../core/format";
import { previousClose } from "../core/previousClose";
import { useUniverse } from "../core/universe";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";
import { Dropdown } from "../ui/Dropdown";
import { AlertIcon, ChartIcon, Spinner } from "../ui/icons";
import { MultiDropdown } from "../ui/MultiDropdown";
import { useFitRow } from "../ui/fitRow";
import { IntervalPicker } from "./IntervalPicker";
import { ATR_PERIOD, atrPoints, CANDLE_INTERVALS, useCandles } from "./useCandles";
import { useOiProfile, type OiProfileMode } from "./useOiProfile";
import { ScripChart } from "./ScripChart";

/**
 * Pick any NSE/BSE index or MCX commodity and an interval: its candles on openalgo-charts, price
 * on the right axis, Wilder's ATR underneath, and the OI profile of one or more expiries hung off
 * the price axis, QuantDesk's way (`useOiProfile`, `OiProfileBars`). Candles are historical for
 * now — see `ScripChart`.
 */

const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];
const DEFAULT_INTERVAL = "1d";

/** A change's sign and colour; nothing either way for no change, never "−0.00". */
const signOf = (v: number) => (v > 0.0049 ? "+" : v < -0.0049 ? "−" : "");
const toneOf = (v: number) => (v > 0.0049 ? "mh-up" : v < -0.0049 ? "mh-down" : "");
const OI_MODES: readonly { value: OiProfileMode; label: string }[] = [
  { value: "oi", label: "OI" },
  { value: "change", label: "OI chg" },
];

export interface ScripPick {
  id: string;
  name: string;
  interval: string;
}

export function ScripPage({
  hub,
  themeKey,
  initialId,
  initialInterval,
  onPick,
}: Readonly<{
  hub: Hub;
  themeKey: string;
  initialId?: string | null;
  initialInterval?: string;
  onPick?: (pick: ScripPick | null) => void;
}>) {
  const universe = useUniverse(hub);
  const underlyingOf = useMemo(() => new Map(universe.map((u) => [u.id, u] as const)), [universe]);
  const underlyingOptions = useMemo(
    () => universe.map((u) => ({ value: u.id, label: u.name, note: u.id.split(":")[0]!.toUpperCase() })),
    [universe],
  );

  const [id, setId] = useState(initialId ?? "");
  const [interval, setInterval_] = useState(
    initialInterval && CANDLE_INTERVALS.some((c) => c.value === initialInterval) ? initialInterval : DEFAULT_INTERVAL,
  );

  useEffect(() => {
    const u = underlyingOf.get(id);
    onPick?.(id ? { id, name: u?.name ?? id, interval } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, interval, underlyingOf]);

  // The OI profile's picked expiries: the nearest one the moment an underlying is picked, free to
  // change from there — QuantDesk's `pickedExpiries` (none still listed falls back to the nearest).
  const [expiries, setExpiries] = useState<string[]>([]);
  const [oiMode, setOiMode] = useState<OiProfileMode>("oi");
  const allExpiries = underlyingOf.get(id)?.expiries ?? [];
  const allExpiriesKey = allExpiries.join(",");
  useEffect(() => {
    const near = nearestExpiry(allExpiries);
    setExpiries(near ? [near] : []);
    // A new underlying resets the pick; the same one's expiry list arriving late (the universe
    // was still loading) fills it in rather than leaving the picker stuck on nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, allExpiriesKey]);
  const pickedExpiries = expiries.filter((e) => allExpiries.includes(e));
  const { data: oiProfile } = useOiProfile(hub, id, pickedExpiries);

  const spec = CANDLE_INTERVALS.find((c) => c.value === interval) ?? CANDLE_INTERVALS[CANDLE_INTERVALS.length - 1]!;
  const { candles, forKey, loading, error, note } = useCandles(id, spec);
  const atr = useMemo(() => atrPoints(candles, ATR_PERIOD), [candles]);
  // The view follows the candles drawn, not the interval asked for: the old interval's candles stay
  // up while the new one loads, and the chart fits the new ones only when they are there.
  const viewKey = forKey;
  const latestAtr = atr[atr.length - 1];
  const atrValue = latestAtr && "value" in latestAtr ? latestAtr.value : null;

  // Yesterday's close: the reference every "Chg" reads from, independent of the chart's own
  // interval — a 5m chart's last two bars are minutes apart, not a day's move.
  const [prevClose, setPrevClose] = useState<number | null>(null);
  useEffect(() => {
    if (!id) {
      setPrevClose(null);
      return;
    }
    let cancelled = false;
    previousClose(id)
      .then((p) => !cancelled && setPrevClose(p))
      .catch(() => !cancelled && setPrevClose(null));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Today's real last price, live — the candle series' own last-value tag is only ever the
  // latest CLOSED candle, which can sit well behind the live tick.
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    setLive(null);
    if (!id) return;
    return hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
      const p = (msg as { ltp?: number }).ltp;
      if (msg.t === "q" && typeof p === "number" && p > 0) setLive(p);
    });
  }, [hub, id]);

  const last = live ?? candles[candles.length - 1]?.close ?? null;
  const chg = last !== null && prevClose !== null ? last - prevClose : null;
  const chgPct = chg !== null && prevClose ? (chg / prevClose) * 100 : null;
  const fitReadouts = useFitRow();

  const quickPick = (name: string) => {
    const u = universe.find((x) => x.name === name);
    if (u) setId(u.id);
  };

  return (
    <div className="mh-page">
      <section className="mh-container" aria-label="Scrip chart">
        <div className="mh-strip">
          <Dropdown
            label="Underlying"
            caption={false}
            value={id}
            onChange={setId}
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
          <IntervalPicker value={interval} onChange={setInterval_} />
          {id && allExpiries.length > 0 ? (
            <>
              <MultiDropdown
                label="Expiry"
                caption={false}
                value={pickedExpiries}
                onChange={setExpiries}
                renderValue={(picked) =>
                  picked.length === 0
                    ? "No expiry"
                    : picked.length === 1
                      ? dayLabel(picked[0]!.value)
                      : `${picked.length} expiries`
                }
                options={allExpiries.map((e) => ({ value: e, label: dayLabel(e) }))}
              />
              <Dropdown
                label="OI"
                caption={false}
                value={oiMode}
                onChange={setOiMode}
                renderValue={(o) => o?.label ?? null}
                options={OI_MODES}
              />
            </>
          ) : null}
          <span className="mh-spacer" />
          {/* A new interval loads behind the candles already up: said quietly, not by blanking them. */}
          {id && candles.length > 0 && (loading || note) ? (
            <span className="mh-hint">
              <Spinner size={13} />
              {note ?? `Loading ${spec.name}`}
            </span>
          ) : null}
          {id && last !== null ? (
            // Measured like the straddle strip's (ui/fitRow.ts): ATR gives way first, then the
            // day's change, and the last price always stays, never cut at the panel's edge.
            <div className="mh-readouts" ref={fitReadouts}>
              <span className="mh-readgroup">
                <span className="mh-readout">
                  <span className="mh-readout-label">Last</span>
                  <span className="mh-readout-value">{fmt2(last)}</span>
                  {chg !== null && chgPct !== null ? (
                    <>
                      <span className={`mh-readout-delta ${toneOf(chg)}`} data-drop={2}>
                        {signOf(chg)}
                        {fmt2(Math.abs(chg))}
                      </span>
                      <span className={`mh-readout-move ${toneOf(chg)}`} data-drop={2}>
                        {signOf(chgPct)}
                        {Math.abs(chgPct).toFixed(2)}%
                      </span>
                    </>
                  ) : null}
                </span>
              </span>
              <span className="mh-readgroup" data-drop={1}>
                <span className="mh-readout">
                  <span className="mh-readout-label">ATR {ATR_PERIOD}</span>
                  <span className="mh-readout-value">{atrValue !== null ? fmt2(atrValue) : "—"}</span>
                </span>
              </span>
            </div>
          ) : null}
        </div>
        <div className="mh-container-body">
          {id && candles.length > 0 ? (
            <ScripChart
              candles={candles}
              atr={atr}
              period={ATR_PERIOD}
              live={live}
              prevClose={prevClose}
              oiProfile={oiProfile}
              oiMode={oiMode}
              viewKey={viewKey}
              themeKey={themeKey}
            />
          ) : id ? (
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
                  <div className="mh-empty-title">{note ?? (loading ? "Loading candles" : "No candles for this range")}</div>
                  <div className="mh-empty-text">{underlyingOf.get(id)?.name ?? id}</div>
                </>
              )}
            </div>
          ) : (
            <div className="mh-empty">
              <span className="mh-empty-icon">
                <ChartIcon size={28} />
              </span>
              <div className="mh-empty-title">Pick an underlying</div>
              <div className="mh-empty-text">Candles with price on the right axis, Wilder's ATR underneath.</div>
              <div className="mh-quick">
                {QUICK.map((name) => (
                  <button key={name} type="button" className="mh-btn" disabled={universe.length === 0} onClick={() => quickPick(name)}>
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
