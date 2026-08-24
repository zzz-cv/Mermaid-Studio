@echo off
setlocal
cd /d "%~dp0"
if exist "release\Mermaid-Studio-Windows-x64\Mermaid Studio.exe" (
  start "" "release\Mermaid-Studio-Windows-x64\Mermaid Studio.exe"
  exit /b 0
)
echo Mermaid Studio lightweight build has not been created yet.
echo Run: npm run dist:win
pause
