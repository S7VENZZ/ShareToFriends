@echo off
rem Builds StfAudioCapture.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo C# compiler not found: %CSC%
  exit /b 1
)
"%CSC%" /nologo /optimize+ /platform:x64 /target:exe /out:"%~dp0StfAudioCapture.exe" "%~dp0StfAudioCapture.cs"
exit /b %ERRORLEVEL%
