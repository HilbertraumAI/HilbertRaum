@echo off
rem ============================================================================
rem  swap.cmd -- #330 round-trip helper. Lives in <drive>\_330\ ; the drive root is
rem  its parent. Puts one of the two test workspaces in place, or sets the current
rem  one aside, by RENAMING (never deleting) the three files that make a workspace:
rem    workspace\            <->  workspace.<X>\
rem    config\workspace.json <->  config\workspace.<X>.json
rem    logs\app.log.enc      <->  logs\app.<X>.log.enc
rem  The marker _330\inplace.txt remembers which one (F or U) is in place.
rem
rem    swap.cmd F        put the fresh workspace in place (sets aside U first if needed)
rem    swap.cmd U        put the upgraded workspace in place (sets aside F first if needed)
rem    swap.cmd aside    set the current one aside
rem    swap.cmd status   say what is in place
rem
rem  Refuses while the app is running or while -wal/-shm sidecars are present
rem  (the last session did not end cleanly -- start the app, quit it, retry).
rem ============================================================================
setlocal enableextensions
set "R=%~dp0.."
set "MARK=%~dp0inplace.txt"
set "WANT=%~1"

if /i "%WANT%"=="status" goto :status
if /i "%WANT%"=="aside" goto :aside
if /i "%WANT%"=="F" goto :put
if /i "%WANT%"=="U" goto :put
echo usage: swap.cmd F ^| U ^| aside ^| status
exit /b 2

:guard
tasklist 2>nul | "%SystemRoot%\System32\find.exe" /i "hilbertraum" >nul && (
  echo   HilbertRaum is still running. Quit it first.
  exit /b 1
)
if exist "%R%\workspace\hilbertraum.sqlite*-wal" (
  echo   -wal sidecar present: the last session did not end cleanly. Start + quit the app, then retry.
  exit /b 1
)
if exist "%R%\workspace\hilbertraum.sqlite*-shm" (
  echo   -shm sidecar present: the last session did not end cleanly. Start + quit the app, then retry.
  exit /b 1
)
exit /b 0

:status
if exist "%MARK%" (
  set /p CUR=<"%MARK%"
  call echo   In place: %%CUR%%
) else (
  echo   Nothing in place.
)
dir /b "%R%\workspace*" 2>nul
dir /b "%R%\config\workspace*" 2>nul
dir /b "%R%\logs\app*" 2>nul
exit /b 0

:aside
call :guard || exit /b 1
if not exist "%MARK%" (
  echo   Nothing is in place; nothing to set aside.
  exit /b 0
)
set /p CUR=<"%MARK%"
if not exist "%R%\workspace" ( echo   workspace\ missing but marker says %CUR% -- inspect by hand. & exit /b 1 )
ren "%R%\workspace" "workspace.%CUR%" || exit /b 1
ren "%R%\config\workspace.json" "workspace.%CUR%.json" || exit /b 1
if exist "%R%\logs\app.log.enc" ren "%R%\logs\app.log.enc" "app.%CUR%.log.enc"
del "%MARK%"
echo   Set %CUR% aside.
exit /b 0

:put
call :guard || exit /b 1
set "CUR="
if exist "%MARK%" set /p CUR=<"%MARK%"
if /i "%CUR%"=="%WANT%" ( echo   %WANT% is already in place. & exit /b 0 )
if exist "%MARK%" call :aside || exit /b 1
if not exist "%R%\workspace.%WANT%" ( echo   workspace.%WANT% not found. & exit /b 1 )
if not exist "%R%\config\workspace.%WANT%.json" ( echo   config\workspace.%WANT%.json not found. & exit /b 1 )
ren "%R%\workspace.%WANT%" "workspace" || exit /b 1
ren "%R%\config\workspace.%WANT%.json" "workspace.json" || exit /b 1
if exist "%R%\logs\app.%WANT%.log.enc" ren "%R%\logs\app.%WANT%.log.enc" "app.log.enc"
>"%MARK%" echo %WANT%
echo   %WANT% is in place. Start the app with "Start HilbertRaum.cmd".
exit /b 0
