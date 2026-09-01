@echo off
REM Build, synchronize web/ artifacts, and verify the served files match.
setlocal

cmake --build "%~dp0build-web2" --parallel 8 --target azahar_web_assets
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

node "%~dp0tests\web_artifact_smoke.cjs"
exit /b %ERRORLEVEL%
