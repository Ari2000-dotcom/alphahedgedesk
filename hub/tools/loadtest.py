"""Load test for the hub: many users at once, checks the two promises.

1. Live: N users subscribe to the same topic; for every update, measure the
   spread between the first and last user receiving it.
2. History: M users request overlapping ranges at the same moment; check that
   broker calls == unique pieces (merging works) and no broker limit was hit.

Usage:  python tools/loadtest.py [--live-users 300] [--hist-users 100] [--kotak]
"""

import argparse
import asyncio
import json
import random
import statistics
import time
import urllib.request

import websockets

HUB = "127.0.0.1:8080"


def stats():
    return json.loads(urllib.request.urlopen(f"http://{HUB}/stats", timeout=10).read())


async def live_user(topic, seconds, recv, ready):
    async with websockets.connect(f"ws://{HUB}/ws", max_queue=None) as ws:
        await ws.send(json.dumps({"op": "sub", "topics": [topic]}))
        ready.release()
        end = time.monotonic() + seconds
        mine = {}
        while (left := end - time.monotonic()) > 0:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=left)
            except asyncio.TimeoutError:
                break
            t = time.perf_counter_ns()
            m = json.loads(raw)
            if m.get("t") == "q":
                mine[m["seq"]] = t
        recv.append(mine)


async def test_live(users, seconds):
    topic = "quote:SIM:1"
    recv, ready = [], asyncio.Semaphore(0)
    tasks = [asyncio.create_task(live_user(topic, seconds, recv, ready)) for _ in range(users)]
    for _ in range(users):
        await ready.acquire()
    await asyncio.gather(*tasks)

    # Only updates every user saw (skip the first second while users were joining).
    common = set.intersection(*(set(r) for r in recv))
    seqs = sorted(common)[10:]
    spreads = [(max(r[s] for r in recv) - min(r[s] for r in recv)) / 1e6 for s in seqs]
    spreads.sort()
    print(f"\n=== LIVE: {users} users on {topic} for {seconds}s ===")
    print(f"updates seen by all users : {len(seqs)}")
    if spreads:
        print(f"first→last user spread ms : median {statistics.median(spreads):.2f}  "
              f"p99 {spreads[int(len(spreads) * 0.99) - 1]:.2f}  max {spreads[-1]:.2f}")
    print("(spread includes this test client's own scheduling of", users, "sockets in one Python process)")


async def hist_user(req, out):
    async with websockets.connect(f"ws://{HUB}/ws", max_queue=None) as ws:
        t0 = time.perf_counter()
        await ws.send(json.dumps({"op": "history", **req}))
        pieces = errors = 0
        while True:
            m = json.loads(await ws.recv())
            if m["t"] == "hist":
                pieces += 1
            elif m["t"] == "hist_err":
                errors += 1
                if "day" not in m:
                    break
            if m["t"] == "hist_done":
                break
        out.append((req, pieces, errors, time.perf_counter() - t0))


async def test_history(users, use_kotak):
    before = stats()
    reqs = []
    end = "2026-10-23"
    for i in range(users):
        if use_kotak and i % 4 == 0:
            # Real broker: overlapping 5/10/20-day ranges on RELIANCE.
            days = random.choice([5, 10, 20])
            reqs.append({"req": f"k{i}", "id": "NSE_EQ:2885", "interval": "5m",
                         "from": _back(end, days), "to": end})
        else:
            days = random.choice([5, 10, 30, 60])
            reqs.append({"req": f"s{i}", "id": f"SIM:{random.randint(1, 5)}", "interval": "1m",
                         "from": _back(end, days), "to": end})
    out = []
    t0 = time.perf_counter()
    await asyncio.gather(*(hist_user(r, out) for r in reqs))
    took = time.perf_counter() - t0
    after = stats()

    h0, h1 = before["history"], after["history"]
    d = lambda k: h1[k] - h0[k]
    user_pieces = sum(p for _, p, _, _ in out)
    durs = sorted(t for *_, t in out)
    print(f"\n=== HISTORY: {users} users at the same moment, overlapping ranges ===")
    print(f"all users done in        : {took:.1f}s  (median user {statistics.median(durs):.1f}s, slowest {durs[-1]:.1f}s)")
    print(f"pieces delivered to users: {user_pieces}  (errors {sum(e for _, _, e, _ in out)})")
    print(f"broker calls made        : {d('broker_calls_ok')}  "
          f"→ {user_pieces / max(1, d('broker_calls_ok')):.1f} users served per call")
    print(f"merged into running fetch: {d('merged_into_existing_fetch')}")
    print(f"broker said 'rate limited': {d('rate_limited_by_broker')}   ← must be 0")
    sim0, sim1 = before["extra"].get("sim_server", {}), after["extra"].get("sim_server", {})
    if sim1:
        print(f"sim broker: calls {sim1['calls_received'] - sim0.get('calls_received', 0)}, "
              f"limit violations {sim1['limit_violations'] - sim0.get('limit_violations', 0)}   ← must be 0")
    for name, b in h1["brokers"].items():
        print(f"  {name}: granted {b['granted']}, penalties {b['penalties']}, windows {b['windows']}")


def _back(end, days):
    import datetime as dt
    return (dt.date.fromisoformat(end) - dt.timedelta(days=days - 1)).isoformat()


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--live-users", type=int, default=300)
    p.add_argument("--live-seconds", type=int, default=10)
    p.add_argument("--hist-users", type=int, default=100)
    p.add_argument("--kotak", action="store_true", help="include real Kotak history requests")
    a = p.parse_args()
    if a.live_users:
        await test_live(a.live_users, a.live_seconds)
    if a.hist_users:
        await test_history(a.hist_users, a.kotak)


if __name__ == "__main__":
    asyncio.run(main())
