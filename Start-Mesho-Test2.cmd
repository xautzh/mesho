@echo off

set "ELECTRON_RUN_AS_NODE="

set "MESHO_DATA_DIR=%APPDATA%\Mesho-Test2"

set "MESHO_EXE=%~dp0desktop\release-0.6.1\win-unpacked\Mesho.exe"
if not exist "%MESHO_EXE%" set "MESHO_EXE=%~dp0desktop\release\win-unpacked\Mesho.exe"
if exist "%MESHO_EXE%" (
  start "" "%MESHO_EXE%"
) else (
  cd /d "%~dp0desktop"
  if not exist node_modules call npm ci
  call npm start
)
