@echo off
chcp 65001 >nul
title 游戏项目启动器
cd /d "%~dp0"

set NODE=D:\cursor\resources\app\resources\helpers\node.exe
set PORT=4000

netstat -ano | findstr ":%PORT%" >nul 2>&1
if %errorlevel%==0 (
    echo 端口 %PORT% 已被占用，可能已在运行。
) else (
    echo 正在启动服务器 (端口 %PORT%)...
    start "" /min "%NODE%" "node_modules\next\dist\bin\next" dev -p %PORT%
    timeout /t 10 /nobreak >nul
)

start http://localhost:%PORT%
echo 浏览器已打开: http://localhost:%PORT%
echo 关闭本窗口不会停止服务器。
echo 停止服务器请在任务管理器中结束 node.exe 进程。
pause
