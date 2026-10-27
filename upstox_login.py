"""Get today's Upstox access token and save it into .env.

Needs UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI in .env
(from https://account.upstox.com/developer/apps).

Usage:  .venv/Scripts/python upstox_login.py
"""

import os
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests
from dotenv import load_dotenv, set_key

ENV = Path(__file__).parent / ".env"
load_dotenv(ENV)

key = os.environ["UPSTOX_API_KEY"]
secret = os.environ["UPSTOX_API_SECRET"]
redirect = os.environ["UPSTOX_REDIRECT_URI"]

url = "https://api.upstox.com/v2/login/authorization/dialog?" + urlencode(
    {"response_type": "code", "client_id": key, "redirect_uri": redirect}
)
print("Opening Upstox login in your browser. If it doesn't open, visit:\n" + url)
webbrowser.open(url)

pasted = input("\nAfter login, copy the FULL URL from the address bar and paste it here:\n> ").strip()
code = parse_qs(urlparse(pasted).query).get("code", [pasted])[0]

r = requests.post(
    "https://api.upstox.com/v2/login/authorization/token",
    headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
    data={
        "code": code,
        "client_id": key,
        "client_secret": secret,
        "redirect_uri": redirect,
        "grant_type": "authorization_code",
    },
    timeout=30,
)
data = r.json()
if "access_token" not in data:
    raise SystemExit(f"Token request failed: {data}")

set_key(str(ENV), "UPSTOX_ACCESS_TOKEN", data["access_token"])
print(f"Saved UPSTOX_ACCESS_TOKEN to .env for {data.get('user_name', 'user')}.")
