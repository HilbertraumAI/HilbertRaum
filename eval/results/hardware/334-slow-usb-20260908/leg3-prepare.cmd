@echo off
setlocal
set "R=%~dp0.."
set "M=%R%\models\chat"
tasklist 2>nul | "%SystemRoot%\System32\find.exe" /i "hilbertraum" >nul && ( echo   Quit HilbertRaum first. & exit /b 1 )
rem Workspace U's active model is the 14B (selected on the i7 at 00:39Z): hide THAT one so the
rem automatic start fails fast; the 9B stays visible.
if exist "%M%\qwen3.5-9b-ud-q4kxl.gguf.away" ren "%M%\qwen3.5-9b-ud-q4kxl.gguf.away" "qwen3.5-9b-ud-q4kxl.gguf" || exit /b 1
if exist "%M%\qwen3-14b-instruct-q4.gguf" ren "%M%\qwen3-14b-instruct-q4.gguf" "qwen3-14b-instruct-q4.gguf.away" || exit /b 1
call "%~dp0swap.cmd" U || exit /b 1
echo   Leg 3 ready: the 14B file is hidden and workspace U is in place.
echo   Now start _334-start-perf.cmd and unlock. Press nothing until "Benchmark complete".
