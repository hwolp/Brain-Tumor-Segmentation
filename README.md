# Brain Tumor Segmentation (BraTS v1)

Hệ thống trạm làm việc phân đoạn u não trên ảnh MRI đa xung (**FLAIR** + **T1ce**) sử dụng mô hình **TDA-SegUNet**, gồm Backend **FastAPI + PostgreSQL + Alembic**, Frontend **React + Vite + TypeScript**, và **AI Inference Worker** có thể chạy cục bộ hoặc tách riêng lên Cloud/GPU.

> **Trạng thái hiện tại:** Đã hoàn tất **P0–P7** cho bản phát hành **v1**: xác thực RS256/Argon2id + Refresh Token Rotation, RBAC Admin/Doctor, quản lý bệnh nhân/ca chụp & kiểm tra NIfTI, **Medical Viewer & Mask Editor** (toàn màn hình `F`, phóng đại khung, con trỏ cọ trực tiếp, cuộn chuột chuyển lát, Undo/Redo theo lát, lưu phiên bản mask bất biến + xóa mềm `deleted_at` có audit), hàng đợi AI job (`lease`/`heartbeat`/`reaper`), báo cáo in/JSON, **CI/CD GitHub Actions → GHCR → Azure VM** và **AI Worker đóng gói Docker độc lập**. Phase **P8** là backlog mở rộng sau v1.

---

## Cấu trúc thư mục chính

- `BE/` — Backend FastAPI & AI Worker:
  - `app/` — Mã nguồn API (`api/`, `core/`, `models/`, `repositories/`, `schemas/`, `services/`, `validators/`, `dependencies.py`, `main.py`).
  - `migrations/` — Alembic migrations (`0001_p1_foundation` → `0007_mask_version_soft_delete`).
  - `scripts/` — CLI vận hành & kiểm thử (`export_openapi.py`, `bootstrap_admin.py`, `backup_restore.py`, `run_p7_real_ai_smoke.py`, `run_p7_e2e_stack.py`).
  - `openapi/openapi.json` — Hợp đồng OpenAPI deterministic do FastAPI xuất.
  - `worker/` — AI inference adapter (`adapter.py`, `model.py`, `preprocess.py`, `tda.py`), verified `manifest.json` và `service.py`.
  - `Dockerfile`, `docker-entrypoint.sh`, `requirements.txt` — Image & dependencies cho Backend API.
  - `Dockerfile.worker`, `requirements-worker.txt`, `worker.env.example` — Image & dependencies tối giản chỉ cho AI Worker độc lập.
  - `tests/{unit,integration,contract,ai}` — Bộ kiểm thử Python (**`152` tests** tổng cộng: **`132` BE** (`47` unit + `78` integration + `7` contract) + **`20` AI**).
- `FE/` — Frontend React + Vite + TypeScript:
  - `src/` (`app/`, `features/`, `shared/`, `viewer-adapter/`, `test/`) & `e2e/` (`p7-acceptance.spec.ts`).
  - `Dockerfile` (dev hot-reload) và `Dockerfile.prod` + `nginx.conf` (production SPA + reverse proxy `/api/v1` & `/.well-known/jwks.json`).
- `deploy/azure/` — Cấu hình Docker Compose, script rollout [`deploy.sh`](deploy/azure/deploy.sh), mẫu biến môi trường [`azure.env.example`](deploy/azure/azure.env.example), mẫu Nginx HTTPS [`nginx.https.conf.example`](deploy/azure/nginx.https.conf.example) và tài liệu triển khai Azure VM [`deploy/azure/README.md`](deploy/azure/README.md).
- `.github/workflows/` — GitHub Actions CI ([`ci.yml`](.github/workflows/ci.yml)) và CD build/push GHCR + deploy Azure VM ([`deploy-azure.yml`](.github/workflows/deploy-azure.yml)).
- [`docker-compose.yml`](docker-compose.yml) — Stack dev full-stack gồm 3 dịch vụ (`postgres`, `api`, `frontend`).
- [`docker-compose.worker.yml`](docker-compose.worker.yml) — Stack độc lập để chạy AI Worker trên máy GPU/Cloud.
- [`start-dev.bat`](start-dev.bat) — Script khởi động nhanh trên Windows (bật Docker Compose stack + AI Worker trên host, hỗ trợ `--build` và `--no-worker`).

---

## Yêu cầu môi trường

- **Docker Desktop** (Docker Compose v2; đã kiểm thử với Docker `29.8.1`, Compose `v5.5.1`).
- **Python `>= 3.12`** (đã kiểm thử với Python `3.13.5`).
- **Node.js `22` & npm** (đã kiểm thử với Node `v22.23.2`, npm `10.9.8`).

---

## Khởi chạy nhanh (Khuyên dùng)

### Cách 1: Dùng `start-dev.bat` trên Windows

```powershell
# Khởi động Docker Compose (postgres + api + frontend) và bật AI Worker trên host
.\start-dev.bat

# Tùy chọn: rebuild image Docker trước khi chạy, hoặc bỏ qua AI Worker
.\start-dev.bat --build
.\start-dev.bat --no-worker
```

Script tự động chờ `http://127.0.0.1:8000/api/v1/health/ready` và `http://127.0.0.1:5173` sẵn sàng rồi mới khởi chạy `worker.service` (nếu `BE/.env` đã cấu hình `WORKER_TOKEN` và `MODEL_CHECKPOINT_PATH`).

### Cách 2: Chạy trực tiếp bằng Docker Compose

```powershell
# Khởi động PostgreSQL + FastAPI + Vite (tự sinh khóa JWT nếu chưa có và chạy Alembic migration)
docker compose up -d --build

# Kiểm tra trạng thái healthy của cả 3 service (postgres, api, frontend)
docker compose ps

# Xem log realtime hoặc dừng stack
docker compose logs -f
docker compose down
```

- **Bootstrap tài khoản Admin đầu tiên** (khi chạy lần đầu trên DB mới):

```powershell
docker compose exec -it api python -m scripts.bootstrap_admin --username adminops --display-name "Quản trị hệ thống"
```

- **Địa chỉ truy cập mặc định:**
  - Web UI (Vite): `http://127.0.0.1:5173`
  - FastAPI & Swagger: `http://127.0.0.1:8000` / `http://127.0.0.1:8000/docs`
  - PostgreSQL: `127.0.0.1:5432`
- **Xung đột cổng `8000` (nếu có):** Đặt `$env:API_PORT = "8001"` trước khi chạy `docker compose up -d --build`.

> **Lưu ý:** Không chạy song song Vite dev server cục bộ trên máy cùng lúc với container `frontend` (nếu Vite tự nhảy sang cổng `5174`, trình duyệt gửi `Origin: http://127.0.0.1:5174` sẽ bị FastAPI từ chối `403 csrf_origin_denied` do không khớp `ALLOWED_ORIGINS`).

---

## Cài đặt & chạy thủ công từ checkout sạch (Windows PowerShell)

### 1. Khởi động PostgreSQL

```powershell
docker compose up -d postgres
docker compose ps
```

Đợi `braintumorsegmentation-postgres-1` đạt trạng thái `healthy` trên `127.0.0.1:5432`.

### 2. Tạo môi trường Python cho Backend (`BE/.venv`)

```powershell
python -m venv BE/.venv
BE\.venv\Scripts\python.exe -m pip install --upgrade pip
BE\.venv\Scripts\python.exe -m pip install -r BE/requirements.txt
```

> **Tách biệt môi trường API vs AI Worker:** [`BE/requirements.txt`](BE/requirements.txt) chỉ chứa các gói cho FastAPI, PostgreSQL/Alembic, NIfTI validation và test BE. AI Worker (`BE/worker/`, `BE/tests/ai/`) dùng [`BE/requirements-worker.txt`](BE/requirements-worker.txt) kèm `torch==2.8.0` ở môi trường Python riêng (trên máy dev hiện tại là `D:\Nam4\Ky1\PBL6\.venv`) hoặc chạy trong container [`BE/Dockerfile.worker`](BE/Dockerfile.worker).

### 3. Cấu hình biến môi trường (`.env`)

Sao chép các tệp mẫu (không commit `.env`, `worker.env` hoặc secrets lên Git):

```powershell
Copy-Item BE/.env.example BE/.env
Copy-Item FE/.env.example FE/.env
```

Cấu hình mẫu cho `BE/.env` chạy local:

```dotenv
APP_ENV=local
SERVICE_NAME=brain-tumor-api
LOG_LEVEL=INFO

DATABASE_URL=postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev
STORAGE_ROOT=./storage

PUBLIC_ORIGIN=http://127.0.0.1:5173
ALLOWED_ORIGINS=["http://127.0.0.1:5173","http://localhost:5173"]
COOKIE_SECURE=false

JWT_PRIVATE_KEY_PATH=./secrets/jwt-private.pem
JWT_PUBLIC_KEY_PATH=./secrets/jwt-public.pem
JWT_KEY_ID=local-rs256-v1
JWT_ISSUER=brain-tumor-api
JWT_AUDIENCE=brain-tumor-web

MODEL_MANIFEST_PATH=./worker/manifest.json
MODEL_CHECKPOINT_PATH=<path-to-best.pt>
WORKER_API_BASE_URL=http://127.0.0.1:8000
WORKER_TOKEN=<same-secret-worker-token>
WORKER_DEVICE=cpu
```

Cấu hình `FE/.env`:

```dotenv
VITE_API_PROXY_TARGET=http://127.0.0.1:8000
VITE_USE_FIXTURES=false
```

> **`BE/app/core/config.py`** đọc `.env` theo thư mục làm việc hiện tại, vì vậy hãy chạy `uvicorn` / `alembic` từ bên trong `BE/` hoặc truyền `$env:DATABASE_URL`. **`FE/vite.config.ts`** ưu tiên biến môi trường shell `VITE_API_PROXY_TARGET` nếu có, sau đó mới tới `FE/.env` và mặc định `http://127.0.0.1:8000`.

### 4. Chạy Alembic migration & khởi tạo JWT / Admin

```powershell
Push-Location BE
.\.venv\Scripts\python.exe -m alembic -c alembic.ini upgrade head
.\.venv\Scripts\python.exe -m alembic -c alembic.ini current
.\.venv\Scripts\python.exe -m alembic -c alembic.ini check
Pop-Location
```

Kết quả mong đợi: `0007_mask_version_soft_delete (head)`.

Khởi tạo cặp khóa RSA-2048 JWT và tài khoản admin đầu tiên (chạy từ `BE/`):

```powershell
Push-Location BE
.\.venv\Scripts\python.exe -m scripts.bootstrap_admin --init-jwt-keys
.\.venv\Scripts\python.exe -m scripts.bootstrap_admin --username adminops --display-name "Quản trị hệ thống"
# Đặt lại mật khẩu admin khi cần:
# .\.venv\Scripts\python.exe -m scripts.bootstrap_admin --username adminops --reset
Pop-Location
```

> `scripts.bootstrap_admin` dùng `getpass.getpass()` để ẩn mật khẩu 12–128 ký tự trên terminal tương tác (`--password` không được hỗ trợ).

### 5. Cài đặt Frontend & kiểm tra OpenAPI types

```powershell
Push-Location FE
npm ci
Pop-Location

# Kiểm tra OpenAPI artifact khớp FastAPI hiện tại
$env:PYTHONPATH = "BE"
BE\.venv\Scripts\python.exe -m scripts.export_openapi --check

# Sinh lại FE/src/shared/api/schema.d.ts khi BE đổi contract
Push-Location FE
npm run generate:types
Pop-Location
```

### 6. Chạy dev server BE + FE thủ công

```powershell
# Terminal 1 (Backend FastAPI)
cd BE
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Terminal 2 (Frontend Vite)
cd FE
npm run dev -- --host 127.0.0.1 --port 5173
```

Kiểm tra nhanh:
- `http://127.0.0.1:5173/api/v1/health/live` → `200 OK`
- `http://127.0.0.1:5173/api/v1/health/ready` → `200 OK`
- `http://127.0.0.1:8000/.well-known/jwks.json` → `200 OK`

---

## Khởi chạy AI Inference Worker (Host / Docker / Cloud GPU)

[`BE/worker/service.py`](BE/worker/service.py) hoạt động theo cơ chế **Pull-based qua HTTP** (`/api/v1/internal/*`), không kết nối trực tiếp PostgreSQL hay ổ đĩa Backend nên có thể chạy trên máy host, container riêng hoặc Cloud GPU/Colab.

| Biến môi trường | Ý nghĩa | Giá trị mặc định / gợi ý |
|---|---|---|
| `WORKER_API_BASE_URL` | Địa chỉ gốc của Backend FastAPI | `http://127.0.0.1:8000` (hoặc `https://...` trên Cloud) |
| `WORKER_TOKEN` | Secret token khớp `WORKER_TOKEN` của Backend | Bắt buộc, không được rỗng |
| `WORKER_ID` | Định danh tiến trình worker hiển thị ở Admin | `local-worker-1` / `cloud-worker-1` |
| `WORKER_DEVICE` | `auto` (ưu tiên `cuda` nếu có), `cpu`, `cuda`, `cuda:0` | `cpu` (`auto` trong Docker) |
| `WORKER_POLL_INTERVAL_SECONDS` | Chu kỳ poll job mới (tối thiểu `1` giây) | `5` |
| `MODEL_MANIFEST_PATH` | Đường dẫn manifest model đã verify | `worker/manifest.json` |
| `MODEL_CHECKPOINT_PATH` | Đường dẫn file trọng số `best.pt` ngoài Git | `/models/best.pt` hoặc đường dẫn local |

### Cách A: Chạy trực tiếp trên máy host

```powershell
Push-Location BE
$env:WORKER_PYTHON = "D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe"
$env:WORKER_API_BASE_URL = "http://127.0.0.1:8000"
$env:WORKER_TOKEN = "<same-worker-token-as-BE-.env>"
$env:WORKER_ID = "local-worker-1"
$env:MODEL_MANIFEST_PATH = "worker/manifest.json"
$env:MODEL_CHECKPOINT_PATH = "<path-to-best.pt>"
$env:WORKER_DEVICE = "auto"
& $env:WORKER_PYTHON -m worker.service
Pop-Location
```

### Cách B: Chạy độc lập bằng Docker ([`docker-compose.worker.yml`](docker-compose.worker.yml))

```powershell
Copy-Item BE/worker.env.example BE/worker.env
# Chỉnh WORKER_API_BASE_URL, WORKER_TOKEN và gắn checkpoint vào ./models/best.pt (hoặc HOST_MODEL_CHECKPOINT_PATH)

# Bản CUDA 12.4 mặc định (mở comment khối GPU trong docker-compose.worker.yml nếu máy có NVIDIA Container Toolkit):
docker compose -f docker-compose.worker.yml up -d --build

# Hoặc build bản CPU nhẹ hơn:
$env:TORCH_INDEX_URL = "https://download.pytorch.org/whl/cpu"
docker compose -f docker-compose.worker.yml up -d --build
```

### Cách C: Chạy on-demand trên Cloud GPU / Google Colab / Máy Lab

```bash
cd BE
pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements-worker.txt

export WORKER_API_BASE_URL="https://api.your-domain.com"
export WORKER_TOKEN="<token-khop-voi-backend>"
export WORKER_ID="cloud-gpu-worker-1"
export WORKER_DEVICE="auto"
export MODEL_MANIFEST_PATH="worker/manifest.json"
export MODEL_CHECKPOINT_PATH="/path/to/best.pt"

python -m worker.service
```

> Phần forward mạng `TDASegUNet` (~1.94M tham số) tận dụng GPU khi `WORKER_DEVICE=auto`/`cuda`, còn bước tính TDA (`gudhi.CubicalComplex`) chạy trên CPU. Nếu đặt `WORKER_DEVICE=cuda` khi máy không có CUDA, worker sẽ báo lỗi rõ thay vì fallback ngầm sang CPU.

---

## Build Production & Triển khai Azure VM (GitHub CI/CD)

Hệ thống tách thành các production image độc lập:

| Thành phần | Dockerfile | Ghi chú |
|---|---|---|
| Backend API | [`BE/Dockerfile`](BE/Dockerfile) | FastAPI + Uvicorn + [`BE/docker-entrypoint.sh`](BE/docker-entrypoint.sh) (auto migrate & init JWT keys) |
| Frontend Web | [`FE/Dockerfile.prod`](FE/Dockerfile.prod) | Multi-stage Vite build (`VITE_USE_FIXTURES=false`) + Nginx [`FE/nginx.conf`](FE/nginx.conf) |
| AI Worker | [`BE/Dockerfile.worker`](BE/Dockerfile.worker) | Non-root user `worker`, chỉ chứa `BE/worker/`, tách khỏi API/secrets |

- **CI Pipeline** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): Chạy trên PR vào `master`/`main` (`ruff`, `export_openapi --check`, `alembic upgrade head && alembic check`, `132` BE tests, FE `typecheck`/`vitest`/`build`, validate `deploy/azure` & build thử `BE/Dockerfile`, `FE/Dockerfile.prod`).
- **CD Pipeline** ([`.github/workflows/deploy-azure.yml`](.github/workflows/deploy-azure.yml)): Chạy khi push `master`/`main`, đẩy image lên GHCR và SSH triển khai lên Azure Linux VM. Xem chi tiết tại [`deploy/azure/README.md`](deploy/azure/README.md).

---

## Sao lưu, Phục hồi cô lập & Khôi phục sự cố

### 1. Bật Maintenance Mode trước khi backup

1. Đăng nhập Admin tại `/admin/settings` (hoặc `PATCH /api/v1/admin/settings`).
2. Tắt **"Nhận job AI mới"** (`accepting_jobs = false`) và lưu (job mới nhận `503 not_accepting_jobs`, job đang chạy vẫn hoàn tất).
3. Đợi các job `running` kết thúc tại `/admin/jobs`.

### 2. Backup DB + Private Storage (`backup`)

```powershell
$env:PYTHONPATH = "BE"
BE\.venv\Scripts\python.exe -m scripts.backup_restore backup `
  --database-url "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev" `
  --storage-root "BE/storage" `
  --output-dir "backups/snapshot-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
```

### 3. Restore vào DB cô lập & Verify (`restore --create-db` + `verify`)

```powershell
$env:PYTHONPATH = "BE"
BE\.venv\Scripts\python.exe -m scripts.backup_restore restore `
  --backup-dir "backups/<snapshot-dir>" `
  --target-database-url "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_restore_verify" `
  --target-storage-root "backups/restored_storage_verify" `
  --create-db

BE\.venv\Scripts\python.exe -m scripts.backup_restore verify `
  --database-url "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_restore_verify" `
  --storage-root "backups/restored_storage_verify"
```

> `scripts.backup_restore` chặn ghi đè lên DB sống (`bts_dev`, `postgres`, `*_dev`, `*_prod`) và tự động thu hồi toàn bộ phiên đăng nhập trước thời điểm backup (`revoke_reason="backup_restore"`).

### 4. Khôi phục sự cố Worker Crash

- Mỗi job attempt giữ lease **90 giây** (`LEASE_SECONDS = 90`, worker gia hạn mỗi 15 giây). Nếu worker mất kết nối quá 90 giây, background reaper trong `BE/app/main.py` thu hồi attempt (`expired`) và tự retry tối đa 1 lần; quá ngưỡng này job chuyển `failed` (`worker_lost`) để Admin bấm **Gửi lại** tại `/admin/jobs`.

---

## Chạy bộ kiểm thử & kiểm tra chất lượng

### Backend & OpenAPI (`BE/.venv`, yêu cầu PostgreSQL đang chạy)

```powershell
# 132 tests BE (47 unit + 78 integration + 7 contract)
BE\.venv\Scripts\python.exe -m pytest BE/tests/unit BE/tests/integration BE/tests/contract -v

# Lint Python
BE\.venv\Scripts\ruff.exe check BE/app BE/scripts BE/migrations BE/worker/service.py BE/tests/conftest.py BE/tests/unit BE/tests/integration BE/tests/contract BE/tests/ai/test_p7_real_worker_e2e.py BE/tests/ai/test_worker_service.py

# Kiểm tra OpenAPI deterministic artifact
$env:PYTHONPATH = "BE"
BE\.venv\Scripts\python.exe -m scripts.export_openapi --check
```

### AI Adapter & Worker (`$env:WORKER_PYTHON`, `20` tests)

```powershell
$env:WORKER_PYTHON = "D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe"

# 20 tests AI (adapter P0, worker service, real 155-slice worker HTTP/PostgreSQL E2E)
& $env:WORKER_PYTHON -m pytest BE/tests/ai -v

# Smoke E2E thật 155 lát + CPU benchmark qua FastAPI + PostgreSQL cô lập (bts_ai_smoke_test)
& $env:WORKER_PYTHON BE/scripts/run_p7_real_ai_smoke.py --case-dir "<path-to-BraTS20_Training_001>" --checkpoint "<path-to-best.pt>"

# Benchmark adapter thuần 155 lát (P0)
& $env:WORKER_PYTHON BE/worker/verify_p0.py --case-dir "<path-to-BraTS20_Training_001>" --checkpoint "<path-to-best.pt>"
```

### Frontend (`10` files / `93` Vitest tests · `4` Playwright E2E tests)

```powershell
cd FE
npm run typecheck
npm test -- --run
npm run build

# E2E Desktop Google Chrome trên live FastAPI + PostgreSQL (bts_e2e_test) + Vite proxy
npm run test:e2e
```

---

## Quy tắc bảo mật dữ liệu & repository

- Không commit `.env`, `BE/worker.env`, private keys (`*.pem`, `*.key`), `node_modules/`, `storage/`, model weights (`*.pt`, `*.pth`, `*.onnx`), hoặc tệp MRI/mask bệnh nhân (`*.nii`, `*.nii.gz`).
- Trên Frontend, `VITE_USE_FIXTURES=true` chỉ dùng để phát triển UI cục bộ không có Backend; luôn tắt (`false`) khi build production hoặc kiểm thử ghép nối thật.
