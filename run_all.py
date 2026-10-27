"""Run all broker feeds at the same time, then compare them.

Each feed runs in its own process so one SDK's threads can't slow down another's.

Usage:  .venv/Scripts/python run_all.py [--seconds 900] [--brokers kotak,upstox,fyers]
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
LOGS = ROOT / "logs"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=int, default=900)
    p.add_argument("--brokers", default="kotak,upstox,fyers")
    p.add_argument("--instruments", help="JSON list from build_options.py (default: CRUDEOIL future only)")
    a = p.parse_args()
    extra = ["--instruments", str(Path(a.instruments).resolve())] if a.instruments else []

    LOGS.mkdir(exist_ok=True)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    procs = {}
    for b in a.brokers.split(","):
        log = open(LOGS / f"{b}_run.txt", "w")
        procs[b] = (subprocess.Popen(
            [sys.executable, str(ROOT / f"{b}_feed.py"), "--seconds", str(a.seconds), *extra],
            cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
        ), log)
        print(f"started {b} (log: logs/{b}_run.txt)")

    print(f"Running for {a.seconds}s...")
    csvs = []
    for b, (proc, log) in procs.items():
        proc.wait()
        log.close()
        out = (LOGS / f"{b}_run.txt").read_text(encoding="utf-8", errors="replace")
        line = next((l for l in out.splitlines() if l.startswith("Done.")), None)
        print(f"{b}: {line or 'FAILED, see logs/' + b + '_run.txt'}")
        if line and " 0 ticks" not in line:
            csvs.append(line.split(" written to ", 1)[1])

    if len(csvs) >= 2:
        subprocess.run([sys.executable, str(ROOT / "compare.py"), *csvs], cwd=ROOT)


if __name__ == "__main__":
    main()
