"""Shoonya login with no person at the keyboard (official headless-Selenium method).

Headless Chrome fills user id, password and a fresh TOTP on Shoonya's OAuth page,
catches the one-time `code` it redirects with, and swaps it at GenAcsTok for the
day's access token. Needs Chrome installed; Selenium fetches the driver itself.

Credentials come from the environment (MarketHub passes them) or from .env:
  SHOONYA_UID, SHOONYA_PASSWORD, SHOONYA_TOTP_SECRET, SHOONYA_CLIENT_ID, SHOONYA_API_SECRET

Output: one JSON line on stdout, {"access_token": ..., "actid": ...}. Errors go to
stderr with exit code 1. Never prints secrets.

Usage:  .venv/Scripts/python shoonya_auto_login.py [--save]   (--save also writes the token into .env)
        .venv/Scripts/python shoonya_auto_login.py --check    (only opens the login page and reports the fields)
"""

import hashlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pyotp
import requests
from dotenv import load_dotenv, set_key
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

ENV = Path(__file__).parent / ".env"
load_dotenv(ENV)  # never overrides values MarketHub passed in
# The official docs call it SHOONYA_USER_ID; accept either name.
if not os.getenv("SHOONYA_UID") and os.getenv("SHOONYA_USER_ID"):
    os.environ["SHOONYA_UID"] = os.environ["SHOONYA_USER_ID"]

LOGIN_URL = "https://api.shoonya.com/OAuthlogin/investor-entry-level/login?api_key={client_id}&route_to={uid}"
GEN_ACS_TOK = "https://api.shoonya.com/NorenWClientAPI/GenAcsTok"
CODE_WAIT_S = 60


def fail(msg: str):
    print(f"shoonya login: {msg}", file=sys.stderr)
    sys.exit(1)


def need(key: str) -> str:
    v = (os.getenv(key) or "").strip().strip("'\"")
    if not v:
        fail(f"{key} is not set")
    return v


def totp_now(secret: str) -> str:
    try:
        return pyotp.TOTP(secret.replace(" ", "").upper()).now()
    except ValueError:
        fail("SHOONYA_TOTP_SECRET is not a TOTP secret (should be ~32 chars of A-Z and 2-7)")


def browser() -> webdriver.Chrome:
    opts = webdriver.ChromeOptions()
    for a in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1920,1080", "--disable-gpu"):
        opts.add_argument(a)
    # The redirect carrying `code=` is read from Chrome's network log.
    opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    return webdriver.Chrome(options=opts)


def login_fields(drv):
    """Visible text/password inputs in page order: user id, password, TOTP."""
    out = []
    for el in drv.find_elements(By.TAG_NAME, "input"):
        if (el.get_attribute("type") or "text").lower() in ("hidden", "checkbox", "radio", "submit", "button"):
            continue
        if el.is_displayed() and el.is_enabled():
            out.append(el)
    return out


def click_login(drv):
    for b in drv.find_elements(By.XPATH, "//button | //input[@type='submit'] | //*[@role='button']"):
        label = (b.text or b.get_attribute("value") or "").strip().upper()
        if "LOGIN" in label.replace(" ", "") and b.is_displayed():
            b.click()
            return
    fail("LOGIN button not found on the page (Shoonya may have changed it)")


def code_from(url: str) -> str | None:
    if "code=" not in url:
        return None
    return (parse_qs(urlparse(url).query).get("code") or [None])[0]


def wait_for_code(drv, seconds: int) -> str | None:
    end = time.time() + seconds
    while time.time() < end:
        code = code_from(drv.current_url)
        if code:
            return code
        for entry in drv.get_log("performance"):
            try:
                p = json.loads(entry["message"])["message"].get("params", {})
            except (ValueError, KeyError):
                continue
            for url in (p.get("request", {}).get("url", ""), p.get("documentURL", ""), p.get("response", {}).get("url", "")):
                code = code_from(url) if url and "OAuthlogin" not in url.split("?")[0] else None
                if code:
                    return code
            loc = p.get("redirectResponse", {}).get("headers", {}).get("location") or p.get("response", {}).get("headers", {}).get("location")
            if loc and code_from(loc):
                return code_from(loc)
        time.sleep(0.5)
    return None


def page_error(drv) -> str:
    """Best-effort text of an error shown on the login page."""
    for sel in ("[class*='error']", "[class*='alert']", "[class*='toast']", "[role='alert']"):
        for el in drv.find_elements(By.CSS_SELECTOR, sel):
            if el.is_displayed() and el.text.strip():
                return el.text.strip()[:200]
    return ""


def get_code(uid: str, pwd: str, secret: str, client_id: str, check_only: bool) -> str:
    drv = browser()
    try:
        drv.get(LOGIN_URL.format(client_id=client_id, uid=uid))
        WebDriverWait(drv, 30).until(EC.element_to_be_clickable((By.CSS_SELECTOR, "input[type='password']")))
        fields = login_fields(drv)
        if check_only:
            print(f"login page OK: {len(fields)} input fields found (need 3: user id, password, TOTP)", file=sys.stderr)
            sys.exit(0 if len(fields) >= 3 else 1)
        if len(fields) < 3:
            fail(f"expected 3 login fields, found {len(fields)}")
        uid_f, pwd_f, totp_f = fields[:3]
        for f, v in ((uid_f, uid), (pwd_f, pwd)):
            f.clear()
            f.send_keys(v)
        otp = totp_now(secret)
        totp_f.clear()
        totp_f.send_keys(otp)
        click_login(drv)

        code = wait_for_code(drv, CODE_WAIT_S)
        if not code:
            # The TOTP may have rolled over mid-login: retry once with the next one.
            nxt = totp_now(secret)
            if nxt != otp:
                totp_f.clear()
                totp_f.send_keys(nxt)
                click_login(drv)
                code = wait_for_code(drv, CODE_WAIT_S)
        if not code:
            fail("no login code came back" + (f" — page says: {page_error(drv)}" if page_error(drv) else ""))
        return code
    finally:
        drv.quit()


def main():
    check_only = "--check" in sys.argv
    uid, client_id = need("SHOONYA_UID"), need("SHOONYA_CLIENT_ID")
    pwd = "" if check_only else need("SHOONYA_PASSWORD")
    secret = "" if check_only else need("SHOONYA_TOTP_SECRET")
    if not check_only:
        totp_now(secret)  # reject a bad secret before opening a browser
    api_secret = "" if check_only else need("SHOONYA_API_SECRET")

    code = get_code(uid, pwd, secret, client_id, check_only)

    checksum = hashlib.sha256((client_id + api_secret + code).encode()).hexdigest()
    res = requests.post(
        GEN_ACS_TOK, data="jData=" + json.dumps({"code": code, "checksum": checksum, "uid": uid}), timeout=15
    ).json()
    if "access_token" not in res:
        emsg = res.get("emsg", res)
        hint = " (Shoonya only accepts your whitelisted static IP)" if "INVALID_IP" in str(emsg) else ""
        fail(f"token request refused: {emsg}{hint}")

    actid = res.get("actid") or uid
    if "--save" in sys.argv:
        set_key(str(ENV), "SHOONYA_ACCESS_TOKEN", res["access_token"])
        set_key(str(ENV), "SHOONYA_ACTID", actid)
        print("saved SHOONYA_ACCESS_TOKEN to .env", file=sys.stderr)
    print(json.dumps({"access_token": res["access_token"], "actid": actid}))


if __name__ == "__main__":
    main()
