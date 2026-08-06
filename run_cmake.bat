@echo off
REM Azahar WebAssembly CMake Configuration Script
REM Requires: Emscripten SDK (emsdk) installed and activated
REM Usage: run_cmake.bat

echo === Azahar Emscripten CMake Configuration ===

REM Use emcmake from PATH (requires activated emsdk environment)
emcmake cmake -G Ninja ^
  -B build-web ^
  -S azahar ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_CXX_STANDARD=20 ^
  -DENABLE_QT=OFF ^
  -DENABLE_SDL2=ON ^
  -DENABLE_SDL2_FRONTEND=ON ^
  -DENABLE_SOFTWARE_RENDERER=ON ^
  -DENABLE_OPENGL=OFF ^
  -DENABLE_VULKAN=OFF ^
  -DENABLE_CUBEB=OFF ^
  -DENABLE_OPENAL=OFF ^
  -DENABLE_ROOM=OFF ^
  -DENABLE_ROOM_STANDALONE=OFF ^
  -DENABLE_WEB_SERVICE=OFF ^
  -DENABLE_LIBUSB=OFF ^
  -DENABLE_TESTS=OFF ^
  -DCRYPTOPP_DISABLE_ASM=ON ^
  -DCITRA_WARNINGS_AS_ERRORS=OFF ^
  -DCITRA_USE_PRECOMPILED_HEADERS=OFF

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo === CMake configuration FAILED ===
    exit /b %ERRORLEVEL%
)

echo.
echo === CMake configuration OK ===
echo === Run the build with: cmake --build build-web
