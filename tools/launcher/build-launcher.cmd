@echo off
rem ============================================================
rem  Build the native dsh-to-go launcher (WinForms + WebView2).
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

set "SDK=%ROOT%\third_party\webview2"
if not exist "%SDK%\Microsoft.Web.WebView2.Core.dll" (
  echo [launcher] missing WebView2 SDK in %SDK%
  exit /b 1
)
if not exist "%ROOT%\runtime\node\node.exe" (
  echo [launcher] warning: runtime\node\node.exe is missing; the built launcher
  echo [launcher]          will show a "run build.cmd first" page instead.
)

set "OUT=%ROOT%"

"%CSC%" /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ^
  /out:"%ROOT%\dsh-to-go.exe" ^
  /win32icon:"%ROOT%\assets\app.ico" ^
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
  /r:System.Net.Http.dll ^
  /r:"%SDK%\Microsoft.Web.WebView2.Core.dll" ^
  /r:"%SDK%\Microsoft.Web.WebView2.WinForms.dll" ^
  "%HERE%\DshLauncher.cs"
if errorlevel 1 (
  echo [launcher] build FAILED
  exit /b 1
)


echo [launcher] built %ROOT%\dsh-to-go.exe
endlocal
exit /b 0
