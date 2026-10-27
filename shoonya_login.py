"""Get today's Shoonya (Finvasia) session token and save it into .env.

Two ways:
  OAuth (default)  needs SHOONYA_CLIENT_ID, SHOONYA_SECRET_CODE, SHOONYA_UID. If
                   SHOONYA_REDIRECT_URI points at this machine the code is caught
                   automatically; otherwise you paste the redirect URL.
  --quick          password + TOTP login (QuickAuth, the older ShoonyaApi-py flow), no
                   browser. Needs SHOONYA_UID, SHOONYA_PASSWORD, SHOONYA_TOTP_SECRET,
                   SHOONYA_VENDOR_CODE, SHOONYA_API_KEY. Saves SHOONYA_SUSERTOKEN.

Usage:  .venv/Scripts/python shoonya_login.py [--quick]
"""

import hashlib
import json
import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
from dotenv import load_dotenv, set_key
from NorenRestApiPy.NorenApi import NorenApi

ENV = Path(__file__).parent / ".env"
load_dotenv(ENV)

OAUTH_URL = "https://api.shoonya.com/OAuthlogin/authorize/oauth"
REST = "https://api.shoonya.com/NorenWClientAPI"
uid = os.environ["SHOONYA_UID"]
redirect = os.getenv("SHOONYA_REDIRECT_URI", "")
# Shoonya only accepts API calls from the whitelisted static IP. If that IP belongs
# to another machine, route through it, e.g. `ssh -D 1080 user@server` and
# SHOONYA_PROXY=socks5h://127.0.0.1:1080
proxy = os.getenv("SHOONYA_PROXY")
proxies = {"https": proxy, "http": proxy} if proxy else None


def code_from(query: dict) -> str | None:
    return (query.get("code") or query.get("auth_code") or [None])[0]


def wait_for_code(redirect_uri: str) -> str:
    parsed = urlparse(redirect_uri)
    result = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            code = code_from(parse_qs(urlparse(self.path).query))
            if code:
                result["code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Shoonya login done. You can close this tab." if code else b"No code in redirect")

        def log_message(self, *args):
            pass

    server = HTTPServer((parsed.hostname, parsed.port or 80), Handler)
    print(f"Waiting for Shoonya to redirect to {redirect_uri} ...")
    while "code" not in result:
        server.handle_request()
    server.server_close()
    return result["code"]


def ip_hint(res) -> str:
    if "INVALID_IP" not in str(res):
        return ""
    ip = requests.get("https://api.ipify.org", proxies=proxies, timeout=10).text
    return f" -> Shoonya saw IP {ip}; whitelist it or set SHOONYA_PROXY"


def current_totp() -> str:
    """6-digit code from SHOONYA_TOTP_SECRET, or typed in if the secret is missing/invalid."""
    import pyotp

    secret = (os.getenv("SHOONYA_TOTP_SECRET") or "").replace(" ", "")
    if secret:
        try:
            return pyotp.TOTP(secret).now()
        except ValueError:  # binascii.Error for non-base32 secrets is a ValueError
            print("SHOONYA_TOTP_SECRET is not a valid TOTP secret (should be ~32 chars of A-Z and 2-7).")
    return input("Shoonya TOTP (6 digits from your authenticator app): ").strip()


def quick_login():
    """Password + TOTP login (QuickAuth), same fields as ShoonyaApi-py's api.login()."""
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()  # noqa: E731
    values = {
        "source": "API",
        "apkversion": "1.0.0",
        "uid": uid,
        "pwd": sha(os.environ["SHOONYA_PASSWORD"]),
        "factor2": current_totp(),
        "vc": os.environ["SHOONYA_VENDOR_CODE"],
        "appkey": sha(f"{uid}|{os.environ['SHOONYA_API_KEY']}"),
        "imei": os.getenv("SHOONYA_IMEI", "socket-testing"),
    }
    res = requests.post(f"{REST}/QuickAuth", data="jData=" + json.dumps(values), timeout=15, proxies=proxies).json()
    if str(res.get("stat")).lower() != "ok":
        raise SystemExit(f"QuickAuth failed: {res.get('emsg', res)}{ip_hint(res)}")
    set_key(str(ENV), "SHOONYA_SUSERTOKEN", res["susertoken"])
    set_key(str(ENV), "SHOONYA_ACTID", res.get("actid") or uid)
    print(f"Saved SHOONYA_SUSERTOKEN to .env for {res.get('uname', uid)}.")


if "--quick" in sys.argv:
    quick_login()
    sys.exit(0)

client_id = os.environ["SHOONYA_CLIENT_ID"]
secret = os.environ["SHOONYA_SECRET_CODE"]
api = NorenApi(host=REST + "/", websocket="wss://api.shoonya.com/NorenWSAPI/")
url = api.getOAuthURL(OAUTH_URL, client_id)
print("Opening Shoonya login in your browser. If it doesn't open, visit:\n" + url)
webbrowser.open(url)

if urlparse(redirect).hostname in ("127.0.0.1", "localhost"):
    code = wait_for_code(redirect)
else:
    pasted = input("\nAfter login, copy the FULL URL from the address bar and paste it here:\n> ").strip()
    code = code_from(parse_qs(urlparse(pasted).query)) or pasted

# Same request as NorenApi.getAccessToken, done directly because the SDK returns
# None on failure and hides Shoonya's error message (e.g. INVALID_IP).
checksum = hashlib.sha256((client_id + secret + code).encode()).hexdigest()
res = requests.post(
    f"{REST}/GenAcsTok",
    data="jData=" + json.dumps({"code": code, "checksum": checksum, "uid": uid}),
    timeout=15,
    proxies=proxies,
).json()
if "access_token" not in res:
    raise SystemExit(f"Token request failed: {res.get('emsg', res)}{ip_hint(res)}")

set_key(str(ENV), "SHOONYA_ACCESS_TOKEN", res["access_token"])
set_key(str(ENV), "SHOONYA_SUSERTOKEN", "")  # so shoonya_feed.py uses this fresh OAuth token
set_key(str(ENV), "SHOONYA_ACTID", res.get("actid") or uid)
print(f"Saved SHOONYA_ACCESS_TOKEN to .env for {res.get('USERID', uid)}.")
