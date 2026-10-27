@echo off
REM Run this ON THE STATIC-IP SERVER (as Administrator) to let your home PC
REM send the Shoonya token request out through this server's whitelisted IP.
REM
REM   start_proxy.bat <username> <password> [port]
REM
REM Then on your home PC set in .env:
REM   SHOONYA_PROXY=socks5h://<username>:<password>@<server IP>:<port>
REM
REM Keep this window open while logging in; close it afterwards (Ctrl+C).
cd /d "%~dp0"
if "%~2"=="" (echo Usage: start_proxy.bat ^<username^> ^<password^> [port] & exit /b 1)
set PORT=%3
if "%PORT%"=="" set PORT=1080

.venv\Scripts\python -m pip show pproxy >nul 2>&1 || .venv\Scripts\python -m pip install pproxy

REM Open the port in Windows Firewall (no-op if the rule already exists)
netsh advfirewall firewall show rule name="ShoonyaTokenProxy" >nul 2>&1 || ^
netsh advfirewall firewall add rule name="ShoonyaTokenProxy" dir=in action=allow protocol=TCP localport=%PORT%

echo Proxy listening on port %PORT% (password protected). Ctrl+C to stop.
REM --auth 0: check the password on every connection (pproxy otherwise trusts an IP for 30 days)
.venv\Scripts\python -m pproxy -l socks5://0.0.0.0:%PORT%#%1:%2 --auth 0 -v
