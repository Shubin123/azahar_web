@echo off
REM Backward-compatible entry point; the build no longer depends on a source
REM tree outside this repository.
call "%~dp0build_web.bat" %* > "%~dp0build_file.txt" 2>&1
if %ERRORLEVEL% EQU 0 (
    echo BUILD_DONE >> "%~dp0build_file.txt"
) else (
    echo BUILD_FAILED >> "%~dp0build_file.txt"
)
exit /b %ERRORLEVEL%
