@echo off
setlocal EnableExtensions
title 二周目协会 · 一键启动
cd /d "%~dp0"

rem ============================================================
rem  二周目协会 · 一键启动（Windows）
rem  用法：双击运行；或命令行 start.bat [--check | --prod]
rem    --check  只做环境自检（依赖/迁移），不启动服务器
rem    --prod   生产模式（先 build 再 start），默认开发模式
rem  Node 查找顺序：系统 PATH → 便携版 D:\tools\node22
rem  （可用环境变量 NGPLUS_NODE_DIR 覆盖便携版位置）
rem  DeepSeek API Key 不在这里填：启动后打开 面板 → 模型设置
rem ============================================================

set "MODE=%~1"
set "NODE_DIR=%NGPLUS_NODE_DIR%"
if "%NODE_DIR%"=="" set "NODE_DIR=D:\tools\node22"

rem ---------- 定位 Node ----------
where node >nul 2>nul
if errorlevel 1 (
  if exist "%NODE_DIR%\node.exe" (
    set "PATH=%NODE_DIR%;%PATH%"
  ) else (
    echo [x] 未找到 Node.js 22。请安装 Node 22，或将便携版放到 %NODE_DIR%
    echo     （也可用 set NGPLUS_NODE_DIR=... 指定便携版位置）
    pause
    exit /b 1
  )
)

rem ---------- 定位 pnpm ----------
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx pnpm"

echo ============================================
echo   二周目协会 · 一键启动
echo ============================================

rem ---------- [1/3] 依赖 ----------
echo [1/3] 检查依赖…
if not exist "node_modules\" (
  echo       首次运行：安装依赖，稍慢，请耐心等…
  call %PNPM% install
  if errorlevel 1 goto :fail
) else (
  node scripts/patch-sqlite3.mjs
  if errorlevel 1 goto :fail
)

rem ---------- [2/3] 本机基础配置 ----------
echo [2/3] 检查 .env.local…
if not exist ".env.local" (
  > ".env.local" echo CRON_ENABLED=1
  echo       已生成基础 .env.local，定时任务默认开启。
)
echo       没配 DeepSeek Key 也没关系：启动后打开 面板 → 模型设置 填一次即可。

rem ---------- [3/3] 数据库 + 启动 ----------
echo [3/3] 数据库迁移…
call %PNPM% db:migrate
if errorlevel 1 goto :fail

if "%MODE%"=="--check" (
  echo.
  echo [OK] 自检通过：依赖与数据库都就绪。运行 start.bat 即可进入协会。
  exit /b 0
)

echo 启动协会…浏览器稍后自动打开 http://localhost:3000（Ctrl+C 停止）
start "" cmd /c "timeout /t 5 >nul & start "" http://localhost:3000"
if "%MODE%"=="--prod" (
  call %PNPM% build
  if errorlevel 1 goto :fail
  call %PNPM% start
) else (
  call %PNPM% dev
)
goto :eof

:fail
echo.
echo [x] 启动失败。把上面的报错原样带走，交给开发或 ZCode。
pause
exit /b 1
