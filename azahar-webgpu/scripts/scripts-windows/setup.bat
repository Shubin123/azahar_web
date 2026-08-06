@echo off
setlocal enabledelayedexpansion

REM ===================================
REM Azahar WebGPU Overlay Setup (Windows)
REM ===================================

set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%\..

echo ===================================
echo Azahar WebGPU Overlay Setup
echo ===================================

REM Normalize paths
pushd %PROJECT_ROOT%
for %%I in (.) do set PROJECT_ROOT=%%~fI
popd

REM Check if azahar exists
if not exist "%PROJECT_ROOT%\..\azahar" (
    echo Error: Azahar repository not found at %PROJECT_ROOT%\..\azahar
    echo.
    echo Please clone Azahar first:
    echo   git clone https://github.com/azahar-emu/azahar.git
    exit /b 1
)

echo ✓ Found Azahar repository

REM Clone GoogleTest if missing
if not exist "%PROJECT_ROOT%\external\googletest" (
    echo Cloning GoogleTest...
    git clone https://github.com/google/googletest.git "%PROJECT_ROOT%\external\googletest"
)

REM Optional: Clone Dawn
if "%1"=="--with-dawn" (
    if not exist "%PROJECT_ROOT%\external\dawn" (
        echo Cloning Dawn (this may take a while)...
        git clone https://dawn.googlesource.com/dawn "%PROJECT_ROOT%\external\dawn"
        pushd "%PROJECT_ROOT%\external\dawn"
        git checkout chromium/6045
        popd
    )
)

REM Create build directories
mkdir "%PROJECT_ROOT%\build-desktop" 2>nul
mkdir "%PROJECT_ROOT%\build-web" 2>nul
mkdir "%PROJECT_ROOT%\build-tests" 2>nul

echo.
echo ===================================
echo Setup complete!
echo ===================================
echo.
echo Next steps:
echo   1. Run tests:      scripts\run-tests.bat
echo   2. Build desktop:  scripts\build-desktop.bat
echo   3. Build web:      scripts\build-web.bat
echo.

endlocal
