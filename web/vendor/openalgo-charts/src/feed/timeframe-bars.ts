import type { Bar } from '../model/bar';
import { timeframeBucketAt, type TimeframePlan } from './timeframe-plan';

/** Sort, replace repeated source timestamps, then fold only whole source candles. */
export function aggregateTimeframeBars(bars: readonly Bar[], plan: TimeframePlan): Bar[] {
  const sorted = Array.from(new Map(bars.map(bar => [bar.time, bar])).values()).sort((a, b) => a.time - b.time);
  if (plan.native) return sorted.map(bar => ({ ...bar }));
  const output: Bar[] = [];
  for (const bar of sorted) {
    const source = plan.source.bounds(bar.time);
    if (!source) throw new Error('Unknown source candle boundaries');
    const bucket = timeframeBucketAt(plan, source.from);
    if (!bucket || source.to <= source.from || source.from < bucket.from || source.to > bucket.to) {
      throw new Error('Source candle crosses timeframe boundaries');
    }
    const last = output[output.length - 1];
    if (!last || last.time !== bucket.time) { output.push({ ...bar, time: bucket.time }); continue; }
    last.high = Math.max(last.high, bar.high);
    last.low = Math.min(last.low, bar.low);
    last.close = bar.close;
    if (last.volume !== undefined && bar.volume !== undefined) last.volume += bar.volume;
    else delete last.volume;
    if (bar.oi !== undefined) last.oi = bar.oi;
    else delete last.oi;
  }
  return output;
}
