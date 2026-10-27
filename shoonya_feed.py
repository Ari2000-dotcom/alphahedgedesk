"""Shoonya (Finvasia) NorenWSAPI: subscribe touchline for CRUDEOIL and log every tick.

The feed is plain JSON, so this talks to it directly with the same `websockets`
library used for Kotak and Upstox. Receive time is stamped right after `recv()`.

Shoonya sends only changed fields in each update ("tf"), so the last known
ltp/volume per token is kept and merged into every logged row.

Usage:  .venv/Scripts/python shoonya_feed.py [--seconds 900] [--instruments data/crude_options.json]
"""

import argparse
import asyncio
import io
import json
import os
import time
import zipfile

import requests
import websockets
from dotenv import load_dotenv

from common import TickLogger, load_instruments

load_dotenv()

WS_URL = "wss://api.shoonya.com/NorenWSAPI/"
MCX_MASTER = "https://api.shoonya.com/MCX_symbols.txt.zip"


def find_crude_future() -> tuple[str, str]:
    """Return (token, trading_symbol) of the nearest-expiry CRUDEOIL future."""
    z = zipfile.ZipFile(io.BytesIO(requests.get(MCX_MASTER, timeout=30).content))
    lines = z.read(z.namelist()[0]).decode().splitlines()
    head = lines[0].split(",")
    rows = [dict(zip(head, ln.split(","))) for ln in lines[1:]]
    futs = [r for r in rows if r.get("Symbol") == "CRUDEOIL" and r.get("Instrument") == "FUTCOM"]
    futs.sort(key=lambda r: time.strptime(r["Expiry"], "%d-%b-%Y"))
    print("CRUDEOIL futures found:")
    for r in futs[:4]:
        print(f"  {r['TradingSymbol']:<25} token={r['Token']}")
    if not futs:
        raise RuntimeError("No CRUDEOIL futures found in Shoonya MCX symbol master")
    return futs[0]["Token"], futs[0]["TradingSymbol"]


async def run(seconds: int, instruments: list[dict] | None):
    uid = os.environ["SHOONYA_UID"]
    actid = os.getenv("SHOONYA_ACTID") or uid
    # susertoken (QuickAuth, `shoonya_login.py --quick`) connects with t:"c" and is acked
    # with "ck"; the OAuth access token connects with t:"a" and is acked with "ak".
    if os.getenv("SHOONYA_SUSERTOKEN"):
        connect_msg = {"t": "c", "uid": uid, "actid": actid, "source": "API",
                       "susertoken": os.environ["SHOONYA_SUSERTOKEN"]}
    else:
        connect_msg = {"t": "a", "uid": uid, "actid": actid, "source": "API",
                       "accesstoken": os.environ["SHOONYA_ACCESS_TOKEN"]}

    if instruments:
        tokens = [i["token"] for i in instruments]
        print(f"Subscribing to {len(tokens)} instruments")
    else:
        tok, tsym = find_crude_future()
        tokens = [tok]
        print(f"Subscribing to {tsym} (MCX|{tok})")

    logger = TickLogger("shoonya")
    state: dict[str, dict] = {}  # token -> last known fields
    deadline = time.monotonic() + seconds
    connect = json.dumps(connect_msg)
    subscribe = json.dumps({"t": "t", "k": "#".join(f"MCX|{t}" for t in tokens)})

    try:
        while time.monotonic() < deadline:
            try:
                # Only the login needs the whitelisted IP (SHOONYA_PROXY in shoonya_login.py).
                # Set SHOONYA_FEED_PROXY too only if Shoonya also checks the IP on the feed.
                # True keeps websockets' default of honouring system proxy settings.
                async with websockets.connect(WS_URL, ping_interval=20,
                                              proxy=os.getenv("SHOONYA_FEED_PROXY") or True) as ws:
                    await ws.send(connect)
                    ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    if ack.get("t") not in ("ak", "ck") or str(ack.get("s")).lower() != "ok":
                        raise SystemExit(f"Shoonya rejected the session ({ack}). Run shoonya_login.py for a fresh token.")
                    await ws.send(subscribe)
                    print(f"Logging for {seconds}s -> {logger.path}")
                    while (remaining := deadline - time.monotonic()) > 0:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                        except TimeoutError:
                            break
                        recv_ns = time.time_ns()
                        msg = json.loads(raw)
                        if msg.get("t") not in ("tk", "tf"):  # tk = subscribe snapshot, tf = update
                            continue
                        s = state.setdefault(msg["tk"], {})
                        s.update(msg)
                        if "lp" not in s:
                            continue
                        logger.log(recv_ns, msg["tk"], float(s["lp"]), s.get("ltq"), s.get("v"), s.get("ft"))
                        if logger.count % 20 == 1:
                            print(f"[shoonya] #{logger.count} LTP {s['lp']}")
            except websockets.exceptions.ConnectionClosed as e:
                print(f"[shoonya] disconnected ({e}); reconnecting in 2s")
                await asyncio.sleep(2)
    finally:
        logger.close()
        print(f"Done. {logger.count} ticks written to {logger.path}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=int, default=900)
    p.add_argument("--instruments", help="JSON list from build_options.py")
    a = p.parse_args()
    asyncio.run(run(a.seconds, load_instruments(a.instruments)))
