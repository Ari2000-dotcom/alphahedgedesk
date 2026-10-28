import { useEffect, useState } from "react";

import { fmt2 } from "../core/format";
import { previousClose } from "../core/previousClose";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";

/** The indices in the title bar, as AlphaHedge shows them. */
const INDICES = [
  { id: "nse:nifty", name: "NIFTY" },
  { id: "nse:banknifty", name: "BANKNIFTY" },
  { id: "bse:sensex", name: "SENSEX" },
];

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
