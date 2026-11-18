@echo off
rem ==============================================================
rem  pet-hub patch - one-click uninstall wrapper
rem  Deliberately pure ASCII: Chinese appears only in file names,
rem  so this file works under any cmd.exe code page.
rem  Extra arguments are passed through to the .ps1, for example:
rem    -PurgeData   (also clear %APPDATA%\MCHOSEHUB config/log/cache)
rem ==============================================================
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
set "PETHUB_DIR=%~dp0"
set "PETHUB_SELF=%~f0"
pushd "%PETHUB_DIR%"

if not exist "%PETHUB_DIR%detect-mhub.ps1" goto :no_package

rem --- already elevated? then go straight to the real work ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto :run

echo [pet-hub] Administrator rights are required.
echo [pet-hub] Asking Windows for elevation - click "Yes" on the UAC prompt.
rem --- relaunch this same cmd elevated; $env:PETHUB_SELF keeps the CJK path safe ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:PETHUB_SELF -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 goto :uac_cancelled
echo [pet-hub] An elevated window was started. You can close this one.
popd
exit /b 0

:uac_cancelled
echo.
echo [pet-hub] Elevation was cancelled or refused - nothing was changed.
echo [pet-hub] TIP: right-click this file and pick "Run as administrator".
echo.
pause
popd
exit /b 3

:no_package
echo.
echo [pet-hub] ERROR: this does not look like a complete package folder.
echo [pet-hub] Unzip the WHOLE package folder first, then double-click this file again.
echo.
pause
popd
exit /b 2

:run
echo [pet-hub] Running as administrator - removing the desktop-pet module.
rem --- resolve the CJK uninstaller file name from code points so this file stays
rem --- pure ASCII: U+5378 U+8F7D are the two characters of the uninstall script name
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$n=[string][char]0x5378+[char]0x8F7D+'.ps1'; Join-Path $env:PETHUB_DIR $n"`) do set "PETHUB_PS1=%%N"
if not defined PETHUB_PS1 goto :no_ps1
if not exist "%PETHUB_PS1%" goto :no_ps1

powershell -NoProfile -ExecutionPolicy Bypass -File "%PETHUB_PS1%" %*
set "PETHUB_RC=%ERRORLEVEL%"
echo.
if "%PETHUB_RC%"=="0" echo [pet-hub] Done. MCHOSE HUB keeps running with its official entry.
if not "%PETHUB_RC%"=="0" echo [pet-hub] Finished with errors - exit code %PETHUB_RC%.
echo.
pause
popd
exit /b %PETHUB_RC%

:no_ps1
echo.
echo [pet-hub] ERROR: the uninstaller script is missing next to this file.
echo [pet-hub] Unzip the WHOLE package folder first, then double-click this file again.
echo.
pause
popd
exit /b 2
