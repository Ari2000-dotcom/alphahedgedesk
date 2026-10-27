/**
 * `value > 0`, named for the guards that use it.
 *
 * False for zero, negatives AND `NaN`, which is the point: a guard written
 * `if (!isPositive(price)) skip` drops a `NaN` price, while the tempting
 * rewrite `if (price <= 0) skip` would wave it through into charts and IV.
 */
export function isPositive(value: number): boolean {
  return value > 0;
}

/** `n + 1`, for state updaters: `setAttempt(increment)`. */
export function increment(n: number): number {
  return n + 1;
}
