@echo off
rem ADK launcher for Windows. Double-click to start ADK, or run: adk [start^|setup^|stop^|logs^|status^|update^|help]
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\adk.ps1" %*
set "ADK_EXIT=%ERRORLEVEL%"
rem Without arguments this was most likely a double-click: keep the window open to read the result.
if "%~1"=="" pause
exit /b %ADK_EXIT%
