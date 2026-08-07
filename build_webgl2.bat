@echo off
REM Build the opt-in WebGL2 artifact without replacing the stable software one.
REM Configure once with -DENABLE_WEBGL2_RENDERER=ON (build_wasm.sh does this).
setlocal

cmake --build "%~dp0build-web" --parallel 8 --target azahar_webgl2_assets
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

node "%~dp0tests\web_artifact_smoke.cjs" --artifact webgl2
exit /b %ERRORLEVEL%
