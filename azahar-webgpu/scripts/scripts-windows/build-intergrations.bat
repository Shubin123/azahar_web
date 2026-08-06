@echo off
setlocal

REM ===================================
REM Build with Azahar Integration
REM ===================================

set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%..\..\..\

echo ===================================
echo Building with Azahar Integration
echo ===================================

if not exist "%PROJECT_ROOT%\azahar" (
    echo Error: Azahar repository not found at %PROJECT_ROOT%azahar
    exit /b 1
)

mkdir "%PROJECT_ROOT%\build-integration" 2>nul
pushd "%PROJECT_ROOT%\build-integration"

cmake .. ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DBUILD_TESTS=OFF ^
    -DBUILD_EXAMPLES=OFF ^
    -DINTEGRATE_AZAHAR=ON ^
    -DUSE_WEBGPU=ON

cmake --build . --config Release

echo.
echo ===================================
echo Build complete!
echo ===================================
echo.
echo Azahar with WebGPU:
echo   build-integration\azahar\bin\azahar-qt.exe
echo.

popd
endlocal
