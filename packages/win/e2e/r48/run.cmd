@echo off
setlocal
node "%~dp0run-suite.mjs" %*
exit /b %errorlevel%
