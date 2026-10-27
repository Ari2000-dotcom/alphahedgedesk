/** Number and date formats (the subset of QuantDesk's core/format the straddle screen uses). */

const two = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const upTo2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export const fmt2 = (v: number) => two.format(v);
export const fmtUpTo2 = (v: number) => upTo2.format(v);
export const fmt0 = (v: number) => whole.format(v);

/** `YYYY-MM-DD` of an instant, in IST: the calendar a session is named by. */
export const IST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

export const istDate = (ms: number) => IST_DATE.format(new Date(ms));

const DAY_LABEL = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
const DAY_LABEL_YEAR = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

/** "Fri, 23 Oct" for a `YYYY-MM-DD` this year; "28 Sept 2027" for another year. */
export const dayLabel = (ymd: string) => {
  const at = new Date(`${ymd}T12:00:00+05:30`);
  const thisYear = istDate(Date.now()).slice(0, 4) === ymd.slice(0, 4);
  return (thisYear ? DAY_LABEL : DAY_LABEL_YEAR).format(at);
};

/** The last `n` weekdays before today (IST), newest first. Holidays are the hub's to refuse. */
export function pastWeekdays(n: number): string[] {
  const out: string[] = [];
  const today = istDate(Date.now());
  let d = new Date(`${today}T12:00:00+05:30`);
  while (out.length < n) {
    d = new Date(d.getTime() - 86_400_000);
    const ymd = istDate(d.getTime());
    const weekday = new Date(`${ymd}T12:00:00+05:30`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(ymd);
  }
  return out;
}
