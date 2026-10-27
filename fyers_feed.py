"""Fyers Data Socket: subscribe to MCX CRUDEOIL front-month future and log every tick.

The SDK runs websocket-client in its own thread. Receive time is stamped by
wrapping the SDK's raw frame handler, so it is taken before binary decoding,
same as Kotak and Upstox.

Usage:  .venv/Scripts/python fyers_feed.py [--seconds 900]
"""

import argparse
import csv
import io
import os
import threading
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from fyers_apiv3.FyersWebsocket import data_ws

from common import TickLogger, load_instruments

load_dotenv()

SYMBOL_MASTER = "https://public.fyers.in/sym_details/MCX_COM.csv"
LOG_DIR = Path(__file__).parent / "logs"


def find_crude_future() -> tuple[str, str]:
    """Return (Fyers symbol, exchange token) of the nearest-expiry CRUDEOIL future."""

    text = requests.get(SYMBOL_MASTER, timeout=30).text
    now = time.time()
    # Columns (no header): 1 = description, 8 = expiry epoch, 9 = symbol, 13 = underlying
    futs = [
        r for r in csv.reader(io.StringIO(text))
        if len(r) > 13 and r[13] == "CRUDEOIL" and r[9].endswith("FUT") and int(r[8]) > now
    ]
    futs.sort(key=lambda r: int(r[8]))
    print("CRUDEOIL futures found:")
    for r in futs[:4]:
        print(f"  {r[9]:<25} token={r[12]}")
    if not futs:
        raise RuntimeError("No CRUDEOIL futures found in Fyers MCX symbol master")
    return futs[0][9], futs[0][12]


def run(seconds: int, instruments: list[dict] | None):
    access_token = f"{os.environ['FYERS_APP_ID']}:{os.environ['FYERS_ACCESS_TOKEN']}"
    if instruments:
        # Fyers symbol -> exchange token, the cross-broker symbol key
        token_of = {i["fyers"]: i["token"] for i in instruments}
        print(f"Subscribing to {len(token_of)} instruments")
    else:
        symbol, tok = find_crude_future()
        token_of = {symbol: tok}
        print(f"Subscribing to {symbol}")
    symbols = list(token_of)

    logger = TickLogger("fyers")
    lock = threading.Lock()
    last_raw_ns = 0

    def on_message(msg):
        # Called synchronously from the wrapped frame handler below, on the same thread.
        if "ltp" not in msg or "symbol" not in msg:
            if msg.get("type") in ("cn", "ful", "sub"):
                print(f"[fyers] {msg}")
            return
        with lock:
            logger.log(
                last_raw_ns,
                token_of.get(msg["symbol"], msg["symbol"]),
                msg["ltp"],
                msg.get("last_traded_qty"),
                msg.get("vol_traded_today"),
                msg.get("last_traded_time"),
            )
            if logger.count % 20 == 1:
                print(f"[fyers] #{logger.count} LTP {msg['ltp']}")

    def on_error(msg):
        print(f"[fyers] error: {msg}")

    def on_connect():
        fyers.subscribe(symbols=symbols, data_type="SymbolUpdate")

    LOG_DIR.mkdir(exist_ok=True)
    fyers = data_ws.FyersDataSocket(
        access_token=access_token,
        log_path=str(LOG_DIR),
        litemode=False,  # full SymbolUpdate, needed for volume to match trades across brokers
        write_to_file=False,
        reconnect=True,
        on_connect=on_connect,
        on_error=on_error,
        on_message=on_message,
    )

    # The SDK's WebSocketApp calls self.__response_msg(raw) for every frame; an instance
    # attribute shadows the class method, letting us stamp time before decoding.
    original = fyers._FyersDataSocket__response_msg

    def timed_response(raw):
        nonlocal last_raw_ns
        last_raw_ns = time.time_ns()
        original(raw)

    fyers._FyersDataSocket__response_msg = timed_response

    fyers.connect()
    print(f"Logging for {seconds}s -> {logger.path}")
    try:
        time.sleep(seconds)
    except KeyboardInterrupt:
        pass
    finally:
        with lock:
            logger.close()
        print(f"Done. {logger.count} ticks written to {logger.path}", flush=True)
        os._exit(0)  # the SDK's reconnect/ping threads are non-daemon and can block a normal exit


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=int, default=900)
    p.add_argument("--instruments", help="JSON list from build_options.py")
    a = p.parse_args()
    run(a.seconds, load_instruments(a.instruments))
