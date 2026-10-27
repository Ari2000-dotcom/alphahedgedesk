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
  private readonly pending = new Map<string, Pending>();
  private readonly statusListeners = new Set<(s: HubStatus) => void>();
  private status: HubStatus = "connecting";
  private attempt = 0;
  private nextReq = 1;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** Messages for `topic` go to `fn` until the returned function is called. */
  subscribe(topic: string, fn: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
      this.send({ op: "sub", topics: [topic] });
    }
    set.add(fn);
    return () => {
      const s = this.topics.get(topic);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) {
        this.topics.delete(topic);
        this.send({ op: "unsub", topics: [topic] });
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
      for (const fn of this.topics.get(msg.topic) ?? []) fn(msg);
    }
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
