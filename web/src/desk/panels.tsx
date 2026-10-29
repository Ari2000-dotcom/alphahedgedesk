import { useEffect, useMemo, useRef, useState } from "react";

import { yearsToExpiry } from "../core/black76";
import { fmt0, fmt2 } from "../core/format";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";
import { MAX_STRADDLES, ATM_COLOUR, picksFor, useCompare } from "./compare";
import { useSummaries, type Summary } from "./summary";
import "./panels.css";

const sign = (v: number, digits: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
const tone = (v: number) => (v > 0 ? "mh-up" : v < 0 ? "mh-down" : "");
const pct = (now: number, open: number) => (open !== 0 ? ((now - open) / open) * 100 : 0);

/** One row of the table's numbers for a straddle's summary. */
function figures(s: Summary) {
  const last = s.last;
  const prev = s.open.straddle;
  const change = last.straddle - prev;
  const vwap = last.vwap;
  return {
    last: last.straddle,
    change,
    changePct: pct(last.straddle, prev),
    vwap,
    vsVwap: vwap === null ? null : last.straddle - vwap,
    iv: last.iv,
    ivChange: last.iv !== null && s.open.iv !== null ? last.iv - s.open.iv : null,
    spot: last.spot,
    basis: last.synth - last.spot,
  };
}

/* -- the straddle table ---------------------------------------------------------------------- */

/**
 * Every straddle chart that is open, one row each: the ATM strike, the straddle and its move
 * since the open, VWAP and where the straddle sits against it, ATM IV, spot and basis. It reads
 * what the charts already hold, so open one more chart and it gains a row.
 */
export function TablePanel() {
  const rows = useSummaries();
  return (
    <div className="mh-table-panel">
      <div className="mh-table-head">
        <span className="mh-table-title">
          Straddles <span>{rows.length}</span>
        </span>
        <span className="mh-spacer" />
        <span className="mh-table-note">One update a second</span>
      </div>
      <div className="mh-table-scroll">
        {rows.length === 0 ? (
          <div className="mh-empty">
            <div className="mh-empty-title">No straddles open</div>
            <div className="mh-empty-text">Open a straddle chart and it shows here.</div>
          </div>
        ) : (
          <table className="mh-table">
            <thead>
              <tr>
                <th className="mh-l">Underlying</th>
                <th className="mh-l">Expiry</th>
                <th>ATM</th>
                <th>Straddle</th>
                <th>Chg</th>
                <th>Chg%</th>
                <th>VWAP</th>
                <th>vs VWAP</th>
                <th>ATM IV</th>
                <th>IV chg</th>
                <th>Spot</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const f = figures(s);
                return (
                  <tr key={s.key}>
                    <td className="mh-l mh-strong">{s.name}</td>
                    <td className="mh-l">{s.expiryLabel}</td>
                    <td>{fmt0(s.last.strike)}</td>
                    <td className="mh-strong">{fmt2(f.last)}</td>
                    <td className={tone(f.change)}>{sign(f.change, 2)}</td>
                    <td className={tone(f.changePct)}>{sign(f.changePct, 2)}%</td>
                    <td>{f.vwap === null ? "—" : fmt2(f.vwap)}</td>
                    <td className={f.vsVwap === null ? undefined : tone(f.vsVwap)}>{f.vsVwap === null ? "—" : sign(f.vsVwap, 2)}</td>
                    <td>{f.iv === null ? "—" : `${f.iv.toFixed(2)}%`}</td>
                    <td className={f.ivChange === null ? undefined : tone(f.ivChange)}>{f.ivChange === null ? "—" : sign(f.ivChange, 2)}</td>
                    <td>{fmt2(f.spot)}</td>
                    <td>{sign(f.basis, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* -- the ATM straddle's details --------------------------------------------------------------- */

/** The latest price of each leg of the picked strikes, for the compared list. */
function useLegs(hub: Hub, underlying: string, expiry: string, strikes: readonly number[]) {
  const prices = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const key = `${underlying}|${expiry}|${strikes.join(",")}`;
  useEffect(() => {
    if (!underlying || strikes.length === 0) return;
    let frame: number | null = null;
    const stops = strikes.flatMap((k) =>
      (["CE", "PE"] as const).map((kind) => {
        const id = `${underlying}:${expiry}:${k}:${kind}`;
        return hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
          const p = (msg as { ltp?: number }).ltp;
          if (msg.t !== "q" || typeof p !== "number" || !(p > 0)) return;
          prices.current.set(id, p);
          if (frame === null) {
            frame = requestAnimationFrame(() => {
              frame = null;
              setTick((n) => n + 1);
            });
          }
        });
      }),
    );
    return () => {
      for (const stop of stops) stop();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [hub, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (strike: number) => {
    const ce = prices.current.get(`${underlying}:${expiry}:${strike}:CE`);
    const pe = prices.current.get(`${underlying}:${expiry}:${strike}:PE`);
    return ce !== undefined && pe !== undefined ? ce + pe : null;
  };
}

/**
 * The ATM straddle of the chart that was last used: its price and move, the two legs, VWAP, IV,
 * basis and the time to expiry, and the straddles compared with it (picked on the chain).
 */
export function DetailsPanel({ hub }: Readonly<{ hub: Hub }>) {
  const rows = useSummaries();
  const compare = useCompare();
  const s = useMemo(() => {
    const picked = rows.find((r) => r.key.startsWith(`${compare.underlying}|${compare.expiry}`));
    return picked ?? rows[rows.length - 1];
  }, [rows, compare.underlying, compare.expiry]);
  const underlying = s ? s.key.split("|")[0]! : "";
  const picks = s ? picksFor(compare, underlying, s.expiry) : [];
  const priceOf = useLegs(hub, underlying, s?.expiry ?? "", picks.map((p) => p.strike));

  if (!s) {
    return (
      <div className="mh-empty">
        <div className="mh-empty-title">No straddle yet</div>
        <div className="mh-empty-text">Open a straddle chart and its details show here.</div>
      </div>
    );
  }
  const f = figures(s);
  const mcx = underlying.startsWith("mcx:");
  const left = yearsToExpiry(s.expiry, mcx) * 365 * 24 * 60;
  const toExpiry = left <= 0 ? "Expired" : left >= 1440 ? `${Math.floor(left / 1440)}d ${Math.floor((left % 1440) / 60)}h` : `${Math.floor(left / 60)}h ${Math.floor(left % 60)}m`;
  const facts: [string, string, string?][] = [
    ["Call", fmt2(s.last.call)],
    ["Put", fmt2(s.last.put)],
    ["VWAP", f.vwap === null ? "—" : fmt2(f.vwap)],
    ["vs VWAP", f.vsVwap === null ? "—" : sign(f.vsVwap, 2), f.vsVwap === null ? undefined : tone(f.vsVwap)],
    ["ATM IV", f.iv === null ? "—" : `${f.iv.toFixed(2)}%`],
    ["IV chg", f.ivChange === null ? "—" : sign(f.ivChange, 2), f.ivChange === null ? undefined : tone(f.ivChange)],
    ["Basis", sign(f.basis, 2)],
    ["To expiry", toExpiry],
  ];
  return (
    <div className="mh-details">
      <div className="mh-details-head">
        <span className="mh-strong">ATM {fmt0(s.last.strike)}</span> straddle · {s.name} · {s.expiryLabel}
      </div>
      <div className="mh-details-price">
        <span>{fmt2(f.last)}</span>
        <span className={tone(f.change)}>
          {sign(f.change, 2)} {sign(f.changePct, 2)}%
        </span>
      </div>
      <div className="mh-details-facts">
        {facts.map(([label, value, t]) => (
          <div key={label} className="mh-details-fact">
            <span>{label}</span>
            <span className={t}>{value}</span>
          </div>
        ))}
      </div>
      <div className="mh-details-sub">
        <span>On the chart</span>
        <span>
          {1 + picks.length} of {MAX_STRADDLES}
        </span>
      </div>
      <div className="mh-details-pick">
        <i style={{ background: ATM_COLOUR }} />
        <span>
          <span className="mh-strong">{fmt0(s.last.strike)} straddle</span>
          <em>ATM, rolls with spot</em>
        </span>
        <span>
          <span className="mh-strong">{fmt2(f.last)}</span>
          <em className={tone(f.changePct)}>{sign(f.changePct, 2)}% from open</em>
        </span>
      </div>
      {picks.map((p) => {
        const v = priceOf(p.strike);
        return (
          <div key={p.strike} className="mh-details-pick">
            <i style={{ background: p.colour }} />
            <span>
              <span className="mh-strong">{fmt0(p.strike)} straddle</span>
              <em>Fixed strike</em>
            </span>
            <span>
              <span className="mh-strong">{v === null ? "—" : fmt2(v)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
