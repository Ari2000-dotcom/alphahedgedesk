@echo off
rem The only file to run on the Windows VPS. First time: installs everything. Every time:
rem starts or updates MarketHub, asks for Nubra's OTP only if Nubra needs one, then shows
rem the live status. Closing this window does not stop MarketHub.
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
title MarketHub Server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0markethub-server.ps1"
pause
