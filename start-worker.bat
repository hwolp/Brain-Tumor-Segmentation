@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "BE_DIR=%ROOT_DIR%\BE"
set "WORKER_PYTHON=D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe"

set "CHECK_ONLY=0"
set "ARG_WORKER_ID="
set "ARG_DEVICE="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--check" (
    set "CHECK_ONLY=1"
) else if "%ARG_WORKER_ID%"=="" (
    set "ARG_WORKER_ID=%~1"
) else if "%ARG_DEVICE%"=="" (
    set "ARG_DEVICE=%~1"
)
shift
goto parse_args
:args_done

echo ==================================================
echo   Brain Tumor Segmentation - Local AI Worker
echo ==================================================
echo.

if not exist "%WORKER_PYTHON%" (
    echo [ERROR] Khong tim thay Python AI venv tai: "%WORKER_PYTHON%"
    exit /b 1
)

if not exist "%BE_DIR%\.env" (
    echo [ERROR] Khong tim thay file cau hinh: "%BE_DIR%\.env"
    exit /b 1
)

set "ENV_WORKER_TOKEN="
set "ENV_MODEL_CHECKPOINT_PATH="
set "ENV_MODEL_MANIFEST_PATH="
set "ENV_WORKER_DEVICE="
set "ENV_WORKER_ID="
set "ENV_WORKER_API_BASE_URL="

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%BE_DIR%\.env") do (
    if /I "%%A"=="WORKER_TOKEN" set "ENV_WORKER_TOKEN=%%B"
    if /I "%%A"=="MODEL_CHECKPOINT_PATH" set "ENV_MODEL_CHECKPOINT_PATH=%%B"
    if /I "%%A"=="MODEL_MANIFEST_PATH" set "ENV_MODEL_MANIFEST_PATH=%%B"
    if /I "%%A"=="WORKER_DEVICE" set "ENV_WORKER_DEVICE=%%B"
    if /I "%%A"=="WORKER_ID" set "ENV_WORKER_ID=%%B"
    if /I "%%A"=="WORKER_API_BASE_URL" set "ENV_WORKER_API_BASE_URL=%%B"
)

if "%ENV_WORKER_TOKEN%"=="" (
    echo [ERROR] Thieu WORKER_TOKEN trong BE\.env.
    exit /b 1
)
if not "%ENV_WORKER_TOKEN:REPLACE_WITH_=%"=="%ENV_WORKER_TOKEN%" (
    echo [ERROR] WORKER_TOKEN trong BE\.env van dang la gia tri mau.
    exit /b 1
)

if "%ENV_MODEL_CHECKPOINT_PATH%"=="" (
    echo [ERROR] Thieu MODEL_CHECKPOINT_PATH trong BE\.env.
    exit /b 1
)
if not "%ENV_MODEL_CHECKPOINT_PATH:REPLACE_WITH_=%"=="%ENV_MODEL_CHECKPOINT_PATH%" (
    echo [ERROR] MODEL_CHECKPOINT_PATH trong BE\.env van dang la gia tri mau.
    exit /b 1
)
if not exist "%ENV_MODEL_CHECKPOINT_PATH%" (
    echo [ERROR] Khong tim thay file checkpoint: "%ENV_MODEL_CHECKPOINT_PATH%"
    exit /b 1
)

if "%ENV_MODEL_MANIFEST_PATH%"=="" set "ENV_MODEL_MANIFEST_PATH=worker/manifest.json"
if "%ENV_WORKER_DEVICE%"=="" set "ENV_WORKER_DEVICE=cpu"
if "%ENV_WORKER_ID%"=="" set "ENV_WORKER_ID=local-worker-1"

if not "%ARG_WORKER_ID%"=="" set "ENV_WORKER_ID=%ARG_WORKER_ID%"
if not "%ARG_DEVICE%"=="" set "ENV_WORKER_DEVICE=%ARG_DEVICE%"

if "%ENV_WORKER_API_BASE_URL%"=="" (
    pushd "%ROOT_DIR%"
    set "API_PORT="
    for /f "tokens=2 delims=:" %%P in ('docker compose port api 8000 2^>nul') do set "API_PORT=%%P"
    popd
    if "%API_PORT%"=="" set "API_PORT=8000"
    set "ENV_WORKER_API_BASE_URL=http://127.0.0.1:%API_PORT%"
)

set "WORKER_ID=%ENV_WORKER_ID%"
set "WORKER_DEVICE=%ENV_WORKER_DEVICE%"
set "WORKER_API_BASE_URL=%ENV_WORKER_API_BASE_URL%"
set "WORKER_TOKEN=%ENV_WORKER_TOKEN%"
set "MODEL_MANIFEST_PATH=%ENV_MODEL_MANIFEST_PATH%"
set "MODEL_CHECKPOINT_PATH=%ENV_MODEL_CHECKPOINT_PATH%"

echo Worker ID  : %WORKER_ID%
echo Device     : %WORKER_DEVICE%
echo API URL    : %WORKER_API_BASE_URL%
echo Manifest   : %MODEL_MANIFEST_PATH%
echo Checkpoint : %MODEL_CHECKPOINT_PATH%
echo.

if "%CHECK_ONLY%"=="1" (
    echo [OK] Cau hinh Local AI Worker hop le.
    exit /b 0
)

cd /d "%BE_DIR%"
echo Dang khoi dong AI Worker (nhan Ctrl+C de dung)...
"%WORKER_PYTHON%" -m worker.service
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] AI Worker da dung voi ma loi %EXIT_CODE%.
    pause
)
endlocal & exit /b %EXIT_CODE%
