@echo off
setlocal
node "%~dp0scripts\launch_chrome_vulkan.cjs"
if errorlevel 1 pause
