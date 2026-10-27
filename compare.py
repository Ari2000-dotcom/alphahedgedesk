"""Compare tick CSVs from brokers that ran at the same time.

A trade is identified by (instrument, cumulative volume): the first moment each
broker shows a given volume for an instrument is when it delivered that trade.
Only trades seen by every broker are compared.

Usage:  .venv/Scripts/python compare.py data/ticks_kotak_X.csv data/ticks_upstox_Y.csv [...]
        .venv/Scripts/python compare.py          (uses the latest file of each broker)
"""

import csv
import statistics
import sys
from itertools import combinations
from pathlib import Path

DATA = Path(__file__).parent / "data"


def latest_files() -> list[Path]:
    by_broker: dict[str, Path] = {}
    for p in sorted(DATA.glob("ticks_*.csv")):
        by_broker[p.name.split("_")[1]] = p  # sorted by timestamp, so last wins
    return list(by_broker.values())


def load(path: Path) -> tuple[str, list[int], dict[tuple[str, int], int]]:
    """Return (broker, all recv times, {(symbol, volume): first recv_ns})."""
    rows = list(csv.DictReader(open(path)))
    # Older single-instrument files used broker-specific names; ignore the symbol there.
    single = len({r["symbol"] for r in rows}) == 1
    first_seen: dict[tuple[str, int], int] = {}
    for r in rows:
        if r["volume"] in ("", "None"):
            continue
        key = ("", int(float(r["volume"]))) if single else (r["symbol"], int(float(r["volume"])))
        first_seen.setdefault(key, int(r["recv_ns"]))
    return rows[0]["broker"], [int(r["recv_ns"]) for r in rows], first_seen


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def main():
    paths = [Path(p) for p in sys.argv[1:]] or latest_files()
    feeds = [load(p) for p in paths]
    for p in paths:
        print(f"  {p.name}")

    # Only compare the window where all feeds were running, skipping the first 5s
    # (Kotak's SDK withholds ticks until its subscribe ack arrives).
    start = max(min(t) for _, t, _ in feeds) + 5_000_000_000
    end = min(max(t) for _, t, _ in feeds)

    print(f"\nOverlap window: {(end - start) / 1e9:.0f}s\n")
    print(f"{'broker':<8} {'ticks':>6} {'ticks/s':>8} {'new trades':>11} {'median gap ms':>14}")
    for name, times, first in feeds:
        t = [x for x in times if start <= x <= end]
        gaps = [(b - a) / 1e6 for a, b in zip(t, t[1:])]
        vols = sum(1 for v in first.values() if start <= v <= end)
        print(f"{name:<8} {len(t):>6} {len(t) / ((end - start) / 1e9):>8.2f} {vols:>11} "
              f"{statistics.median(gaps) if gaps else 0:>14.0f}")

    common = set.intersection(*(set(v for v, ts in f.items() if start <= ts <= end) for _, _, f in feeds))
    print(f"\nTrades seen by all brokers: {len(common)}")
    if not common:
        return

    wins = {name: 0 for name, _, _ in feeds}
    for v in common:
        winner = min(feeds, key=lambda f: f[2][v])[0]
        wins[winner] += 1
    print("\nWho delivered each trade first:")
    for name, w in sorted(wins.items(), key=lambda kv: -kv[1]):
        print(f"  {name:<8} {w:>4}  ({100 * w / len(common):.0f}%)")

    print("\nHead-to-head lead in ms (positive = first broker is faster):")
    for (a, _, fa), (b, _, fb) in combinations(feeds, 2):
        d = [(fb[v] - fa[v]) / 1e6 for v in common]
        a_wins = sum(1 for x in d if x > 0)
        print(f"  {a} vs {b}: {a} first on {100 * a_wins / len(d):.0f}%  median {statistics.median(d):+.0f}  "
              f"mean {statistics.mean(d):+.0f}  p10 {pct(d, 0.10):+.0f}  p90 {pct(d, 0.90):+.0f}  (n={len(d)})")

    symbols = {s for s, _ in common}
    if len(symbols) > 1:
        print(f"\nPer instrument ({len(symbols)} instruments with common trades, busiest first):")
        counts = sorted(symbols, key=lambda s: -sum(1 for k in common if k[0] == s))
        for s in counts[:15]:
            keys = [k for k in common if k[0] == s]
            w = {name: sum(1 for k in keys if min(feeds, key=lambda f: f[2][k])[0] == name) for name, _, _ in feeds}
            print(f"  {s:<8} trades {len(keys):>4}  " + "  ".join(f"{n} {c:>3}" for n, c in w.items()))
        per_sym_winner = {}
        for s in symbols:
            keys = [k for k in common if k[0] == s]
            w = {name: sum(1 for k in keys if min(feeds, key=lambda f: f[2][k])[0] == name) for name, _, _ in feeds}
            per_sym_winner[s] = max(w, key=w.get)
        print("\nInstruments where each broker won the most trades:")
        for name, _, _ in feeds:
            print(f"  {name:<8} {sum(1 for v in per_sym_winner.values() if v == name)}")


if __name__ == "__main__":
    main()
