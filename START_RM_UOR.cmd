@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 (
  echo Cannot open the extracted application folder.
  pause
  exit /b 1
)
where.exe node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.16.0 with npm 10.9.2 is required.
  echo Install Node.js normally, then open START_RM_UOR.cmd again.
  echo This launcher does not download or install Node.js.
  popd
  pause
  exit /b 1
)
node "%~dp0start-rm-uor.mjs"
set "UOR_LAUNCH_EXIT=%ERRORLEVEL%"
popd
if not "%UOR_LAUNCH_EXIT%"=="0" (
  echo.
  echo Start failed. Read the message above and README_RU_LOCAL_START.txt.
  pause
)
exit /b %UOR_LAUNCH_EXIT%
