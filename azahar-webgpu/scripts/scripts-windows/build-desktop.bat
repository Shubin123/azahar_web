@echo off
setlocal

REM ===================================
REM Build WebGPU Wrapper (Desktop)
REM ===================================

set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%\..

echo ===================================
echo Building WebGPU Wrapper (Desktop)
echo ===================================

mkdir "%PROJECT_ROOT%\build-desktop" 2>nul
pushd "%PROJECT_ROOT%\build-desktop"

cmake .. ^
    -DCMAKE_BUILD_TYPE=Debug ^
    -DBUILD_TESTS=ON ^
    -DBUILD_EXAMPLES=ON ^
    -DINTEGRATE_AZAHAR=OFF

cmake --build . --config Debug

echo.
echo ===================================
echo Build complete!
echo ===================================
echo.
echo Run tests:
echo   cd build-desktop ^&^& ctest
echo Run examples:
echo   build-desktop\examples\01_triangle\Debug\01_triangle.exe
echo.

popd
endlocal
