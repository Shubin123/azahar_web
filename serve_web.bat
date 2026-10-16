@echo off
REM Serve web/ on the LAN over HTTPS with the headers required for WebAssembly
REM pthreads, sharing save states with every browser that opens it.
setlocal
if "%PORT%"=="" set "PORT=8765"
node "%~dp0web\server.cjs" --lan
