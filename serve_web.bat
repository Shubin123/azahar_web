@echo off
REM Serve web/ on the LAN with the headers required for WebAssembly pthreads.
setlocal
if "%PORT%"=="" set "PORT=8765"
set "HOST=0.0.0.0"
echo Azahar unified web UI: http://localhost:%PORT%/
node "%~dp0web\server.cjs"
