"""Build the CRUDEOIL option list (nearest expiry, ATM +/- N strikes) for all brokers.

Exchange tokens are identical across Kotak, Upstox and Fyers for MCX, so one list
drives every feed. Writes data/crude_options.json.

Usage:  .venv/Scripts/python build_options.py [--center 9776] [--strikes 30]
"""

import argparse
import csv
import io
import json
import time
from pathlib import Path

import requests

DATA = Path(__file__).parent / "data"
SYMBOL_MASTER = "https://public.fyers.in/sym_details/MCX_COM.csv"


def last_crude_ltp() -> float:
    """Latest futures LTP from the newest Kotak/Upstox/Fyers futures run."""
    for p in sorted(DATA.glob("ticks_*.csv"), key=lambda p: p.stat().st_mtime, reverse=True):
        rows = list(csv.DictReader(open(p)))
        if rows and len({r["symbol"] for r in rows}) == 1:
            return float(rows[-1]["ltp"])
    raise SystemExit("No futures tick file found; pass --center")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--center", type=float, help="ATM reference price (default: last logged futures LTP)")
    p.add_argument("--strikes", type=int, default=30, help="strikes on each side of ATM")
    a = p.parse_args()

    center = a.center or last_crude_ltp()
    text = requests.get(SYMBOL_MASTER, timeout=30).text
    now = time.time()
    # Columns: 8 = expiry epoch, 9 = Fyers symbol, 12 = exchange token, 13 = underlying,
    # 15 = strike, 16 = CE/PE
    opts = [
        r for r in csv.reader(io.StringIO(text))
        if len(r) > 16 and r[13] == "CRUDEOIL" and r[16] in ("CE", "PE") and int(r[8]) > now
    ]
    expiry = min(int(r[8]) for r in opts)
    opts = [r for r in opts if int(r[8]) == expiry]

    strikes = sorted({float(r[15]) for r in opts})
    atm = min(strikes, key=lambda s: abs(s - center))
    i = strikes.index(atm)
    keep = set(strikes[max(0, i - a.strikes): i + a.strikes + 1])

    out = [
        {"token": r[12], "fyers": r[9], "strike": float(r[15]), "type": r[16]}
        for r in opts if float(r[15]) in keep
    ]
    out.sort(key=lambda o: (o["strike"], o["type"]))
    DATA.mkdir(exist_ok=True)
    path = DATA / "crude_options.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"Expiry {time.strftime('%d %b %Y', time.localtime(expiry))}, ATM {atm:.0f} (ref {center}), "
          f"strikes {min(keep):.0f}-{max(keep):.0f}: {len(out)} options -> {path}")


if __name__ == "__main__":
    main()
