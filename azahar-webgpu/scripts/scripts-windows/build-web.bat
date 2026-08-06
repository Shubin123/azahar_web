@echo off
setlocal

REM ===================================
REM Build WebGPU Wrapper (Web / Emscripten)
REM ===================================

set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%\..

echo ===================================
echo Building WebGPU Wrapper (Web)
echo ===================================

if "%EMSDK%"=="" (
    echo Error: EMSDK environment not detected.
    echo Run emsdk_env.bat first.
    exit /b 1
)

mkdir "%PROJECT_ROOT%\build-web" 2>nul
pushd "%PROJECT_ROOT%\build-web"

emcmake cmake .. ^
    -DBUILD_TESTS=OFF ^
    -DBUILD_EXAMPLES=ON ^
    -DINTEGRATE_AZAHAR=OFF

cmake --build .

popd
endlocal
