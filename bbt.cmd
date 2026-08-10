@echo off
REM Keep this file pure ASCII -- cmd.exe parses batch files with the OEM
REM codepage, and non-ASCII bytes can break block structure on zh-CN systems.
REM All user-facing Chinese comes from scripts/ctl.js, which cmd never parses.

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Install the LTS build from https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM No auto-pause here on purpose: a double-click and a PowerShell call look
REM identical in %cmdcmdline%, so there is no reliable way to tell them apart.
REM Instead, ctl.js opens an interactive menu when no command is given, which
REM keeps the window open by itself.
node scripts\ctl.js %*
exit /b %ERRORLEVEL%
