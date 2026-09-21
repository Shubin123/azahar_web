@echo off
REM Use the same pinned, repo-owned build as macOS/Linux through Git Bash.
REM Git for Windows supplies bash.exe; this avoids maintaining two divergent
REM CMake configurations and preserves the existing .bat entry point.
setlocal
where bash.exe >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Git Bash is required. Install Git for Windows, then run this again.
    exit /b 1
)
bash.exe "%~dp0build_web.sh" %*
exit /b %ERRORLEVEL%
