import { istDate, nearestExpiry } from "./format";
import type { Underlying } from "../hub/types";

/**
 * The underlying a straddle chart opens on by itself: the one whose nearest expiry is closest, from
 * the market that is trading.
 *
 * - NSE and BSE indices trade 09:15 to 15:30 IST on weekdays; in that window the pick is among
 *   them. After 15:30 (and on weekends, and before the open) it is among the MCX commodities, which
 *   trade into the night.
 * - Of the MCX ones, GOLD and CRUDEOIL are the liquid contracts, so when either is listed the pick
 *   is between those two; any other commodity only when neither is.
 * - Ties on the expiry go to the more traded name, in the order below.
 */
const PRIORITY = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "GOLD"];
const LIQUID_MCX = new Set(["CRUDEOIL", "GOLD"]);

const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;

const isMcx = (u: Underlying) => u.id.startsWith("mcx:");

/** Whether the NSE/BSE cash session is on at `now` (IST, weekdays). */
function nseTrading(now: number): boolean {
  const ist = new Date(now + 330 * 60_000);
  const day = ist.getUTCDay();
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && minute >= OPEN_MIN && minute < CLOSE_MIN;
}

const rank = (u: Underlying) => {
  const i = PRIORITY.indexOf(u.name);
  return i < 0 ? PRIORITY.length : i;
};

export function defaultUnderlying(universe: readonly Underlying[], now = Date.now()): Underlying | null {
  const today = istDate(now);
  // An underlying with no expiry left today or later cannot open a straddle.
  const live = universe.filter((u) => nearestExpiry(u.expiries) >= today);
  const nse = live.filter((u) => !isMcx(u));
  const mcx = live.filter(isMcx);
  const liquid = mcx.filter((u) => LIQUID_MCX.has(u.name));
  const mcxPool = liquid.length > 0 ? liquid : mcx;
  const pool = nseTrading(now) ? (nse.length > 0 ? nse : mcxPool) : mcxPool.length > 0 ? mcxPool : nse;
  let best: Underlying | null = null;
  for (const u of pool) {
    if (!best) {
      best = u;
      continue;
    }
    const a = nearestExpiry(u.expiries);
    const b = nearestExpiry(best.expiries);
    if (a < b || (a === b && rank(u) < rank(best))) best = u;
  }
  return best;
}
