@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REPO=%~dp0"
set "PKG=%REPO%package.json"
set "DIST=%REPO%dist-desktop\win-unpacked"
set "EXE=%DIST%\WWriting Novel Agent.exe"

if not exist "%PKG%" (
  echo ERROR: package.json not found: %PKG%
  echo Please run this script from the WWriting repository root.
  pause
  exit /b 1
)

echo [1/5] Stop any running WWriting instance...
taskkill /IM "WWriting Novel Agent.exe" /F >nul 2>&1
taskkill /IM "WWriting.exe" /F >nul 2>&1
if errorlevel 1 (
  echo      No running instance found, continuing...
) else (
  echo      Stopped running instance.
  timeout /T 2 /NOBREAK >nul 2>&1
)

echo [2/5] Clean previous packaged output...
if exist "%REPO%dist-desktop" (
  timeout /T 1 /NOBREAK >nul 2>&1
  rmdir /S /Q "%REPO%dist-desktop" >nul 2>&1
  if exist "%REPO%dist-desktop" (
    echo      Normal delete failed, trying rename-and-delete...
    set "OLD_DIST=%REPO%dist-desktop.old.%RANDOM%"
    move /Y "%REPO%dist-desktop" "!OLD_DIST!" >nul 2>&1
    if exist "!OLD_DIST!" (
      rmdir /S /Q "!OLD_DIST!" >nul 2>&1
      if exist "!OLD_DIST!" (
        echo      Rename delete also failed, trying robocopy mirror trick...
        mkdir "!OLD_DIST!\empty" >nul 2>&1
        robocopy "!OLD_DIST!\empty" "!OLD_DIST!" /MIR /NJH /NJS /NDL /NFL /NC /NS /NP >nul 2>&1
        rmdir /S /Q "!OLD_DIST!" >nul 2>&1
      )
    )
  )
  if exist "%REPO%dist-desktop" (
    echo WARNING: Could not fully clean dist-desktop. electron-builder will overwrite existing files.
    echo          If packaging fails, close any Explorer windows pointing to dist-desktop and retry.
    timeout /T 2 /NOBREAK >nul 2>&1
  ) else (
    echo      Cleaned previous packaged output.
  )
)

echo [3/5] Install dependencies if needed...
if not exist "%REPO%node_modules" (
  call npm ci
  if errorlevel 1 (
    echo ERROR: npm ci failed.
    pause
    exit /b 1
  )
)

echo [4/5] Package desktop app...
call npm run package:dir
if errorlevel 1 (
  echo ERROR: npm run package:dir failed.
  pause
  exit /b 1
)

if not exist "%EXE%" (
  echo ERROR: Packaged executable not found: %EXE%
  pause
  exit /b 1
)

echo [5/5] Launch: %EXE%
start "" "%EXE%"

endlocal
