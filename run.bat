@echo off
echo ====================================
echo   luxbaz Speed Audit Tool
echo ====================================
echo.

if not exist node_modules (
  echo Installing required packages for the first time, this may take a few minutes...
  call npm install
  echo.
)

node seo-speed-audit.js
echo.
echo Done. Press any key to exit.
pause >nul
