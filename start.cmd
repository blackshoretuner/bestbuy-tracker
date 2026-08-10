@echo off
REM Keep this file pure ASCII. cmd.exe parses batch files using the OEM
REM codepage, so non-ASCII text here gets mangled on zh-CN systems and can
REM break block structure (a stray byte ends an IF block early).
REM All user-facing Chinese lives in the web UI, not here.

chcp 65001 >nul 2>nul
title Best Buy Price Tracker
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

echo.
echo   Best Buy Price Tracker starting...
echo   Closing this window quits the app.
echo.
echo   To run it in the background instead, use the control program:
echo     bbt start    bbt stop    bbt port 9000    bbt        (menu)
echo.
node server.js
echo.
echo   Server stopped.
pause
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Install the LTS build from https://nodejs.org then run this again.
echo.
pause
exit /b 1
