"""Live ATM straddle (CE + PE) chart, one line per broker.

Tails the tick CSVs that the feeds write while they run, so start the feeds first:
    .venv/Scripts/python build_options.py --center 9800 --strikes 0
    .venv/Scripts/python run_all.py --seconds 3600 --instruments data/crude_options.json
    .venv/Scripts/python live_chart.py

Each line steps up/down the moment that broker delivered a new CE or PE price,
so the horizontal gap between lines is the delivery delay.
"""

import argparse
import csv
import json
import time
from collections import deque
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from datetime import datetime

DATA = Path(__file__).parent / "data"
BROKERS = {"kotak": "#2e7d32", "upstox": "#6a1b9a", "fyers": "#1565c0", "shoonya": "#ef6c00"}


class Tail:
    """Reads new rows appended to a broker's newest tick CSV."""

    def __init__(self, broker: str, since: float):
        self.broker, self.since, self.f, self.header = broker, since, None, None

    def rows(self):
        if self.f is None:
            files = [p for p in DATA.glob(f"ticks_{self.broker}_*.csv") if p.stat().st_mtime >= self.since]
            if not files:
                return []
            f = open(max(files, key=lambda p: p.stat().st_ctime), newline="")
            header = f.readline()
            if not header.endswith("\n"):  # file just created, header not written yet
                f.close()
                return []
            self.f, self.header = f, header.strip().split(",")
        out = []
        while True:
            pos = self.f.tell()
            line = self.f.readline()
            if not line.endswith("\n"):  # partial line still being written
                self.f.seek(pos)
                break
            out.append(dict(zip(self.header, next(csv.reader([line])))))
        return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--window", type=int, default=120, help="seconds of history shown")
    a = p.parse_args()

    opts = json.loads((DATA / "crude_options.json").read_text())
    ce = next(o for o in opts if o["type"] == "CE")
    pe = next(o for o in opts if o["type"] == "PE" and o["strike"] == ce["strike"])
    title = f"CRUDEOIL {ce['strike']:.0f} straddle (CE + PE) — live from {len(BROKERS)} brokers"

    start = time.time() - 120  # accept feed files started up to 2 min before the chart
    tails = {b: Tail(b, start) for b in BROKERS}
    last = {b: {} for b in BROKERS}  # broker -> {token: ltp}
    series = {b: deque() for b in BROKERS}  # broker -> (datetime, straddle)
    updates = {b: 0 for b in BROKERS}

    fig, ax = plt.subplots(figsize=(13, 6.5))
    fig.canvas.manager.set_window_title("ATM Straddle - Kotak vs Upstox vs Fyers")
    lines = {b: ax.step([], [], where="post", color=c, lw=1.8, label=b)[0] for b, c in BROKERS.items()}
    info = ax.text(0.01, 0.98, "", transform=ax.transAxes, va="top", family="monospace", fontsize=10,
                   bbox=dict(facecolor="white", alpha=0.85, edgecolor="#ccc"))
    ax.set_title(title)
    ax.set_ylabel("Straddle premium")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))
    ax.grid(alpha=0.3)
    ax.legend(loc="upper right")

    def update(_):
        for b, t in tails.items():
            for r in t.rows():
                if r["symbol"] not in (ce["token"], pe["token"]):
                    continue
                last[b][r["symbol"]] = float(r["ltp"])
                if len(last[b]) == 2:
                    s = last[b][ce["token"]] + last[b][pe["token"]]
                    ts = datetime.fromtimestamp(int(r["recv_ns"]) / 1e9)
                    if not series[b] or series[b][-1][1] != s:
                        series[b].append((ts, s))
                        updates[b] += 1
        now = datetime.now()
        cutoff = now.timestamp() - a.window
        ys = []
        for b, sr in series.items():
            while len(sr) > 1 and sr[1][0].timestamp() < cutoff:
                sr.popleft()
            if sr:
                xs = [x for x, _ in sr] + [now]  # extend the step to "now"
                vs = [v for _, v in sr] + [sr[-1][1]]
                lines[b].set_data(xs, vs)
                ys += vs
        if ys:
            pad = max(1.0, (max(ys) - min(ys)) * 0.15)
            ax.set_ylim(min(ys) - pad, max(ys) + pad)
            ax.set_xlim(datetime.fromtimestamp(cutoff), now)
        txt = []
        for b in BROKERS:
            sr = series[b]
            v = f"{sr[-1][1]:8.1f}  @ {sr[-1][0]:%H:%M:%S.%f}"[:-3] if sr else "   waiting..."
            txt.append(f"{b:<7} {v}   changes: {updates[b]}")
        info.set_text("\n".join(txt))
        return [*lines.values(), info]

    _anim = FuncAnimation(fig, update, interval=100, cache_frame_data=False)
    plt.tight_layout()
    plt.show()


if __name__ == "__main__":
    main()
