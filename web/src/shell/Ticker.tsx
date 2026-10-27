import { useEffect, useState } from "react";

import { fmt2, istDate } from "../core/format";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";

/** The indices in the title bar, as AlphaHedge shows them. */
const INDICES = [
  { id: "nse:nifty", name: "NIFTY" },
  { id: "nse:banknifty", name: "BANKNIFTY" },
  { id: "bse:sensex", name: "SENSEX" },
];

const DAY_MS = 86_400_000;

/**
 * The last session's close before today, from the hub's daily candles. Asked
 * only up to yesterday, so the browser keeps the answer for the day.
 */
async function previousClose(id: string): Promise<number | null> {
  const today = istDate(Date.now());
  // Six days back covers a weekend and a holiday.
  const from = istDate(Date.now() - 6 * DAY_MS);
  const to = istDate(Date.now() - DAY_MS);
  const q = new URLSearchParams({ id, interval: "1d", from, to });
  const res = await fetch(`/history?${q}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { pieces: { candles?: number[][] }[] };
  let latest: number[] | null = null;
  for (const piece of body.pieces) {
    for (const c of piece.candles ?? []) {
      // A candle is [time (s), open, high, low, close, volume].
      if (istDate(c[0]! * 1000) < today && (!latest || c[0]! > latest[0]!)) latest = c;
    }
  }
  return latest ? latest[4]! : null;
}

function IndexPrice({ hub, id, name }: Readonly<{ hub: Hub; id: string; name: string }>) {
  const [ltp, setLtp] = useState<number | null>(null);
  const [prev, setPrev] = useState<number | null>(null);

  useEffect(
    () =>
      hub.subscribe(`quote:${id}`, (msg: TopicMessage) => {
        const price = (msg as { ltp?: number }).ltp;
        if (msg.t === "q" && typeof price === "number" && price > 0) setLtp(price);
      }),
    [hub, id],
  );

  useEffect(() => {
    let cancelled = false;
    previousClose(id)
      .then((p) => !cancelled && setPrev(p))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  const pct = ltp !== null && prev ? ((ltp - prev) / prev) * 100 : null;
  const tone = pct === null || Math.abs(pct) < 0.005 ? "" : pct > 0 ? "mh-up" : "mh-down";
  return (
    <span className="mh-ticker-item">
      <span className="mh-ticker-name">{name}</span>
      <span className="mh-ticker-price">{ltp !== null ? fmt2(ltp) : "—"}</span>
      {pct !== null ? (
        <span className={`mh-ticker-move ${tone}`}>
          ({pct > 0.005 ? "+" : pct < -0.005 ? "−" : ""}
          {Math.abs(pct).toFixed(2)}%)
        </span>
      ) : null}
    </span>
  );
}

export function Ticker({ hub }: Readonly<{ hub: Hub }>) {
  return (
    <div className="mh-ticker" aria-label="Indices">
      {INDICES.map((index) => (
        <IndexPrice key={index.id} hub={hub} id={index.id} name={index.name} />
      ))}
    </div>
  );
}
