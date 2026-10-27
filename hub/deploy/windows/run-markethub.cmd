@echo off
rem Started by the "MarketHub" scheduled task. Runs the installed copy in hub\bin\ (so a new
rem hub\MarketHub-server.exe can be pasted in while it runs), writes the status/log to
rem markethub.log and starts a fresh log when it passes ~10 MB.
cd /d "%~dp0hub"
set "MARKETHUB_COLOR=1"
set "LOG=%~dp0markethub.log"
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 10000000 move /y "%LOG%" "%LOG%.old" >nul
"%~dp0hub\bin\MarketHub-server.exe" >> "%LOG%" 2>&1
