@echo off
setlocal
set "R=%~dp0.."
set "M=%R%\models\chat"
tasklist 2>nul | "%SystemRoot%\System32\find.exe" /i "hilbertraum" >nul && ( echo   Quit HilbertRaum first. & exit /b 1 )
rem Workspace F's active model is the 9B; the 14B is the one pressed by hand. Both must be visible.
if exist "%M%\qwen3-14b-instruct-q4.gguf.away" ren "%M%\qwen3-14b-instruct-q4.gguf.away" "qwen3-14b-instruct-q4.gguf" || exit /b 1
if exist "%M%\qwen3.5-9b-ud-q4kxl.gguf.away" ren "%M%\qwen3.5-9b-ud-q4kxl.gguf.away" "qwen3.5-9b-ud-q4kxl.gguf" || exit /b 1
call "%~dp0swap.cmd" F || exit /b 1
echo   Leg 5 ready: both model files are back and workspace F is in place.
echo   Now start _334-start-perf.cmd and unlock. About 20 s later open Models and press "Use model" on the 14B.
