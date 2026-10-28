import { istDate } from "./format";

const DAY_MS = 86_400_000;

/**
 * The last session's close before today, from the hub's daily candles. Asked only up to
 * yesterday, so the browser keeps the answer for the day. Shared by the ticker and any chart
 * that reports a day's change independent of its own candle interval.
 */
export function previousClose(id: string): Promise<number | null> {
  // Asked once a day per instrument and shared: the ticker and every chart of it read the same close.
  const key = `${id}|${istDate(Date.now())}`;
  let close = closes.get(key);
  if (!close) {
    close = fetchPreviousClose(id);
    closes.set(key, close);
    close.catch(() => closes.delete(key));
  }
  return close;
}

const closes = new Map<string, Promise<number | null>>();

async function fetchPreviousClose(id: string): Promise<number | null> {
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
