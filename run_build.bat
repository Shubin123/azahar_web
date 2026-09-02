@echo off
cd /d C:\Users\shubadub\Documents\azahar
cmake --build build-web2 --parallel 8 > build_file.txt 2>&1
if %ERRORLEVEL% EQU 0 (
    echo BUILD_DONE >> build_file.txt
) else (
    echo BUILD_FAILED >> build_file.txt
)
