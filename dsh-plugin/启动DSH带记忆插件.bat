@echo off
chcp 65001 >nul
title DSH + memory-system plugin
echo ============================================
echo   DSH + memory-system plugin
echo ============================================
echo.
echo [NOTE] The plugin is installed in the DSH web profile.
echo        Just run: dsh web
echo.
echo [NOTE] If EADDRINUSE appears below, port 3080 is in use.
echo        Close the old window / desktop app first.
echo.
echo [NOTE] The URL with token will be printed below.
echo        DO NOT close this window - closing it stops DSH.
echo.
echo --------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "dsh web"
