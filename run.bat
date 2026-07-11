@echo off
setlocal enabledelayedexpansion

echo ====================================
echo   luxbaz Speed Audit Tool
echo ====================================
echo.

REM Check if Node.js is available
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Check if npm is available
call npm --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist node_modules\ (
    echo Installing required packages for the first time, this may take a few minutes...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. Please check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo.
)

if not exist config.json (
    echo ERROR: config.json not found!
    echo Please create a config.json file with your site configuration.
    echo.
    pause
    exit /b 1
)

if not exist seo-speed-audit.js (
    echo ERROR: seo-speed-audit.js not found!
    echo.
    pause
    exit /b 1
)

echo Select mode:
echo   1) Full site audit (uses config.json)
echo   2) Single page check
echo.

set /p "choice=Enter choice [1-2]: "
echo.

if "%choice%"=="2" (
    rem User chose 2 - Single page check
    set /p "url=Enter URL to test: "
    echo.
    echo Select audit mode:
    echo   1^) Light ^(Performance only^)
    echo   2^) Full ^(Performance + SEO + Accessibility + Best Practices^)
    echo.
    set /p "modeChoice=Enter choice [1-2]: "
    echo.
    if "!modeChoice!"=="2" (
        set mode=full
    ) else (
        set mode=light
    )
    echo Select device:
    echo   1^) Mobile
    echo   2^) Desktop
    echo.
    set /p "deviceChoice=Enter choice [1-2]: "
    echo.
    if "!deviceChoice!"=="2" (
        set device=desktop
    ) else (
        set device=mobile
    )
    echo.
    echo Running: node seo-speed-audit.js --url "!url!" --audit !mode! --device !device!
    node seo-speed-audit.js --url "!url!" --audit !mode! --device !device!
) else (
    rem User chose 1 - Full site audit (or invalid input defaults to 1)
    node seo-speed-audit.js
)

echo.
echo Done. Press any key to exit.
pause >nul
endlocal