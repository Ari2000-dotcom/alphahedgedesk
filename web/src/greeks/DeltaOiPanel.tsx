import { useEffect, useState } from "react";

import { fmt0, fmt2 } from "../core/format";
import type { Hub } from "../hub/client";
import { PickStrip, QuickPicks, useFollowedPick } from "../option/PickStrip";
import type { Pick } from "../straddle/StraddlePage";
import { Dropdown } from "../ui/Dropdown";
import { Spinner } from "../ui/icons";
import { BANDS, DEFAULT_BAND, useDeltaOi, type Band, type DeltaOiRow } from "./useDeltaOi";
import "./deltaoi.css";

/**
 * Delta x open interest for one expiry: what the calls add up to, what the puts add up to, and
 * where across the strikes that sits.
 *
 * The three figures at the top are the panel. **Call Δ×OI** is every call's delta times its open
 * interest, added up: the underlying the call side is effectively long. **Put Δ×OI** is the same
 * for the puts and is negative, because a put's delta is. **Net** is the two added — positive when
 * the board leans long, negative when it leans short — with the bar under it showing how the two
 * sides divide.
 *
 * Under them, one row a strike: the call's Δ×OI as a bar growing left of the strike, the put's
 * growing right, both on one scale, the money strike underlined. That is where the exposure
 * actually sits — a net near zero can be two large sides cancelling, and the rows say so.
 *
 * Only a band around the money is live (the hub holds so many live legs per visitor); the foot
 * says how much of the expiry that covers. See `useDeltaOi` for the arithmetic.
 */

/** Indian short scale, as a desk reads it: 1.42 Cr, 44.1 L, 8.2 K. The minus is a real minus sign. */
function compact(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)} K`;
  return `${sign}${fmt0(a)}`;
}
const signed = (v: number) => (v > 0 ? `+${compact(v)}` : compact(v));
const tone = (v: number) => (v > 0 ? "mh-up" : v < 0 ? "mh-down" : "");

export function DeltaOiPanel({
  hub,
  initialPick,
  onPick,
}: Readonly<{ hub: Hub; initialPick?: Pick | null; onPick?: (pick: Pick | null) => void }>) {
  const [pick, setPick] = useFollowedPick(initialPick);
  const [band, setBand] = useState<Band>(DEFAULT_BAND);
  /** The feed's OI is in contracts; `shares` multiplies by the lot, the exposure in underlying units. */
  const [unit, setUnit] = useState<"contracts" | "shares">("contracts");
  const [connected, setConnected] = useState(hub.state === "open");
  useEffect(() => hub.onStatus((s) => setConnected(s === "open")), [hub]);

  useEffect(() => {
    onPick?.(pick);
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  const id = pick?.underlying.id ?? "";
  const expiry = pick?.expiry ?? "";
  const lot = pick?.underlying.lot ?? 1;
  const doi = useDeltaOi(hub, id, expiry, band);

  const scale = unit === "shares" ? lot : 1;
  const call = doi.callTotal * scale;
  const put = doi.putTotal * scale;
  const net = doi.net * scale;
  // How the two sides divide: the share of the gross exposure each holds.
  const gross = Math.abs(call) + Math.abs(put);
  const callShare = gross > 0 ? (Math.abs(call) / gross) * 100 : 50;
  // The average delta behind each total, the figure that says whether a side is near or far money.
  const callAvg = doi.callOiTotal > 0 ? doi.callTotal / doi.callOiTotal : null;
  const putAvg = doi.putOiTotal > 0 ? doi.putTotal / doi.putOiTotal : null;
  const lean = Math.abs(callShare - 50) < 1 ? "evenly matched" : callShare > 50 ? "calls carry more" : "puts carry more";

  // Every bar on one scale, so a call bar and a put bar of the same length mean the same exposure.
  const widest = doi.rows.reduce((m, r) => Math.max(m, Math.abs(r.callDeltaOi ?? 0), Math.abs(r.putDeltaOi ?? 0)), 0);

  const body = !pick ? (
    <div className="mh-empty">
      <div className="mh-empty-title">Pick an underlying</div>
      <div className="mh-empty-text">Call and put delta × OI at every strike.</div>
      <QuickPicks hub={hub} onPick={setPick} disabled={!connected} />
    </div>
  ) : doi.error ? (
    <div className="mh-empty">
      <div className="mh-empty-title">Nothing to show</div>
      <div className="mh-empty-text">{doi.error}</div>
    </div>
  ) : doi.noOi ? (
    <div className="mh-empty">
      <div className="mh-empty-title">No open interest on this feed</div>
      <div className="mh-empty-text">
        Prices are arriving but open interest is not, so delta × OI cannot be worked out. The hub sends it from the build that carries <code>oi</code> on its quotes; this one is older.
      </div>
    </div>
  ) : !doi.ready ? (
    <div className="mh-doi-wait" aria-busy>
      <Spinner size={18} />
      <span>
        {doi.waiting} · {pick.underlying.name}
      </span>
    </div>
  ) : (
    <>
      <div className="mh-doi-figures">
        <div className="mh-doi-tiles">
          <div className="mh-doi-tile" data-side="call">
            <span className="mh-doi-tile-label">Call Δ × OI</span>
            <span className="mh-doi-tile-value mh-up">{compact(call)}</span>
            <span className="mh-doi-tile-note">
              OI {compact(doi.callOiTotal * scale)} · avg Δ {callAvg === null ? "—" : callAvg.toFixed(2)}
            </span>
          </div>
          <div className="mh-doi-tile" data-side="put">
            <span className="mh-doi-tile-label">Put Δ × OI</span>
            <span className="mh-doi-tile-value mh-down">{compact(put)}</span>
            <span className="mh-doi-tile-note">
              OI {compact(doi.putOiTotal * scale)} · avg Δ {putAvg === null ? "—" : putAvg.toFixed(2)}
            </span>
          </div>
          <div className="mh-doi-tile" data-side="net">
            <span className="mh-doi-tile-label">Net Δ × OI</span>
            <span className={`mh-doi-tile-value ${tone(net)}`}>{signed(net)}</span>
            <span className="mh-doi-tile-note">{lean}</span>
          </div>
        </div>
        <div className="mh-doi-balance" role="img" aria-label={`Calls ${callShare.toFixed(0)} percent of the gross exposure, puts ${(100 - callShare).toFixed(0)} percent`}>
          <i className="mh-doi-balance-call" style={{ width: `${callShare}%` }} />
          <i className="mh-doi-balance-put" style={{ width: `${100 - callShare}%` }} />
        </div>
        <div className="mh-doi-balance-legend">
          <span>Calls {callShare.toFixed(0)}%</span>
          <span className="mh-spacer" />
          <span>Puts {(100 - callShare).toFixed(0)}%</span>
        </div>
      </div>

      <div className="mh-doi-head">
        <span>Call Δ × OI</span>
        <span className="mh-doi-head-strike">Strike</span>
        <span>Put Δ × OI</span>
      </div>
      <div className="mh-doi-rows">
        {doi.rows.map((row) => (
          <StrikeRow key={row.strike} row={row} widest={widest} scale={scale} />
        ))}
      </div>

      <div className="mh-doi-foot">
        <span title={`${doi.covered} of the ${doi.inBand} strikes in the band have both legs' price and open interest.`}>
          {doi.covered} of {doi.inBand} strikes · ±{band} of {doi.strikesTotal}
        </span>
        <span className="mh-doi-dot">·</span>
        <span>ATM IV {doi.atmIv === null ? "—" : `${doi.atmIv.toFixed(1)}%`}</span>
        <span className="mh-doi-dot">·</span>
        <span title="Delta is taken on the forward (call − put + strike at the money), not the spot.">Forward {doi.forward === null ? "—" : fmt2(doi.forward)}</span>
        {doi.limited ? (
          <>
            <span className="mh-doi-dot">·</span>
            <span className="mh-doi-limit" title="Live prices are limited per visitor, and an option chain in this tab is using most of them, so fewer strikes here update live.">
              Band trimmed: hub limit
            </span>
          </>
        ) : null}
        <span className="mh-spacer" />
        <div className="mh-doi-units" role="group" aria-label="Units">
          <button type="button" className="mh-doi-unit" aria-pressed={unit === "contracts"} onClick={() => setUnit("contracts")}>
            Contracts
          </button>
          <button type="button" className="mh-doi-unit" aria-pressed={unit === "shares"} onClick={() => setUnit("shares")} title={`Open interest times the lot of ${fmt0(lot)}`}>
            × lot {fmt0(lot)}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="mh-doi">
      <PickStrip hub={hub} pick={pick} onPick={setPick} spot={doi.spot}>
        {pick ? (
          <Dropdown
            label="Band"
            value={String(band)}
            onChange={(v) => setBand(Number(v) as Band)}
            align="end"
            options={BANDS.map((b) => ({ value: String(b), label: `±${b}`, note: `${b * 2 + 1} strikes` }))}
          />
        ) : null}
      </PickStrip>
      {body}
    </div>
  );
}

/** One strike: the call's exposure left of it, the put's right of it, both on the panel's one scale. */
function StrikeRow({ row, widest, scale }: Readonly<{ row: DeltaOiRow; widest: number; scale: number }>) {
  const callOi = row.callOi === null ? null : row.callOi * scale;
  const putOi = row.putOi === null ? null : row.putOi * scale;
  const call = row.callDeltaOi === null ? null : row.callDeltaOi * scale;
  const put = row.putDeltaOi === null ? null : row.putDeltaOi * scale;
  const width = (v: number | null) => (v === null || widest <= 0 ? 0 : (Math.abs(v) / widest) * 100);
  const legend = (side: string, oi: number | null, delta: number | null, product: number | null) =>
    `${row.strike} ${side} · OI ${oi === null ? "—" : fmt0(oi)} · Δ ${delta === null ? "—" : delta.toFixed(3)} · Δ×OI ${product === null ? "—" : compact(product)}`;

  return (
    <div className="mh-doi-row" data-atm={row.atm || undefined}>
      <div className="mh-doi-side mh-doi-call" title={legend("CE", callOi, row.callDelta, call)}>
        <i style={{ width: `${width(call)}%` }} />
        <span className="mh-doi-val">{call === null ? "—" : compact(call)}</span>
      </div>
      <div className="mh-doi-strike">{row.strike.toLocaleString("en-IN")}</div>
      <div className="mh-doi-side mh-doi-put" title={legend("PE", putOi, row.putDelta, put)}>
        <i style={{ width: `${width(put)}%` }} />
        <span className="mh-doi-val">{put === null ? "—" : compact(put)}</span>
      </div>
    </div>
  );
}
