"""Get today's Fyers access token and save it into .env.

Needs FYERS_APP_ID (e.g. XXXXXXXX-100), FYERS_SECRET_KEY, FYERS_REDIRECT_URI in .env
(from https://myapi.fyers.in/dashboard).

If the redirect URI points at this machine (127.0.0.1 / localhost), a tiny local
server catches the auth_code automatically; otherwise you paste the redirect URL.

Usage:  .venv/Scripts/python fyers_login.py
"""

import os
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv, set_key
from fyers_apiv3 import fyersModel

ENV = Path(__file__).parent / ".env"
load_dotenv(ENV)

app_id = os.environ["FYERS_APP_ID"]
secret = os.environ["FYERS_SECRET_KEY"]
redirect = os.environ["FYERS_REDIRECT_URI"]


def wait_for_auth_code(redirect_uri: str) -> str:
    """Serve the redirect URI locally and return the auth_code Fyers sends to it."""
    parsed = urlparse(redirect_uri)
    result = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = parse_qs(urlparse(self.path).query)
            if "auth_code" in q:
                result["code"] = q["auth_code"][0]
                body = "Fyers login done. You can close this tab."
            else:
                body = f"No auth_code in redirect: {q}"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *args):
            pass

    server = HTTPServer((parsed.hostname, parsed.port or 80), Handler)
    print(f"Waiting for Fyers to redirect to {redirect_uri} ...")
    while "code" not in result:
        server.handle_request()
    server.server_close()
    return result["code"]


session = fyersModel.SessionModel(
    client_id=app_id,
    secret_key=secret,
    redirect_uri=redirect,
    response_type="code",
    grant_type="authorization_code",
    state="socket-test",
)
url = session.generate_authcode()
print("Opening Fyers login in your browser. If it doesn't open, visit:\n" + url)
webbrowser.open(url)

if urlparse(redirect).hostname in ("127.0.0.1", "localhost"):
    auth_code = wait_for_auth_code(redirect)
else:
    pasted = input("\nAfter login, copy the FULL URL from the address bar and paste it here:\n> ").strip()
    auth_code = parse_qs(urlparse(pasted).query).get("auth_code", [pasted])[0]

session.set_token(auth_code)
data = session.generate_token()
if "access_token" not in data:
    raise SystemExit(f"Token request failed: {data}")

set_key(str(ENV), "FYERS_ACCESS_TOKEN", data["access_token"])
print("Saved FYERS_ACCESS_TOKEN to .env.")
