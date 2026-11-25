@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "BE_DIR=%ROOT_DIR%\BE"
set "WORKER_PYTHON=D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe"

set "BUILD_FLAG="
set "NO_WORKER=0"
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--build" set "BUILD_FLAG=--build"
if /I "%~1"=="--no-worker" set "NO_WORKER=1"
shift
goto parse_args
:args_done

echo ==================================================
echo   Brain Tumor Segmentation - Docker Stack Launcher
echo ==================================================
echo.

echo [1/3] Kiem tra Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
    echo       Dang khoi dong Docker Desktop...
    docker desktop start --timeout 90
    if errorlevel 1 (
        echo [ERROR] Khong the ket noi Docker Desktop. Hay mo Docker Desktop thu cong roi thu lai.
        pause
        exit /b 1
    )
)
echo       Docker Desktop da san sang.

echo [2/3] Khoi dong full stack (PostgreSQL + Backend + Frontend)...
pushd "%ROOT_DIR%"
set "API_PORT="
for /f "tokens=2 delims=:" %%P in ('docker compose port api 8000 2^>nul') do set "API_PORT=%%P"
if "%API_PORT%"=="" (
    set "API_PORT=8000"
    powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
    if errorlevel 1 (
        set "API_PORT=8001"
        echo [INFO] Cong 8000 dang duoc su dung boi ung dung khac, tu dong chuyen API sang cong 8001.
    )
) else (
    echo [INFO] Container API dang chay san tren cong %API_PORT%.
)

docker compose up -d %BUILD_FLAG% --wait
if errorlevel 1 (
    popd
    echo [ERROR] Khong the khoi dong Docker Compose stack. Chay "docker compose logs" de xem chi tiet.
    pause
    exit /b 1
)
popd
echo       Ca 3 service (postgres, api, frontend) da san sang (healthy).

echo [3/3] Kiem tra va mo AI Worker (tuy chon)...
if "%NO_WORKER%"=="1" goto skip_worker
if not exist "%WORKER_PYTHON%" (
    echo [INFO] Bo qua AI Worker (khong tim thay "%WORKER_PYTHON%").
    goto done
)
if not exist "%BE_DIR%\.env" (
    echo [INFO] Bo qua AI Worker (khong tim thay "%BE_DIR%\.env").
    goto done
)

set "START_WORKER=1"
set "ENV_WORKER_TOKEN="
set "ENV_MODEL_CHECKPOINT_PATH="
set "ENV_MODEL_MANIFEST_PATH="
set "ENV_WORKER_DEVICE="
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%BE_DIR%\.env") do (
    if /I "%%A"=="WORKER_TOKEN" set "ENV_WORKER_TOKEN=%%B"
    if /I "%%A"=="MODEL_CHECKPOINT_PATH" set "ENV_MODEL_CHECKPOINT_PATH=%%B"
    if /I "%%A"=="MODEL_MANIFEST_PATH" set "ENV_MODEL_MANIFEST_PATH=%%B"
    if /I "%%A"=="WORKER_DEVICE" set "ENV_WORKER_DEVICE=%%B"
)

if "%ENV_WORKER_TOKEN%"=="" set "START_WORKER=0"
if "%ENV_MODEL_CHECKPOINT_PATH%"=="" set "START_WORKER=0"
if not "%ENV_MODEL_CHECKPOINT_PATH:REPLACE_WITH_=%"=="%ENV_MODEL_CHECKPOINT_PATH%" set "START_WORKER=0"
if not "%ENV_WORKER_TOKEN:REPLACE_WITH_=%"=="%ENV_WORKER_TOKEN%" set "START_WORKER=0"

if "%START_WORKER%"=="1" (
    start "BTS AI Worker" cmd /k ""%ROOT_DIR%\start-worker.bat""
) else (
    echo [INFO] Bo qua AI Worker (chua cau hinh WORKER_TOKEN / MODEL_CHECKPOINT_PATH trong BE\.env).
)
goto done

:skip_worker
echo [INFO] Da bo qua AI Worker theo tham so --no-worker.

:done
echo.
echo Hoan tat khoi dong Docker stack!
echo - Web UI : http://127.0.0.1:5173
echo - API    : http://127.0.0.1:%API_PORT%
echo - DB     : 127.0.0.1:5432
echo.
echo Meo:
echo - Rebuild image khi doi dependencies : start-dev.bat --build
echo - Khong bat AI Worker                 : start-dev.bat --no-worker
echo - Dung toan bo stack                  : docker compose down
echo.
endlocal
