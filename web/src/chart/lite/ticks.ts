import { isPositive } from "../../core/num";

/**
 * Axis tick maths for the lite chart: "nice" value steps (1, 2, 5 × 10ⁿ) for a
 * value axis, and clock-aligned label steps for an intraday time axis.
 *
 * Pure functions, no canvas — so they are unit-testable and shared by any
 * scale the engine grows later.
 */

/** A step of 1, 2 or 5 × 10ⁿ that splits `range` into about `count` parts. */
export function niceStep(range: number, count: number): number {
  if (!isPositive(range) || !isPositive(count)) return 1;
  const raw = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const unit = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return unit * magnitude;
}

/** Tick values on `step` inside [lo, hi], free of float noise (0.30000000000000004). */
export function niceTicks(lo: number, hi: number, step: number): number[] {
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi <= lo || !isPositive(step)) return [];
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    ticks.push(Number(v.toFixed(decimals)));
    if (ticks.length > 200) break; // a guard, never reached at sane sizes
  }
  return ticks;
}

/** Label steps a time axis may use, in minutes. */
const MINUTE_STEPS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 180, 240, 360];

/**
 * The label step, in minutes, for slots `slotMinutes` wide drawn `slotPx`
 * apart: the smallest clock-friendly step that is a whole number of slots and
 * keeps labels at least `minLabelPx` apart. Past the last candidate it falls
 * back to a plain multiple of the slot.
 */
export function timeLabelStep(slotMinutes: number, slotPx: number, minLabelPx: number): number {
  const slot = Math.max(1, Math.round(slotMinutes));
  for (const step of MINUTE_STEPS) {
    if (step % slot !== 0) continue;
    if ((step / slot) * slotPx >= minLabelPx) return step;
  }
  return slot * Math.max(1, Math.ceil(minLabelPx / Math.max(slotPx, 0.1)));
}

/** IST has no DST: a fixed +05:30 is exact, and far cheaper per label than Intl. */
const IST_OFFSET_MIN = 330;

/** Minutes since IST midnight. */
export function istMinuteOfDay(ms: number): number {
  const m = Math.floor(ms / 60_000) + IST_OFFSET_MIN;
  return ((m % 1440) + 1440) % 1440;
}

/** The IST calendar day number — equal for two instants on the same IST date. */
export function istDayNumber(ms: number): number {
  return Math.floor((Math.floor(ms / 60_000) + IST_OFFSET_MIN) / 1440);
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** `09:15`, IST. */
export function istHhMm(ms: number): string {
  const m = istMinuteOfDay(ms);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `25 Sep`, IST. */
export function istDayMonth(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MIN * 60_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Compact value labels: 1.25Cr, 52.8L, 9.4K, 0.25 — for a default axis. */
export function compactNumber(value: number): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const trim = (n: number) => String(Number(n.toFixed(2)));
  if (abs >= 1e7) return `${sign}${trim(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}${trim(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}${trim(abs / 1e3)}K`;
  return `${sign}${trim(abs)}`;
}
