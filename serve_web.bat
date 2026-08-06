@echo off
REM Serve web/ on the LAN with the headers required for WebAssembly pthreads.
setlocal
if "%PORT%"=="" set "PORT=9000"
set "HOST=0.0.0.0"
node "%~dp0web\server.cjs"
