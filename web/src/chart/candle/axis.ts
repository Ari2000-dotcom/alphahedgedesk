import { istHhMm, istMinuteOfDay, niceStep, timeLabelStep } from "../lite/ticks";

/**
 * Axis maths for the candle engine. Pure — no canvas, no DOM, and no `Date`:
 * the time axis walks every visible bar on each redraw, so calendar parts come
 * from integer arithmetic rather than an allocation per bar.
 *
 * Two tiers on both axes: a price on an even multiple of the step, and a day,
 * month or year boundary on the time axis, is a MAJOR — drawn bright and
 * emphasised; the rest are minors, drawn quietly. The plot carries no
 * gridlines, so these tiers are what the eye reads levels off.
 */

/** The price step for a scale `range` wide drawn `heightPx` tall, aiming for a label every `targetPx`. */
export function priceStep(range: number, heightPx: number, targetPx: number): number {
  return niceStep(range, Math.max(2, heightPx / targetPx));
}

/**
 * Whether the tick `k × step` is a major. Parity of `k`, not of the label's
 * place on screen, so a level stays major (or minor) while the chart pans.
 */
export function isMajorTick(k: number): boolean {
  return ((k % 2) + 2) % 2 === 0;
}

/** How much a bar boundary matters on the time axis. */
export const TimeWeight = {
  None: 0,
  Time: 1,
  Day: 2,
  Month: 3,
  Year: 4,
} as const;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The IST day number of an instant — equal for two instants on the same IST date. */
export function istDay(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
}

/** Calendar parts, written here by `civil` — one scratch object, never an allocation. */
const CIVIL = { year: 1970, month: 0, day: 1 };

/** Year, month (0–11) and day of a day number since 1970-01-01 (Hinnant's civil-from-days). */
function civil(days: number): typeof CIVIL {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  CIVIL.year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  CIVIL.month = month - 1;
  CIVIL.day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  return CIVIL;
}

/**
 * The weight of the boundary at bar time `t`, given the bar before it.
 *
 * Intraday, `stepMin` is the label step: a bar whose SLOT starts on it is a
 * `Time` boundary — a 1h bar starting at 09:15 still labels the 09:00 hour,
 * where `09:15 % 60` never would.
 */
export function timeWeight(prev: number | null, t: number, slotMinutes: number, stepMin: number): number {
  if (prev === null) return TimeWeight.Day;
  const dayPrev = istDay(prev);
  const dayNow = istDay(t);
  if (dayPrev !== dayNow) {
    const a = civil(dayPrev);
    const yearPrev = a.year;
    const monthPrev = a.month;
    const b = civil(dayNow);
    if (b.year !== yearPrev) return TimeWeight.Year;
    if (b.month !== monthPrev) return TimeWeight.Month;
    return TimeWeight.Day;
  }
  if (slotMinutes >= 1440) return TimeWeight.None;
  const slot = Math.max(1, Math.round(slotMinutes));
  const mod = istMinuteOfDay(t);
  return (mod - (mod % slot)) % stepMin === 0 ? TimeWeight.Time : TimeWeight.None;
}

/** The time-axis label step, in minutes, for bars `slotMinutes` wide drawn `spacingPx` apart. */
export function timeStep(slotMinutes: number, spacingPx: number, minLabelPx: number): number {
  return slotMinutes >= 1440 ? 1440 : timeLabelStep(slotMinutes, spacingPx, minLabelPx);
}

/** Whether a label of this weight is a major on an axis of `slotMinutes` bars. */
export function isMajorTime(weight: number, slotMinutes: number): boolean {
  return slotMinutes >= 1440 ? weight >= TimeWeight.Month : weight >= TimeWeight.Day;
}

/** The text of a time-axis label. */
export function timeLabel(t: number, weight: number, slotMinutes: number): string {
  if (slotMinutes < 1440 && weight < TimeWeight.Day) return istHhMm(t);
  const p = civil(istDay(t));
  if (slotMinutes < 1440) {
    return weight === TimeWeight.Year ? `${p.day} ${MONTHS[p.month]} ${p.year}` : `${p.day} ${MONTHS[p.month]}`;
  }
  if (weight === TimeWeight.Year) return String(p.year);
  if (weight === TimeWeight.Month) return MONTHS[p.month]!;
  return String(p.day);
}

/** The crosshair's date line: `Wed 30 Sep '26  09:15`, without the time for daily bars. */
export function crosshairTime(t: number, slotMinutes: number): string {
  const days = istDay(t);
  const weekday = WEEKDAYS[(((days + 4) % 7) + 7) % 7]; // 1970-01-01 was a Thursday
  const p = civil(days);
  const date = `${weekday} ${p.day} ${MONTHS[p.month]} '${String(p.year % 100).padStart(2, "0")}`;
  return slotMinutes < 1440 ? `${date}  ${istHhMm(t)}` : date;
}

/** How long ago, compactly: `now`, `12m ago`, `3h 12m ago`, `4d 18h ago`, `3mo ago`. */
export function ageText(ms: number): string {
  if (ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return hours % 24 ? `${days}d ${hours % 24}h ago` : `${days}d ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return months % 12 ? `${years}y ${months % 12}mo ago` : `${years}y ago`;
}

/** Time left on a bar, for its tag: `02:41`, or `1:02:41` past an hour. */
export function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The bar width in minutes, from the data: the smallest gap between recent
 * bars. Nights and weekends only ever widen a gap, so the smallest one is the
 * interval itself — 1 for 1m, 1440 for daily, ≥ 28 days for monthly.
 */
export function inferSlotMinutes(time: Float64Array, length: number): number {
  let best = Infinity;
  for (let i = Math.max(1, length - 200); i < length; i++) {
    const gap = time[i]! - time[i - 1]!;
    if (gap > 0 && gap < best) best = gap;
  }
  return Number.isFinite(best) ? Math.max(1, Math.round(best / 60_000)) : 1;
}
