"""Upstox Market Data Feed V3: subscribe to MCX CRUDEOIL front-month future and log every tick.

Uses the same `websockets` library as the Kotak SDK so both go through an
identical network stack. Receive time is stamped right after `recv()`,
before protobuf decoding.

Usage:  .venv/Scripts/python upstox_feed.py [--seconds 900] [--mode full|ltpc]
"""

import argparse
import asyncio
import gzip
import json
import os
import time
import uuid

import requests
import websockets
from dotenv import load_dotenv
from upstox_client.feeder.proto import MarketDataFeedV3_pb2 as pb

from common import TickLogger, load_instruments

load_dotenv()

FEED_URL = "wss://api.upstox.com/v3/feed/market-data-feed"
MCX_INSTRUMENTS = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz"


def find_crude_future() -> tuple[str, str]:
    """Return (instrument_key, trading_symbol) of the nearest-expiry CRUDEOIL future."""
    override = os.getenv("UPSTOX_CRUDE_KEY")
    if override:
        return override, override

    rows = json.loads(gzip.decompress(requests.get(MCX_INSTRUMENTS, timeout=30).content))
    now_ms = time.time() * 1000
    futs = [
        r for r in rows
        if r.get("instrument_type") == "FUT" and r.get("underlying_symbol") == "CRUDEOIL"
        and r.get("expiry", 0) > now_ms
    ]
    futs.sort(key=lambda r: r["expiry"])
    print("CRUDEOIL futures found:")
    for r in futs[:4]:
        print(f"  {r['trading_symbol']:<25} key={r['instrument_key']}")
    if not futs:
        raise RuntimeError("No CRUDEOIL futures found in Upstox MCX instruments")
    return futs[0]["instrument_key"], futs[0]["trading_symbol"]


def extract_ltpc(feed: pb.Feed):
    """Return (ltpc, vtt) from whichever feed variant the server sent."""
    kind = feed.WhichOneof("FeedUnion")
    if kind == "ltpc":
        return feed.ltpc, None
    if kind == "fullFeed":
        ff = feed.fullFeed
        if ff.WhichOneof("FullFeedUnion") == "marketFF":
            return ff.marketFF.ltpc, ff.marketFF.vtt
        return ff.indexFF.ltpc, None
    if kind == "firstLevelWithGreeks":
        return feed.firstLevelWithGreeks.ltpc, feed.firstLevelWithGreeks.vtt
    return None, None


async def run(seconds: int, mode: str, instruments: list[dict] | None):
    token = os.environ["UPSTOX_ACCESS_TOKEN"]
    if instruments:
        keys = [f"MCX_FO|{i['token']}" for i in instruments]
        print(f"Subscribing to {len(keys)} instruments mode={mode}")
    else:
        key, tsym = find_crude_future()
        keys = [key]
        print(f"Subscribing to {tsym} ({key}) mode={mode}")

    logger = TickLogger("upstox")
    headers = {"Authorization": f"Bearer {token}", "Accept": "*/*"}
    deadline = time.monotonic() + seconds
    sub = json.dumps({
        "guid": uuid.uuid4().hex,
        "method": "sub",
        "data": {"mode": mode, "instrumentKeys": keys},
    }).encode()

    try:
        while time.monotonic() < deadline:
            try:
                # websockets follows the 302 to the authorized feed endpoint automatically.
                async with websockets.connect(FEED_URL, additional_headers=headers, ping_interval=20) as ws:
                    await ws.send(sub)  # V3 requires a binary frame
                    print(f"Logging for {seconds}s -> {logger.path}")
                    while (remaining := deadline - time.monotonic()) > 0:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                        except TimeoutError:
                            break
                        recv_ns = time.time_ns()
                        msg = pb.FeedResponse()
                        msg.ParseFromString(raw)
                        if msg.type == pb.Type.market_info:
                            print(f"[upstox] market status MCX_FO: {msg.marketInfo.segmentStatus.get('MCX_FO')}")
                            continue
                        for fkey, feed in msg.feeds.items():
                            ltpc, vtt = extract_ltpc(feed)
                            if ltpc is None:
                                continue
                            # "MCX_FO|573422" -> exchange token, the cross-broker symbol key
                            logger.log(recv_ns, fkey.split("|")[1], ltpc.ltp, ltpc.ltq, vtt, ltpc.ltt)
                            if logger.count % 20 == 1:
                                print(f"[upstox] #{logger.count} LTP {ltpc.ltp}")
            except websockets.exceptions.InvalidStatus as e:
                raise SystemExit(f"Upstox rejected the connection ({e}). Is UPSTOX_ACCESS_TOKEN valid for today?")
            except websockets.exceptions.ConnectionClosed as e:
                print(f"[upstox] disconnected ({e}); reconnecting in 2s")
                await asyncio.sleep(2)
    finally:
        logger.close()
        print(f"Done. {logger.count} ticks written to {logger.path}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=int, default=900)
    p.add_argument("--mode", default="full", choices=["full", "ltpc"])
    p.add_argument("--instruments", help="JSON list from build_options.py")
    a = p.parse_args()
    asyncio.run(run(a.seconds, a.mode, load_instruments(a.instruments)))
