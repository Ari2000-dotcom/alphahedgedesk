/**
 * Black-76 on a forward, rate 0: the model the hub uses for ATM IV (hub/src/straddle.rs), here
 * for the option chain's per-strike IV. Prices in, annualised vol out, by bisection.
 */

function cdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = 0.3989423 * Math.exp((-x * x) / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Undiscounted call or put on forward `f`, strike `k`, `t` years, vol `sigma`. */
export function black76(f: number, k: number, t: number, sigma: number, call: boolean): number {
  const sd = sigma * Math.sqrt(t);
  if (sd <= 0) return Math.max(0, call ? f - k : k - f);
  const d1 = (Math.log(f / k) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  return call ? f * cdf(d1) - k * cdf(d2) : k * cdf(-d2) - f * cdf(-d1);
}

/**
 * Delta of a call or put on the forward: the model's own delta (rate 0, so the forward's delta is
 * the spot's). N(d1) for a call, N(d1) - 1 for a put, so a put's is negative — the sign the
 * delta x OI panel adds up. Vol is annualised (0.14, not 14).
 */
export function delta76(f: number, k: number, t: number, sigma: number, call: boolean): number {
  if (!(f > 0) || !(k > 0)) return 0;
  const sd = sigma * Math.sqrt(t);
  // At expiry, or with no vol, delta is the step: 1 in the money, 0 out of it.
  if (!(sd > 0)) return call ? (f > k ? 1 : 0) : f < k ? -1 : 0;
  const d1 = (Math.log(f / k) + (sd * sd) / 2) / sd;
  return call ? cdf(d1) : cdf(d1) - 1;
}

/** Implied vol in percent, or null when the price sits outside what the model can reach. */
export function impliedVol(price: number, f: number, k: number, t: number, call: boolean): number | null {
  if (!(price > 0) || !(f > 0) || !(k > 0) || !(t > 0)) return null;
  const intrinsic = Math.max(0, call ? f - k : k - f);
  if (price <= intrinsic + 1e-9) return null;
  let lo = 0.001;
  let hi = 5;
  if (black76(f, k, t, hi, call) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (black76(f, k, t, mid, call) > price) hi = mid;
    else lo = mid;
  }
  return ((lo + hi) / 2) * 100;
}

const YEAR_MS = 365 * 86_400_000;

/** Years from `now` to the expiry's close: 15:40 IST (MCX: 23:30), the hub's own convention. */
export function yearsToExpiry(expiry: string, mcx: boolean, now = Date.now()): number {
  const close = new Date(`${expiry}T${mcx ? "23:30" : "15:40"}:00+05:30`).getTime();
  return Math.max(0, (close - now) / YEAR_MS);
}
