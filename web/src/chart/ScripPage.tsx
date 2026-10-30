import { useEffect, useMemo, useRef, useState } from "react";

import { dayLabel, fmt0, fmt2, nearestExpiry } from "../core/format";
import { previousClose } from "../core/previousClose";
import { useUniverse } from "../core/universe";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";
import { Dropdown } from "../ui/Dropdown";
import {
  AlertIcon,
  AreaChartIcon,
  BaselineIcon,
  CandlesIcon,
  ChartIcon,
  EyeOffIcon,
  HighLowIcon,
  HlcAreaIcon,
  HollowCandlesIcon,
  IndicatorsIcon,
  LineChartIcon,
  LineMarkersIcon,
  OhlcBarsIcon,
  OiBothIcon,
  OiChangeIcon,
  OiTotalIcon,
  Spinner,
  StepLineIcon,
  DeltaOiIcon,
} from "../ui/icons";
import { MultiDropdown } from "../ui/MultiDropdown";
import { useFitRow } from "../ui/fitRow";
import { IntervalPicker } from "./IntervalPicker";
import { ATR_PERIOD, atrPoints, CANDLE_INTERVALS, useCandles } from "./useCandles";
import { delta76, yearsToExpiry } from "../core/black76";
import { useDeltaOi, type Band } from "../greeks/useDeltaOi";
import { useExposureTrend, type ExposureRow } from "./useExposureTrend";
import { useOiProfile, type OiProfileMode } from "./useOiProfile";
import { ScripChart, type LiveTick } from "./ScripChart";
import { CANDLE_PALETTES, paletteColors, useCandlePalette } from "./candlePalette";
import { CHART_TYPES, isLineType, useChartType, type ScripChartType } from "./chartType";
import { INDICATORS, useIndicators } from "./indicators";

/**
 * Pick any NSE/BSE index or MCX commodity and an interval: its candles on openalgo-charts, price
 * on the right axis, the indicators picked from the Indicators menu (`indicators.ts`), and the OI
 * profile of one or more expiries hung off the price axis, QuantDesk's way (`useOiProfile`,
 * `OiProfileBars`). Live trades build the forming candle (`ScripChart`).
 */

const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];
const DEFAULT_INTERVAL = "5m";

/** A change's sign and colour; nothing either way for no change, never "−0.00". */
const signOf = (v: number) => (v > 0.0049 ? "+" : v < -0.0049 ? "−" : "");
const toneOf = (v: number) => (v > 0.0049 ? "mh-up" : v < -0.0049 ? "mh-down" : "");
type OiView = OiProfileMode | "delta" | "off";
const OI_VIEWS: readonly {
  value: OiView;
  /** On the toolbar's trigger. */
  short: string;
  label: string;
  note: string;
  Icon: typeof OiBothIcon;
}[] = [
  { value: "both", short: "OI + chg", label: "Total OI with today's change", note: "Total, today's addition marked", Icon: OiBothIcon },
  { value: "oi", short: "Total OI", label: "Total OI", note: "Open interest per strike", Icon: OiTotalIcon },
  { value: "change", short: "OI change", label: "Today's OI change", note: "Added or shed today", Icon: OiChangeIcon },
  { value: "delta", short: "Δ × OI", label: "Delta × OI", note: "Every strike, vs 2 min", Icon: DeltaOiIcon },
  { value: "off", short: "OI off", label: "Hide the OI profile", note: "", Icon: EyeOffIcon },
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
  const [oiView, setOiView] = useState<OiView>("both");
  const [indicators, setIndicators] = useIndicators();
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
  // Hidden asks the hub for nothing: no expiries, no profile.
  const deltaOn = oiView === "delta";
  // Delta × OI is for one expiry (the first picked); the other views sum all of them.
  const { data: oiProfile } = useOiProfile(hub, id, oiView === "off" ? [] : deltaOn ? pickedExpiries.slice(0, 1) : pickedExpiries);

  // Delta × OI over every strike of the expiry. The OI of the whole chain is one request (the same
  // profile as the other views); what a strike's delta needs is the forward and the ATM vol, and
  // those come from the two at-the-money legs alone. Pricing each strike's own legs would mean a
  // live subscription per leg, which the hub's per-visitor limit cuts to a few strikes when other
  // panels are open. So the deltas use one vol across the chain (the ATM's): the skew is left out.
  const deltaExpiry = deltaOn ? (pickedExpiries[0] ?? "") : "";
  const doi = useDeltaOi(hub, deltaOn ? id : "", deltaExpiry, 0 as unknown as Band);
  const heldRows = useRef<{ key: string; rows: ExposureRow[] }>({ key: "", rows: [] });
  const deltaKey = `${id}|${deltaExpiry}`;
  const deltaRows = useMemo(() => {
    if (!deltaOn) return [];
    // The ATM vol or the forward drops out for a beat now and then (a leg's price not yet in, a vol
    // that does not solve): the bars hold the last good picture then, rather than vanishing.
    if (!oiProfile || doi.forward === null || doi.atmIv === null) return heldRows.current.key === deltaKey ? heldRows.current.rows : [];
    const years = Math.round(yearsToExpiry(deltaExpiry, id.startsWith("mcx:")) * 525_600) / 525_600;
    const vol = doi.atmIv / 100;
    const weigh = (oi: number | undefined, strike: number, call: boolean) => (oi !== undefined && Number.isFinite(oi) ? delta76(doi.forward!, strike, years, vol, call) * oi : null);
    const rows = oiProfile.strikes.map((strike, i) => ({
      strike,
      callDeltaOi: weigh(oiProfile.call[i], strike, true),
      putDeltaOi: weigh(oiProfile.put[i], strike, false),
    }));
    heldRows.current = { key: deltaKey, rows };
    return rows;
  }, [deltaOn, oiProfile, doi.forward, doi.atmIv, deltaExpiry, id, deltaKey]);
  const deltaProfile = useExposureTrend(deltaRows, deltaOn, deltaKey);

  const spec = CANDLE_INTERVALS.find((c) => c.value === interval) ?? CANDLE_INTERVALS[CANDLE_INTERVALS.length - 1]!;
  const { candles, forKey, loading, error, note } = useCandles(id, spec);
  const atr = useMemo(() => atrPoints(candles, ATR_PERIOD), [candles]);
  // The view follows the candles drawn, not the interval asked for: the old interval's candles stay
  // up while the new one loads, and the chart fits the new ones only when they are there.
  const viewKey = forKey;
  const latestAtr = atr[atr.length - 1];
  // The ATR on the candles as the ticks build them (`ScripChart` reports it), else the hub's candles' own.
  const [liveAtr, setLiveAtr] = useState<number | null>(null);
  useEffect(() => setLiveAtr(null), [candles]);
  const atrValue = liveAtr ?? (latestAtr && "value" in latestAtr ? latestAtr.value : null);

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

  // Today's real last price, live, for the readout; and each live trade for the forming candle.
  // The hub's replay of the last known state (yesterday's, before the open) moves the readout but
  // builds no candle.
  const [live, setLive] = useState<number | null>(null);
  const [tick, setTick] = useState<LiveTick | null>(null);
  // The exchange's average traded price today (a future, an option, a share; never an index).
  const [atp, setAtp] = useState<number | null>(null);
  useEffect(() => {
    setLive(null);
    setTick(null);
    setAtp(null);
    if (!id) return;
    return hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
      const q = msg as { ltp?: number; ts?: number; replay?: boolean; atp?: number };
      if (msg.t !== "q" || typeof q.ltp !== "number" || q.ltp <= 0) return;
      setLive(q.ltp);
      // Not from the replay: before the open it is yesterday's session, and the line is today's.
      if (!q.replay && typeof q.atp === "number" && q.atp > 0) setAtp(q.atp);
      if (!q.replay && typeof q.ts === "number") setTick({ price: q.ltp, ts: q.ts });
    });
  }, [hub, id]);

  const [chartType, setChartType] = useChartType();
  const [paletteId, setPaletteId] = useCandlePalette();
  // The desk preset reads the theme's tokens, so a theme change resolves it again.
  const colors = useMemo(() => paletteColors(paletteId), [paletteId, themeKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div className="mh-strip mh-tv-strip">
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
          <span className="mh-tv-sep" aria-hidden />
          <IntervalPicker value={interval} onChange={setInterval_} />
          <span className="mh-tv-sep" aria-hidden />
          {/* TradingView's toolbar: no chevron on the chart type, the candles or the indicators. */}
          <span className="mh-tv-bare">
            <Dropdown
              label="Chart type"
              caption={false}
              value={chartType}
              onChange={setChartType}
              renderValue={() => <ChartTypeIcon type={chartType} />}
              options={CHART_TYPES.map((t) => ({ value: t.id, label: t.name, icon: <ChartTypeIcon type={t.id} />, separator: t.group }))}
            />
            {/* A line or an area draws in one colour: the up/down pair only means something to candles and bars. */}
            {isLineType(chartType) ? null : (
              <Dropdown
                label="Candles"
                caption={false}
                value={paletteId}
                onChange={setPaletteId}
                renderValue={() => <Swatch up={colors.up} down={colors.down} />}
                options={CANDLE_PALETTES.map((p) => {
                  const c = paletteColors(p.id);
                  return { value: p.id, label: p.name, icon: <Swatch up={c.up} down={c.down} /> };
                })}
              />
            )}
            <span className="mh-tv-sep" aria-hidden />
            <MultiDropdown
              label="Indicators"
              caption={false}
              value={indicators}
              onChange={setIndicators}
              renderValue={(picked) => (
                <span className="mh-ind-trigger">
                  <IndicatorsIcon size={16} /> Indicators
                  {picked.length > 0 ? <span className="mh-ind-count">{picked.length}</span> : null}
                </span>
              )}
              options={INDICATORS.map((d) => ({ value: d.id, label: d.name, note: d.note }))}
            />
          </span>
          {id && allExpiries.length > 0 ? (
            <>
              <span className="mh-tv-sep" aria-hidden />
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
                label="OI profile"
                caption={false}
                value={oiView}
                onChange={setOiView}
                renderValue={(o) => {
                  const v = OI_VIEWS.find((x) => x.value === o?.value);
                  return v ? (
                    <>
                      <v.Icon size={16} /> {v.short}
                      {deltaOn && deltaRows.length === 0 ? <span className="mh-chip">{doi.error || doi.waiting}</span> : null}
                    </>
                  ) : null;
                }}
                options={OI_VIEWS.map(({ value, label, note, Icon }) => ({ value, label, note, icon: <Icon size={16} />, separator: value === "off" }))}
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
              chartType={chartType}
              indicators={indicators}
              tick={tick}
              onAtr={setLiveAtr}
              atp={atp}
              stepSec={spec.seconds}
              name={underlyingOf.get(id)?.name ?? id}
              colors={colors}
              oiProfile={oiView === "off" ? null : deltaOn ? deltaProfile : oiProfile}
              oiMode={oiView === "off" ? "both" : deltaOn ? "both" : oiView}
              oiUnit={deltaOn ? "delta" : "oi"}
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
              <div className="mh-empty-text">Candles with price on the right axis, and the indicators you pick.</div>
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

/** A candle preset's pair: an up candle beside a down one. */
function Swatch({ up, down }: Readonly<{ up: string; down: string }>) {
  return (
    <span className="mh-swatch" aria-hidden>
      <i style={{ background: up }} />
      <i style={{ background: down }} />
    </span>
  );
}

const TYPE_ICONS: Record<ScripChartType, typeof CandlesIcon> = {
  bar: OhlcBarsIcon,
  candlestick: CandlesIcon,
  "hollow-candle": HollowCandlesIcon,
  line: LineChartIcon,
  "line-markers": LineMarkersIcon,
  step: StepLineIcon,
  area: AreaChartIcon,
  "hlc-area": HlcAreaIcon,
  baseline: BaselineIcon,
  "high-low": HighLowIcon,
};

/** A chart type's picture, as TradingView's chart-type button shows it. */
function ChartTypeIcon({ type }: Readonly<{ type: ScripChartType }>) {
  const Icon = TYPE_ICONS[type];
  return <Icon size={18} />;
}
