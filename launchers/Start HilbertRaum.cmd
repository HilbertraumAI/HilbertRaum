@echo off
rem ============================================================================
rem  Start HilbertRaum (Windows launcher) -- Phase 13, spec section 6.
rem
rem  This file lives at the DRIVE ROOT. Double-clicking it starts the app.
rem  It derives the drive root from its OWN location (%~dp0) every launch, so the
rem  same drive works on any laptop no matter which drive letter it is given
rem  (E:\ on one machine, F:\ on the next). NO path is hardcoded.
rem
rem  Mirrors apps/desktop/src/main/services/launcher.ts resolveDriveRootFromLauncher.
rem ============================================================================
setlocal enableextensions

rem %~dp0 = this script's directory, with a trailing backslash = the drive root.
set "HILBERTRAUM_DRIVE_ROOT=%~dp0"
rem One source of truth: the app reads the SAME manifests the drive scripts verified.
set "HILBERTRAUM_MANIFESTS_DIR=%~dp0model-manifests"

rem Find the portable app (the version is part of its name). Take the FIRST match, to
rem match the first-match behaviour of the macOS/Linux launchers (consistent selection
rem if more than one version is ever left on the drive).
set "APP="
for %%f in ("%~dp0HilbertRaum-*-portable.exe") do if not defined APP set "APP=%%f"

if not defined APP (
  echo.
  echo   Could not find the HilbertRaum app on this drive.
  echo   Make sure HilbertRaum-...-portable.exe is in this folder.
  echo   See docs\troubleshooting.md for help.
  echo.
  pause
  exit /b 1
)

rem If Windows SmartScreen says "Windows protected your PC", click "More info"
rem then "Run anyway" (see READ ME FIRST.txt / docs\troubleshooting.md).
start "" "%APP%"
endlocal
