@echo off
REM One-time setup on a new Windows machine (e.g. the static-IP VPS).
REM Needs Python 3.12+ installed with "Add python.exe to PATH" ticked.
cd /d "%~dp0"
python --version || (echo Python not found. Install from https://www.python.org/downloads/ and tick "Add to PATH". & pause & exit /b 1)
python -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt
echo.
echo This machine's public IP (whitelist this on Shoonya):
.venv\Scripts\python -c "import requests;print(requests.get('https://api.ipify.org',timeout=10).text)"
echo.
echo Setup done. Next: .venv\Scripts\python shoonya_login.py
pause
