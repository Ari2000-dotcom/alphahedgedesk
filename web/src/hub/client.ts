import type { TopicMessage } from "./types";

/**
 * One WebSocket to the hub per browser tab, shared by everything on the page.
 *
 * - **Reconnects by itself** with exponential backoff and full jitter: after a
 *   hub restart, thousands of tabs come back spread over up to 30 s instead of
 *   all in the same second (which would look like an attack and slow everyone).
 * - **Resubscribes** every topic the page still wants once it is back.
 * - **Requests** (search, chain, past straddle) carry a `req` id and resolve
 *   with the reply that echoes it; they fail fast when the connection drops,
 *   and the caller retries.
 * - The hub pings every 30 s; the browser answers by itself.
 */

export type HubStatus = "connecting" | "open" | "reconnecting" | "closed";

type Listener = (msg: TopicMessage) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  want: string;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/** The hub's socket at this page's own address (Caddy, or Vite in development, passes it on). */
export function hubUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

export class Hub {
  private ws: WebSocket | null = null;
  private readonly topics = new Map<string, Set<Listener>>();
  /** Each quote topic's latest message: a quote is its whole state, so a late listener can have it. */
  private readonly lastQuote = new Map<string, TopicMessage>();
  private readonly pending = new Map<string, Pending>();
  private readonly statusListeners = new Set<(s: HubStatus) => void>();
  private status: HubStatus = "connecting";
  private attempt = 0;
  private nextReq = 1;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Topics to subscribe or drop, sent as one message each per tick: a chain opens dozens at once. */
  private readonly subQ = new Set<string>();
  private readonly unsubQ = new Set<string>();
  private flushing = false;
  private stopped = false;

  constructor(private readonly url: string) {
    this.open();
  }

  get state(): HubStatus {
    return this.status;
  }

  onStatus(fn: (s: HubStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  /**
   * Messages for `topic` go to `fn` until the returned function is called.
   *
   * The hub sends a topic's current state only on a fresh "sub", so a listener joining a topic the
   * page already holds (the chain's spot after the title bar's index, a second chart of one
   * straddle) would otherwise wait for the next tick, which a closed market never sends. It gets
   * the last quote at once, or, for any other topic, the hub is asked again and sends its state
   * (a straddle's session so far) to every listener, which each take as a fresh start.
   */
  subscribe(topic: string, fn: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
      this.queue("sub", topic);
    } else if (!this.subQ.has(topic)) {
      // Already live for another listener: the last quote at once, or the hub asked again.
      const joined = set;
      const last = this.lastQuote.get(topic);
      if (last) queueMicrotask(() => joined.has(fn) && fn(last));
      else {
        this.queue("unsub", topic);
        this.queue("sub", topic);
      }
    }
    set.add(fn);
    return () => {
      const s = this.topics.get(topic);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) {
        this.topics.delete(topic);
        this.lastQuote.delete(topic);
        this.queue("unsub", topic);
      }
    };
  }

  /** Sends `op` with a fresh `req` id and resolves with the reply of type `want`. */
  request<T>(op: Record<string, unknown>, want: string, timeoutMs = 60_000): Promise<T> {
    const req = `r${this.nextReq++}`;
    return new Promise<T>((resolve, reject) => {
      if (this.status !== "open") {
        reject(new Error("Not connected to the hub yet."));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(req);
        reject(new Error("The hub did not answer in time."));
      }, timeoutMs);
      this.pending.set(req, { resolve: resolve as (v: unknown) => void, reject, timer, want });
      this.send({ ...op, req });
    });
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.setStatus("closed");
  }

  // ---------------------------------------------------------------------------

  private open(): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      // Everything the page still wants, in one message.
      if (this.topics.size > 0) this.send({ op: "sub", topics: [...this.topics.keys()] });
    };
    ws.onmessage = (event) => this.receive(event.data as string);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [req, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Connection to the hub was lost; try again."));
        this.pending.delete(req);
      }
      if (this.stopped) return;
      // Full jitter: a random wait up to the current backoff ceiling.
      const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt);
      this.attempt += 1;
      this.setStatus("reconnecting");
      this.retryTimer = setTimeout(() => this.open(), 250 + Math.random() * ceiling);
    };
  }

  private receive(data: string): void {
    let msg: TopicMessage & { req?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.req && this.pending.has(msg.req)) {
      const p = this.pending.get(msg.req)!;
      if (msg.t === p.want || msg.t === "err") {
        clearTimeout(p.timer);
        this.pending.delete(msg.req);
        if (msg.t === "err") p.reject(new Error(String((msg as { error?: unknown }).error ?? "error")));
        else p.resolve(msg);
        return;
      }
    }
    if (msg.topic) {
      const listeners = this.topics.get(msg.topic);
      if (msg.t === "q" && listeners) this.lastQuote.set(msg.topic, msg);
      for (const fn of listeners ?? []) fn(msg);
    }
  }

  /**
   * One message of each kind per tick. A topic taken up and dropped in the same tick never reaches
   * the hub. One dropped and taken up again (a screen switch replacing a chart with another on the
   * same topic, a chart asking for its session again) is sent as both, the drop first: the hub sends
   * a topic's current state (the last quote, a straddle's session so far) only on a fresh "sub", and
   * the new listeners have none of it. Cancelling that pair left a new chart on "Connecting" for
   * good. The hub keeps the feed itself for a while after a drop, so the pair costs it nothing.
   */
  private queue(kind: "sub" | "unsub", topic: string): void {
    if (kind === "sub") {
      this.subQ.add(topic);
    } else if (!this.subQ.delete(topic)) {
      this.unsubQ.add(topic);
    }
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      if (this.unsubQ.size > 0) this.send({ op: "unsub", topics: [...this.unsubQ] });
      if (this.subQ.size > 0) this.send({ op: "sub", topics: [...this.subQ] });
      this.unsubQ.clear();
      this.subQ.clear();
    });
  }

  private send(op: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(op));
    // Otherwise it is sent on (re)connect: subscriptions are replayed, requests refused.
  }

  private setStatus(s: HubStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }
}
