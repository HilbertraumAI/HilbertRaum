@echo off
rem ============================================================================
rem  Start HilbertRaum (Windows launcher) -- Phase 13, spec section 6.
rem
rem  This file lives at the DRIVE ROOT. Double-clicking it starts the app.
rem  It derives the drive root from its OWN location (%~dp0) every launch, so the
rem  same drive works on any laptop no matter which drive letter it is given
rem  (E:\ on one machine, F:\ on the next). NO path is hardcoded.
rem
rem  "Start HilbertRaum.cmd" /check  names the app it would start and starts
rem  nothing (a support tool -- see docs\troubleshooting.md).
rem
rem  Mirrors apps/desktop/src/main/services/launcher.ts resolveDriveRootFromLauncher.
rem ============================================================================
setlocal enableextensions

set "CHECK="
if /i "%~1"=="/check" set "CHECK=1"

rem %~dp0 = this script's directory, with a trailing backslash = the drive root.
set "HILBERTRAUM_DRIVE_ROOT=%~dp0"
rem One source of truth: the app reads the SAME manifests the drive scripts verified.
set "HILBERTRAUM_MANIFESTS_DIR=%~dp0model-manifests"

rem Find the portable app (the version is part of its name) and count the matches.
set "APP="
set "APP_COUNT=0"
for %%f in ("%~dp0HilbertRaum-*-portable.exe") do (
  set /a APP_COUNT+=1
  if not defined APP set "APP=%%f"
)

if not defined APP (
  echo.
  echo   Could not find the HilbertRaum app on this drive.
  echo   Make sure HilbertRaum-...-portable.exe is in this folder.
  echo   See docs\troubleshooting.md for help.
  echo.
  if not defined CHECK pause
  exit /b 1
)

rem Two app versions on one drive must never run: an older build beside a newer
rem one can destroy the workspace (#235). Refuse, say what to delete, never delete.
if %APP_COUNT% GTR 1 (
  echo.
  echo   More than one HilbertRaum app was found on this drive:
  for %%f in ("%~dp0HilbertRaum-*-portable.exe") do echo     %%~nxf
  echo.
  echo   Two versions must never run from one drive. Keep only the newest
  echo   HilbertRaum-...-portable.exe, delete the older one, then start again.
  echo   See docs\troubleshooting.md, "Two app versions on the drive".
  echo.
  if not defined CHECK pause
  exit /b 1
)

rem /check: report and stop. Delayed expansion keeps a drive path with special
rem characters from being re-parsed; it is enabled only for these lines.
if defined CHECK setlocal enabledelayedexpansion
if defined CHECK echo.
if defined CHECK echo   HilbertRaum launcher check
if defined CHECK echo   Drive root : !HILBERTRAUM_DRIVE_ROOT!
if defined CHECK echo   App        : !APP!
if defined CHECK echo   Nothing was started.
if defined CHECK echo.
if defined CHECK exit /b 0

rem If Windows SmartScreen says "Windows protected your PC", click "More info"
rem then "Run anyway" (see READ ME FIRST.txt / docs\troubleshooting.md).
start "" "%APP%"
endlocal
