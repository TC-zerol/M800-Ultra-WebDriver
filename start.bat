@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo starting local server: http://127.0.0.1:8765
echo open the URL above in Chrome or Edge, then click "connect receiver"
start "" http://127.0.0.1:8765
python -m http.server 8765 --bind 127.0.0.1
pause
