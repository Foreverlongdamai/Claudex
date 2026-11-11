@echo off
chcp 65001 >nul
rem 双击启动 Claudex：第一次会安装依赖，每次启动前用最新代码构建一遍。
cd /d "%~dp0"
if not exist node_modules (
  echo 第一次启动，正在安装依赖，需要几分钟……
  call npm install || goto :fail
)
echo 正在构建……
call npx electron-vite build >nul 2>&1 || goto :fail
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:fail
echo.
echo 启动失败。请在这个文件夹里打开终端，运行 npm install 和 npm start 查看具体错误。
pause
