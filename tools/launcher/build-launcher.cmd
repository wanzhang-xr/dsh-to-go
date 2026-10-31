@echo off
rem ============================================================
rem  Build dsh-to-go.exe (the tiny entry shim in the repo root).
rem
rem  Default: compile Shim.cs -> dsh-to-go.exe
rem    The shim launches runtime\electron\dist\electron.exe (the desktop
rem    shell lives in tools\electron\main.js) and falls back to dsh-ui.cmd
rem    (browser entry) when Electron is not there yet.
rem
rem  Legacy:  build-launcher.cmd legacy -> compiles DshLauncher.cs, the old
rem    WinForms + WebView2 shell (needs third_party\webview2 + WebView2
rem    runtime on the host). Kept only for reference / rollback.
rem
rem  Uses the C# compiler that ships with Windows (.NET Framework).
rem  Keep this file pure ASCII (see dsh-ui.cmd for the reason).
rem ============================================================
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "ROOT=%HERE%\..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [launcher] csc.exe not found: %CSC%
  exit /b 1
)

if /I "%~1"=="legacy" goto :legacy

rem ---------------------------------------------------------------- default: shim
"%CSC%" /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ^
  /out:"%ROOT%\dsh-to-go.exe" ^
  /win32icon:"%ROOT%\assets\app.ico" ^
  /r:System.dll ^
  "%HERE%\Shim.cs"
if errorlevel 1 (
  echo [launcher] build FAILED
  exit /b 1
)
echo [launcher] built %ROOT%\dsh-to-go.exe (shim, launches runtime\electron)
endlocal
exit /b 0

rem ------------------------------------------------------- legacy: WebView2 shell
:legacy
set "SDK=%ROOT%\third_party\webview2"
if not exist "%SDK%\Microsoft.Web.WebView2.Core.dll" (
  echo [launcher] missing WebView2 SDK in %SDK%
  exit /b 1
)

"%CSC%" /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ^
  /out:"%ROOT%\dsh-to-go.exe" ^
  /win32icon:"%ROOT%\assets\app.ico" ^
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
  /r:System.Net.Http.dll ^
  /r:"%SDK%\Microsoft.Web.WebView2.Core.dll" ^
  /r:"%SDK%\Microsoft.Web.WebView2.WinForms.dll" ^
  "%HERE%\DshLauncher.cs"
if errorlevel 1 (
  echo [launcher] legacy build FAILED
  exit /b 1
)
echo [launcher] built %ROOT%\dsh-to-go.exe (LEGACY WinForms + WebView2 shell)
endlocal
exit /b 0
