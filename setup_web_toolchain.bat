@echo off
setlocal
where bash.exe >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Git Bash is required. Install Git for Windows, then run this again.
    exit /b 1
)
bash.exe "%~dp0setup_web_toolchain.sh" %*
exit /b %ERRORLEVEL%
