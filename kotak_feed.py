"""Kotak Neo SFeed: subscribe to MCX CRUDEOIL front-month future and log every tick.

Receive time is stamped in `on_raw`, i.e. the moment the frame comes off the
socket and before the SDK decodes it, so SDK parsing cost doesn't count
against Kotak.

Usage:  .venv/Scripts/python kotak_feed.py [--seconds 900]
"""

import argparse
import asyncio
import os
import time

from dotenv import load_dotenv
from neo_api_client import NeoAPI
from neo_api_client.websocket.feed import SFeedScrip, SFeedScripLite, WsToken

from common import TickLogger, load_instruments

load_dotenv()


def get_totp() -> str:
    secret = os.getenv("NEO_TOTP_SECRET")
    if secret:
        import pyotp

        return pyotp.TOTP(secret).now()
    return input("Kotak TOTP (6 digits from authenticator): ").strip()


def find_crude_future(client: NeoAPI) -> tuple[str, str]:
    """Return (token, trading_symbol) of the nearest-expiry CRUDEOIL future."""
    override = os.getenv("KOTAK_CRUDE_TOKEN")
    if override:
        return override, f"token {override}"

    rows = client.search_scrip(exchange_segment="mcx_fo", symbol="CRUDEOIL", option_type="FUT")
    if not isinstance(rows, list):
        raise RuntimeError(f"search_scrip failed: {rows}")
    # Excludes CRUDEOILM (mini) since pSymbolName must match exactly.
    futs = [r for r in rows if r.get("pSymbolName") == "CRUDEOIL" and (r.get("lExpiryDate") or -1) > 0]
    futs.sort(key=lambda r: r["lExpiryDate"])
    print("CRUDEOIL futures found:")
    for r in futs[:4]:
        print(f"  {r['pTrdSymbol']:<25} token={r['pSymbol']}  expiry={r['lExpiryDate']}")
    if not futs:
        raise RuntimeError("No CRUDEOIL futures found in mcx_fo scrip master")
    return str(futs[0]["pSymbol"]), futs[0]["pTrdSymbol"]


async def run(seconds: int, instruments: list[dict] | None):
    client = NeoAPI(consumer_key=os.environ["NEO_CONSUMER_KEY"], environment="prod")
    client.totp_login(
        mobile_number=os.environ["NEO_MOBILE_NUMBER"],
        ucc=os.environ["NEO_UCC"],
        totp=get_totp(),
    )
    client.totp_validate(mpin=os.environ["NEO_MPIN"])

    if instruments:
        tokens = [i["token"] for i in instruments]
        print(f"Subscribing to {len(tokens)} instruments")
    else:
        token, tsym = find_crude_future(client)
        tokens = [token]
        print(f"Subscribing to {tsym} (mcx_fo|{token})")

    logger = TickLogger("kotak")
    last_raw_ns = 0

    def on_raw(_frame):
        nonlocal last_raw_ns
        last_raw_ns = time.time_ns()

    def on_message(msg):
        # on_message runs synchronously while the same frame is decoded,
        # so last_raw_ns belongs to this message's frame.
        if isinstance(msg, (SFeedScrip, SFeedScripLite)):
            # Exchange token is the same on every broker, so it is the cross-broker symbol key.
            logger.log(
                last_raw_ns,
                str(msg.instrument_token),
                msg.last_traded_price,
                getattr(msg, "last_trade_qty", None),
                getattr(msg, "volume_traded_today", None),
                msg.last_trade_time,
            )
            if logger.count % 20 == 1:
                print(f"[kotak] #{logger.count} LTP {msg.last_traded_price}")

    ws = client.create_websocket()
    ws.on_raw = on_raw
    ws.on_message = on_message
    await ws.connect()
    try:
        await ws.subscribe_scrips([WsToken("mcx_fo", t) for t in tokens])
        print(f"Logging for {seconds}s -> {logger.path}")
        # Drain the SDK's internal queue so it doesn't grow; ticks are handled in on_message.
        async with asyncio.timeout(seconds):
            async for _ in ws:
                pass
    except TimeoutError:
        pass
    finally:
        await ws.close()
        logger.close()
        print(f"Done. {logger.count} ticks written to {logger.path}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=int, default=900)
    p.add_argument("--instruments", help="JSON list from build_options.py")
    a = p.parse_args()
    asyncio.run(run(a.seconds, load_instruments(a.instruments)))
