import { useEffect, useState } from "react";

import { fmt2 } from "../core/format";
import { previousClose } from "../core/previousClose";
import type { Hub } from "../hub/client";
import type { TopicMessage } from "../hub/types";
import { useFitRow } from "../ui/fitRow";

/** The indices in the title bar, as AlphaHedge shows them. */
const INDICES = [
  { id: "nse:nifty", name: "NIFTY" },
  { id: "nse:banknifty", name: "BANKNIFTY" },
  { id: "bse:sensex", name: "SENSEX" },
];

function IndexPrice({ hub, id, name, drop }: Readonly<{ hub: Hub; id: string; name: string; drop: number }>) {
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
    <span className="mh-ticker-item" data-drop={drop}>
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

/**
 * The indices, measured into the room the title bar has (ui/fitRow.ts): the last gives way first,
 * so a narrow window keeps NIFTY and never pushes the bar's own buttons off its edge.
 */
export function Ticker({ hub }: Readonly<{ hub: Hub }>) {
  const fit = useFitRow();
  return (
    <div className="mh-ticker" aria-label="Indices" ref={fit}>
      {INDICES.map((index, i) => (
        <IndexPrice key={index.id} hub={hub} id={index.id} name={index.name} drop={INDICES.length - i} />
      ))}
    </div>
  );
}
