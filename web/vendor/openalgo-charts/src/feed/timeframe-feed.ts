import type { Bar } from '../model/bar';
import type { BarsPage, BarsPageRequest, BarsRequest, DataFeed } from './types';
import { resolveInterval } from './intervals';
import { sharedHistoryRequests, withHistoryDeadline, type HistoryRequestPool } from './request-pool';
import { planTimeframe, timeframeBucketAt, type TimeframeMarket, type TimeframePlan } from './timeframe-plan';
import { aggregateTimeframeBars } from './timeframe-bars';
import { subscribeTimeframe } from './timeframe-live';

/** Capabilities must be loaded by the host before this synchronous lookup. */
export interface TimeframeFeedOptions {
  market(request: BarsRequest): TimeframeMarket;
  /** UTC seconds; injectable for deterministic hosts. */
  now?: () => number;
}

/** Opt-in resampling, with ownership limited to this wrapper's requests and streams. */
export interface TimeframeFeed extends DataFeed {
  resolve(request: BarsRequest): TimeframePlan;
  destroy(): void;
}

function duration(code: string): number {
  const b = resolveInterval(code).bucketing;
  return b.mode === 'interval' ? b.seconds : b.mode === 'calendar'
    ? (b.count ?? 1) * ({ month: 31, quarter: 93, year: 366 }[b.unit]) * 86400 : 0;
}

function windowOf(req: BarsRequest, plan: TimeframePlan): { from: number; to: number } {
  if (!Number.isFinite(req.from) || !Number.isFinite(req.to) || req.to! <= req.from!) throw new Error('Derived history needs a finite ascending date range');
  const next = plan.market.calendar.sessionFrom(req.from!);
  const first = timeframeBucketAt(plan, req.from!) ?? (next && timeframeBucketAt(plan, next.open));
  const last = timeframeBucketAt(plan, req.to! - 1);
  const from = first?.from ?? req.from!, to = last?.to ?? req.to!;
  if (plan.source.earliest !== undefined && from < plan.source.earliest) throw new Error('Insufficient source coverage for complete timeframe bucket');
  return { from, to };
}

async function sourceHistory(pool: HistoryRequestPool, paged: boolean, req: BarsRequest, plan: TimeframePlan): Promise<Bar[]> {
  const { from, to } = windowOf(req, plan);
  if (from >= to) return [];
  const wire = { ...req, interval: plan.source.interval, from, to };
  const output: Bar[] = [];
  let cursor = to;
  const span = Math.min(plan.source.maxSpanSeconds ?? Infinity, (plan.source.maxBars ?? Infinity) * duration(plan.source.interval));
  if (!(span > 0)) throw new Error('Invalid source history limit');
  for (let calls = 0; cursor > from; calls++) {
    if (calls >= 512 || output.length > 100_000) throw new Error('Timeframe history safety limit reached; request a smaller range');
    const lower = Math.max(from, cursor - span);
    if (paged) {
      const page = await pool.getBarsPage({ ...wire, from: lower, to: cursor, before: cursor, countBack: plan.source.maxBars ?? 5000 });
      output.push(...page.bars.filter(bar => bar.time >= from && bar.time < to));
      if (page.hasMore === false) break;
      const next = page.nextBefore ?? (page.bars.length ? Math.min(...page.bars.map(bar => bar.time)) : lower);
      if (!(next < cursor)) throw new Error('Source history page did not advance');
      cursor = next;
    } else {
      const bars = await pool.getBars({ ...wire, from: lower, to: cursor });
      output.push(...bars.filter(bar => bar.time >= from && bar.time < to));
      cursor = lower;
    }
  }
  return output;
}

/** Derive only compatible whole candles; never upsample an unavailable source. */
export function withTimeframes(feed: DataFeed, options: TimeframeFeedOptions): TimeframeFeed {
  const pool = sharedHistoryRequests(feed), controllers = new Set<AbortController>(), subscriptions = new Set<() => void>();
  let destroyed = false;
  const resolve = (req: BarsRequest): TimeframePlan => {
    if (destroyed) throw new Error('Timeframe feed is destroyed');
    return planTimeframe(req, options.market(req));
  };
  const own = async <T>(req: BarsRequest, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (destroyed) throw new Error('Timeframe feed is destroyed');
    const controller = new AbortController(), abort = (): void => controller.abort();
    controllers.add(controller);
    req.signal?.addEventListener('abort', abort, { once: true });
    if (req.signal?.aborted) abort();
    try { return await withHistoryDeadline({ ...req, signal: controller.signal }, run); }
    finally { controllers.delete(controller); req.signal?.removeEventListener('abort', abort); }
  };
  const getBars = (req: BarsRequest): Promise<Bar[]> => own(req, async signal => {
    const plan = resolve(req), request = { ...req, signal };
    if (plan.native) return pool.getBars({ ...request, interval: plan.source.interval });
    return aggregateTimeframeBars(await sourceHistory(pool, !!feed.getBarsPage, request, plan), plan);
  });
  const getBarsPage = (req: BarsPageRequest): Promise<BarsPage> => own(req, async signal => {
    if (!Number.isInteger(req.countBack) || req.countBack < 1 || req.countBack > 100_000) throw new Error('Invalid timeframe page count');
    const plan = resolve(req);
    if (plan.native && feed.getBarsPage) return pool.getBarsPage({ ...req, signal, interval: plan.source.interval });
    const to = req.before, from = Math.max(plan.source.earliest ?? -Infinity, req.from ?? to - duration(req.interval) * req.countBack * 2);
    if (from >= to) return { bars: [], hasMore: false, nextBefore: from };
    const bars = (await getBars({ ...req, signal, from, to })).filter(bar => bar.time < to).slice(-req.countBack);
    const nextBefore = bars[0]?.time ?? from;
    return { bars, nextBefore, ...(plan.source.earliest !== undefined && nextBefore <= plan.source.earliest ? { hasMore: false } : {}) };
  });
  const ownSubscription = (off: () => void): (() => void) => {
    let active = true;
    const stop = (): void => { if (!active) return; active = false; subscriptions.delete(stop); off(); };
    subscriptions.add(stop);
    return stop;
  };
  const result: TimeframeFeed = { resolve, getBars, getBarsPage, destroy() {
    destroyed = true;
    for (const controller of controllers) controller.abort();
    for (const stop of subscriptions) stop();
  } };
  if (feed.subscribeBars) result.subscribeBars = (req, onBar, opts = {}) => {
    const plan = resolve(req);
    return ownSubscription(plan.native
      ? feed.subscribeBars!({ ...req, interval: plan.source.interval }, onBar, opts)
      : subscribeTimeframe(feed, req, plan, onBar, opts, (options.now ?? (() => Date.now() / 1000))()));
  };
  if (feed.dataVariants) result.dataVariants = query => feed.dataVariants!({ ...query, interval: resolve(query).source.interval });
  if (feed.searchSymbols) result.searchSymbols = query => own({ symbol: '', exchange: '', interval: '', signal: query.signal }, signal => feed.searchSymbols!({ ...query, signal }));
  if (feed.subscribeDepth) result.subscribeDepth = (req, onDepth, opts) => { resolve(req); return ownSubscription(feed.subscribeDepth!(req, onDepth, opts)); };
  if (feed.getCachedBars) result.getCachedBars = req => own(req, async signal => {
    const plan = resolve(req);
    if (!plan.native) return undefined;
    return feed.getCachedBars!({ ...req, signal, interval: plan.source.interval });
  });
  return result;
}
