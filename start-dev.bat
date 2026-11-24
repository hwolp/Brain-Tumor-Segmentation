@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "BE_DIR=%ROOT_DIR%\BE"
set "FE_DIR=%ROOT_DIR%\FE"
set "WORKER_PYTHON=D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe"

echo ==================================================
echo   Brain Tumor Segmentation - Local Dev Launcher
echo ==================================================
echo.

if not exist "%BE_DIR%\.venv\Scripts\python.exe" (
    echo [ERROR] Khong tim thay "%BE_DIR%\.venv\Scripts\python.exe".
    pause
    exit /b 1
)

if not exist "%BE_DIR%\.env" (
    echo [ERROR] Khong tim thay "%BE_DIR%\.env". Hay copy tu BE\.env.example truoc.
    pause
    exit /b 1
)

if not exist "%FE_DIR%\.env" (
    echo [ERROR] Khong tim thay "%FE_DIR%\.env". Hay copy tu FE\.env.example truoc.
    pause
    exit /b 1
)

echo [1/4] Khoi dong PostgreSQL (Docker Compose)...
pushd "%ROOT_DIR%"
docker compose up -d postgres
if errorlevel 1 (
    popd
    echo [ERROR] Khong the khoi dong PostgreSQL. Kiem tra Docker Desktop da bat chua.
    pause
    exit /b 1
)

echo [2/4] Dang cho PostgreSQL san sang...
set /a TRIES=0
:wait_pg
docker exec braintumorsegmentation-postgres-1 pg_isready -U bts_user -d bts_dev >nul 2>&1
if not errorlevel 1 goto pg_ready
set /a TRIES+=1
if %TRIES% GEQ 30 (
    popd
    echo [ERROR] Qua thoi gian cho PostgreSQL healthy.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait_pg

:pg_ready
popd
echo       PostgreSQL da san sang.

echo [3/4] Kiem tra va chay Alembic migration...
pushd "%BE_DIR%"
".venv\Scripts\python.exe" -m alembic -c alembic.ini upgrade head
if errorlevel 1 (
    popd
    echo [ERROR] Chay Alembic migration that bai.
    pause
    exit /b 1
)
popd

set "BE_PORT=8000"
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
    set "BE_PORT=8001"
    echo [INFO] Cong 8000 dang duoc su dung boi ung dung khac, tu dong chuyen Backend sang cong 8001.
)

echo [4/4] Mo cua so Backend, Frontend (va AI Worker neu kha dung)...
start "BTS Backend (FastAPI :%BE_PORT%)" cmd /k "cd /d ""%BE_DIR%"" && "".venv\Scripts\python.exe"" -m uvicorn app.main:app --host 127.0.0.1 --port %BE_PORT%"
start "BTS Frontend (Vite :5173)" cmd /k "cd /d ""%FE_DIR%"" && set ""VITE_API_PROXY_TARGET=http://127.0.0.1:%BE_PORT%"" && npm run dev -- --host 127.0.0.1 --port 5173"

if /I "%~1"=="--no-worker" goto skip_worker
if not exist "%WORKER_PYTHON%" (
    echo [INFO] Bo qua AI Worker (khong tim thay "%WORKER_PYTHON%").
    goto done
)

set "START_WORKER=1"
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%BE_DIR%\.env") do (
    if /I "%%A"=="WORKER_TOKEN" set "ENV_WORKER_TOKEN=%%B"
    if /I "%%A"=="MODEL_CHECKPOINT_PATH" set "ENV_MODEL_CHECKPOINT_PATH=%%B"
    if /I "%%A"=="MODEL_MANIFEST_PATH" set "ENV_MODEL_MANIFEST_PATH=%%B"
    if /I "%%A"=="WORKER_API_BASE_URL" set "ENV_WORKER_API_BASE_URL=%%B"
    if /I "%%A"=="WORKER_DEVICE" set "ENV_WORKER_DEVICE=%%B"
)

if "%ENV_WORKER_TOKEN%"=="" set "START_WORKER=0"
if "%ENV_MODEL_CHECKPOINT_PATH%"=="" set "START_WORKER=0"
if not "%ENV_MODEL_CHECKPOINT_PATH:REPLACE_WITH_=%"=="%ENV_MODEL_CHECKPOINT_PATH%" set "START_WORKER=0"
if not "%ENV_WORKER_TOKEN:REPLACE_WITH_=%"=="%ENV_WORKER_TOKEN%" set "START_WORKER=0"

if "%START_WORKER%"=="1" (
    set "ENV_WORKER_API_BASE_URL=http://127.0.0.1:%BE_PORT%"
    if "%ENV_MODEL_MANIFEST_PATH%"=="" set "ENV_MODEL_MANIFEST_PATH=worker/manifest.json"
    if "%ENV_WORKER_DEVICE%"=="" set "ENV_WORKER_DEVICE=cpu"
    start "BTS AI Worker" cmd /k "cd /d ""%BE_DIR%"" && set ""WORKER_API_BASE_URL=%ENV_WORKER_API_BASE_URL%"" && set ""WORKER_TOKEN=%ENV_WORKER_TOKEN%"" && set ""WORKER_ID=local-worker-1"" && set ""MODEL_MANIFEST_PATH=%ENV_MODEL_MANIFEST_PATH%"" && set ""MODEL_CHECKPOINT_PATH=%ENV_MODEL_CHECKPOINT_PATH%"" && set ""WORKER_DEVICE=%ENV_WORKER_DEVICE%"" && ""%WORKER_PYTHON%"" -m worker.service"
) else (
    echo [INFO] Bo qua AI Worker (chua cau hinh WORKER_TOKEN / MODEL_CHECKPOINT_PATH trong BE\.env).
)
goto done

:skip_worker
echo [INFO] Da bo qua AI Worker theo tham so --no-worker.

:done
echo.
echo Hoan tat khoi dong!
echo - Web UI : http://127.0.0.1:5173
echo - API    : http://127.0.0.1:%BE_PORT%
echo.
endlocal
