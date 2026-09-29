@echo off
rem ---------------------------------------------------------------------
rem  WWriting quick launcher - double-click this file.
rem
rem  What it does:
rem    1. check Node
rem    2. update this copy to the latest code (git pull + deps)
rem    3. pop up a folder picker
rem    4. open a command line in the picked folder and start the tool
rem
rem  This file is intentionally ASCII-only. Every Chinese message is
rem  printed by scripts\launcher.ps1, which is saved as UTF-8 with BOM
rem  so that Windows PowerShell 5.1 parses it correctly.
rem ---------------------------------------------------------------------
chcp 65001 >nul
title WWriting
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1" %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%
