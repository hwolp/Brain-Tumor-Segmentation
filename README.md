# Brain Tumor Segmentation (BraTS v1)

Hệ thống trạm làm việc phân đoạn u não trên ảnh MRI đa xung (**FLAIR** + **T1ce**) sử dụng mô hình **TDA-SegUNet**, gồm Backend **FastAPI + PostgreSQL + Alembic**, Frontend **React + Vite + TypeScript + NiiVue**, và AI inference adapter/worker.

> **Trạng thái hiện tại:** Đã hoàn tất và nghiệm thu đầy đủ cho bản phát hành cục bộ **v1** từ **P0–P7**: **P0 (AI adapter & manifest)**, **P1 (Foundation: FastAPI health/error/logging/storage, PostgreSQL + Alembic, React/Vite shell + proxy, OpenAPI → TypeScript types)**, **P2 (Authentication RS256/Argon2id/Refresh Rotation, RBAC Admin/Doctor, Quản lý tài khoản bác sĩ, Session Coordination đa tab)**, **P3 (Quản lý bệnh nhân theo owner, Tạo ca chụp Idempotent, Upload & Kiểm tra NIfTI FLAIR/T1ce, Quota & Phân quyền file)**, **P4 (Viewer 3 bố cục, Brush/Erase trục Axial, Undo/Redo theo lát, Lưu phiên bản mask bất biến có Idempotency-Key & kiểm soát xung đột 409, thống kê thể tích vật lý & xuất `.nii.gz`)**, **P5 (Model Registry, Hàng đợi Inference Job, Worker Lease/Heartbeat/Reaper & Công bố AI Mask bất biến)**, **P6 (Admin Operations Dashboard, Retry Job, Cấu hình Optimistic Lock, Audit Kỹ thuật không PII & Bản in Báo cáo theo phiên bản)** và **P7 (Nghiệm thu E2E toàn hệ thống, Bảo mật/Concurrency, Backup/Restore cô lập, Benchmark Real AI 155 lát & Tài liệu bàn giao)**. Phase **P8** là backlog mở rộng sau v1.

---

## Cấu trúc thư mục chính

- `BE/` — Backend FastAPI:
  - `app/` — Mã nguồn ứng dụng (`api/`, `core/`, `models/`, `repositories/`, `schemas/`, `services/`, `dependencies.py`, `main.py`).
  - `scripts/` — CLI vận hành & kiểm thử (`export_openapi.py`, `bootstrap_admin.py`, `backup_restore.py`, `run_p7_real_ai_smoke.py`, `run_p7_e2e_stack.py`).
  - `migrations/` — Alembic migrations (`0001_p1_foundation`, `0002_p2_auth_and_accounts`, `0003_p3_patients_cases_volumes`, `0004_p4_mask_versions`, `0005_p5_inference_jobs`, `0006_p6_admin_settings`).
  - `openapi/openapi.json` — Hợp đồng OpenAPI deterministic do FastAPI xuất.
  - `worker/` — AI inference adapter, verified manifest (`P0`) & single-process worker service (`P5`).
  - `tests/{unit,integration,contract,ai}` — Bộ kiểm thử Python (**`121` tests** tổng cộng: **`108` BE** (`35` unit + `66` integration + `7` contract) + **`13` AI**).
- `FE/` — Frontend React + Vite + TypeScript (`src/app`, `src/features`, `src/shared`, `src/viewer-adapter`, `src/test`).
- `docker-compose.yml` — Stack Docker Compose gồm 3 dịch vụ (`postgres`, `api`, `frontend`) chạy trong 1 stack `braintumorsegmentation` trên Docker Desktop.
- `start-dev.bat` — Script khởi chạy dev cục bộ trên Windows (PostgreSQL Docker + BE/FE/Worker trên host).

---

## Yêu cầu môi trường

- **Docker Desktop** (kèm Docker Compose v2; đã kiểm thử với Docker `29.8.1`, Compose `v5.5.1`).
- **Python `>= 3.12`** (đã kiểm thử với Python `3.13.5`).
- **Node.js & npm** (đã kiểm thử với Node `v22.23.2`, npm `10.9.8`).

---

## Khởi chạy nhanh toàn bộ stack bằng Docker Compose (PostgreSQL + BE + FE)

Nếu muốn chạy **PostgreSQL + Backend FastAPI + Frontend Vite** cùng lúc và quản lý gọn trong **1 stack** `braintumorsegmentation` trên Docker Desktop (có hỗ trợ hot-reload code BE/FE qua bind mount):

```powershell
# Khởi động toàn bộ stack (tự sinh khóa JWT nếu chưa có và chạy Alembic migration)
docker compose up -d --build

# Kiểm tra trạng thái healthy của cả 3 service (postgres, api, frontend)
docker compose ps

# Xem log realtime (hoặc dừng toàn bộ stack)
docker compose logs -f
docker compose down
```

- **Bootstrap tài khoản Admin đầu tiên** (khi chạy lần đầu trên DB mới):

```powershell
docker compose exec -it api python -m scripts.bootstrap_admin --username adminops --display-name "Quản trị hệ thống"
```

- **Xung đột cổng `8000` (nếu có):** Đặt `$env:API_PORT = "8001"` trước khi chạy `docker compose up -d --build`.
- **AI Worker:** Vẫn chạy trên host bằng môi trường Python AI (`$env:WORKER_PYTHON`) và trỏ `WORKER_API_BASE_URL=http://127.0.0.1:8000` (hoặc cổng `API_PORT` đã chọn).

---

## Hướng dẫn chạy cục bộ từ checkout sạch (Windows PowerShell)

### 1. Khởi động PostgreSQL bằng Docker Compose

Từ thư mục gốc repository:

```powershell
docker compose up -d postgres
docker compose ps
```

Đợi container `braintumorsegmentation-postgres-1` chuyển sang trạng thái `Up ... (healthy)` trên `127.0.0.1:5432`.

---

### 2. Tạo môi trường Python cho Backend (`BE/.venv`)

Tạo virtualenv và cài đặt các dependency cố định của Backend API:

```powershell
python -m venv BE/.venv
BE\.venv\Scripts\python.exe -m pip install --upgrade pip
BE\.venv\Scripts\python.exe -m pip install -r BE/requirements.txt
```

> **Lưu ý tách biệt môi trường API vs AI Worker:**  
> `BE/requirements.txt` chỉ khai báo các gói phục vụ FastAPI, PostgreSQL/Alembic, NIfTI validation và kiểm thử BE (`fastapi`, `uvicorn`, `sqlalchemy`, `alembic`, `psycopg[binary]`, `nibabel`, `numpy`, `scikit-image`, `pytest`, `ruff`, ...).  
> AI adapter/worker (`BE/worker/`, `BE/tests/ai/`) yêu cầu thêm bộ gói AI đã khóa trong `BE/worker/manifest.json` (`dependencies`: `torch==2.8.0`, `numpy==2.2.6`, `scipy==1.16.1`, `nibabel==5.4.2`, `gudhi==3.13.0`, `scikit-image==0.26.0`, `pandas==2.3.1`, `psutil==7.0.0`), chạy trên Python environment riêng cho worker (trên máy phát triển hiện tại là `D:\Nam4\Ky1\PBL6\.venv`). Riêng `pytest==9.0.3` là gói phục vụ chạy test (`BE/tests/ai/`), **không** nằm trong `manifest.json["dependencies"]`.

---

### 3. Cấu hình biến môi trường (`.env`)

Sao chép các tệp mẫu (tuyệt đối không commit `.env` hoặc secrets thật lên Git):

```powershell
Copy-Item BE/.env.example BE/.env
Copy-Item FE/.env.example FE/.env
```

> **Lưu ý về `BE/.env.example`:** File mẫu chỉ chứa placeholder an toàn (`REPLACE_WITH_LOCAL_DB_PASSWORD`, `REPLACE_WITH_WORKER_SERVICE_TOKEN`, đường dẫn mẫu `./secrets/...` và `./models/...` nằm ngoài Git). Khi sao chép sang `BE/.env`, hãy chỉnh lại cho môi trường dev cục bộ khớp với `docker-compose.yml` và trỏ `MODEL_MANIFEST_PATH` / `MODEL_CHECKPOINT_PATH` tới model thực tế (tuyệt đối không commit `.env` hay khóa thật):

```dotenv
APP_ENV=local
SERVICE_NAME=brain-tumor-api
LOG_LEVEL=INFO

DATABASE_URL=postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev
STORAGE_ROOT=./storage

PUBLIC_ORIGIN=http://127.0.0.1:5173
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

Kiểm tra `FE/.env`:

```dotenv
VITE_API_PROXY_TARGET=http://127.0.0.1:8000
VITE_USE_FIXTURES=false
```

> **Lưu ý cấu hình Vite proxy (`FE/vite.config.ts`):** `vite.config.ts` sử dụng `loadEnv(mode, __dirname, 'VITE_')` để nạp các biến tiền tố `VITE_` từ `FE/.env` (nếu biến môi trường shell `process.env.VITE_API_PROXY_TARGET` đang được đặt thì giá trị shell sẽ được ưu tiên ghi đè `FE/.env`, ngược lại sẽ dùng giá trị trong `FE/.env` rồi mới tới mặc định `http://127.0.0.1:8000`). Do đó có thể đổi `VITE_API_PROXY_TARGET` (ví dụ `VITE_API_PROXY_TARGET=http://127.0.0.1:8001`) trực tiếp trong `FE/.env` (khi shell không đặt biến này) hoặc qua biến môi trường shell.

> **Lưu ý quan trọng về `BE/.env`:** `Settings` (`BE/app/core/config.py`) đọc `.env` từ thư mục làm việc hiện tại (`env_file=".env"`). Vì vậy, hãy chạy `uvicorn` (và `alembic` khi không truyền `$env:DATABASE_URL`) từ bên trong thư mục `BE/`, hoặc truyền trực tiếp biến môi trường `$env:DATABASE_URL` ở shell.

---

### 4. Chạy Alembic migration trên PostgreSQL

Cách 1 — Chạy từ thư mục `BE/` (tự đọc `BE/.env`):

```powershell
Push-Location BE
.\.venv\Scripts\python.exe -m alembic -c alembic.ini upgrade head
.\.venv\Scripts\python.exe -m alembic -c alembic.ini current
Pop-Location
```

Cách 2 — Chạy từ thư mục gốc repository với biến môi trường `DATABASE_URL`:

```powershell
$env:DATABASE_URL = "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"
BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini upgrade head
BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini current
```

Kết quả mong đợi: `0006_p6_admin_settings (head)`. Có thể xác minh thêm schema ORM khớp migration bằng:

```powershell
$env:DATABASE_URL = "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"
BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini check
```

---

### 4.5. Khởi tạo cặp khóa RSA-2048 JWT và tài khoản Admin đầu tiên

Không có mật khẩu admin mặc định hay seed password trong mã nguồn. Sinh cặp khóa RSA-2048 và tạo tài khoản admin qua CLI tương tác `scripts.bootstrap_admin` (chạy từ thư mục `BE/` để đọc `BE/.env`, hoặc truyền `PYTHONPATH=BE` + biến môi trường):

```powershell
Push-Location BE

# 1. Sinh cặp khóa RSA 2048-bit vào JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH (mặc định ./secrets/)
.\.venv\Scripts\python.exe -m scripts.bootstrap_admin --init-jwt-keys

# 2. Tạo tài khoản admin tương tác (getpass ẩn mật khẩu 12–128 ký tự trên terminal)
.\.venv\Scripts\python.exe -m scripts.bootstrap_admin --username adminops --display-name "Quản trị hệ thống"

# (Tùy chọn) Đặt lại mật khẩu admin nếu cần khôi phục qua CLI (thu hồi mọi phiên cũ & ghi audit)
# .\.venv\Scripts\python.exe -m scripts.bootstrap_admin --username adminops --reset

Pop-Location
```

> **Lưu ý trên Windows:** `scripts.bootstrap_admin` dùng `getpass.getpass()` để ẩn mật khẩu khi nhập trực tiếp trên terminal tương tác (TTY); không truyền mật khẩu qua tham số dòng lệnh (`--password` không được hỗ trợ).

---

### 5. Cài đặt Frontend & đồng bộ kiểu TypeScript từ OpenAPI

Cài package cho Frontend:

```powershell
Push-Location FE
npm ci
Pop-Location
```

Kiểm tra/xuất lại `BE/openapi/openapi.json` từ FastAPI và sinh `FE/src/shared/api/schema.d.ts`:

```powershell
# Kiểm tra schema OpenAPI đã commit khớp code FastAPI hiện tại (từ gốc repo)
$env:PYTHONPATH = "BE"
BE\.venv\Scripts\python.exe -m scripts.export_openapi --check

# Hoặc chạy trực tiếp từ thư mục BE/:
# Push-Location BE; .\.venv\Scripts\python.exe -m scripts.export_openapi --check; Pop-Location

# (Nếu BE có endpoint/schema mới) xuất lại BE/openapi/openapi.json:
# BE\.venv\Scripts\python.exe -m scripts.export_openapi

# Sinh lại FE/src/shared/api/schema.d.ts từ BE/openapi/openapi.json
Push-Location FE
npm run generate:types
Pop-Location
```

---

### 6. Khởi động Backend và Frontend ở chế độ dev (qua Vite proxy)

Mở **Terminal 1** (Backend FastAPI):

```powershell
cd BE
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Mở **Terminal 2** (Frontend Vite):

```powershell
cd FE
npm run dev -- --host 127.0.0.1 --port 5173
```

Kiểm tra ghép nối qua Vite proxy:
- Giao diện web: `http://127.0.0.1:5173`
- Liveness qua proxy: `http://127.0.0.1:5173/api/v1/health/live` → `200 OK` (`{"status":"ok","service":"brain-tumor-api","environment":"local"}`)
- Readiness qua proxy: `http://127.0.0.1:5173/api/v1/health/ready` → `200 OK` (`{"status":"ready","checks":{"database":"ok","storage":"ok"}}`)
- JWKS public key (trực tiếp trên Backend): `http://127.0.0.1:8000/.well-known/jwks.json` → `200 OK` (`{"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"..."}]}`)
- Đăng nhập `/login` bằng tài khoản admin vừa bootstrap và quản lý tài khoản bác sĩ tại `/admin/users`.

> **Xử lý xung đột cổng (nếu có):** Nếu cổng `8000` trên máy đang bị dịch vụ/container khác chiếm, hãy chạy `uvicorn` ở cổng khác (ví dụ `--port 8001`). Do `FE/vite.config.ts` dùng `loadEnv`, bạn có thể đổi `VITE_API_PROXY_TARGET=http://127.0.0.1:8001` trong tệp `FE/.env` hoặc đặt biến môi trường `$env:VITE_API_PROXY_TARGET="http://127.0.0.1:8001"` trong Terminal 2 trước khi chạy `npm run dev`.

---

### 7. Khởi động AI Inference Worker (`BE/worker/service.py`)

Worker chạy một tiến trình riêng dùng môi trường Python AI (`$env:WORKER_PYTHON`, ví dụ `D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe`), nạp model `TDASegUNet` một lần lúc khởi động và giao tiếp với Backend qua internal API (`/api/v1/internal/*`).

Các biến môi trường chính đọc bởi `BE/worker/service.py`:

| Biến môi trường | Ý nghĩa | Giá trị gợi ý cục bộ |
|---|---|---|
| `WORKER_API_BASE_URL` | Địa chỉ gốc của Backend FastAPI | `http://127.0.0.1:8000` |
| `WORKER_TOKEN` | Secret token nội bộ (phải khớp `WORKER_TOKEN` trong `BE/.env`, không được rỗng) | `<shared-worker-token>` |
| `WORKER_ID` | Định danh duy nhất của tiến trình worker | `local-worker-1` |
| `MODEL_MANIFEST_PATH` | Đường dẫn tới manifest model đã xác minh | `worker/manifest.json` (khi chạy từ `BE/`) |
| `MODEL_CHECKPOINT_PATH` | Đường dẫn tới tệp weights `best.pt` ngoài repo | `<path-to-best.pt>` |
| `WORKER_DEVICE` | Thiết bị suy luận (`cpu` hoặc `cuda` nếu có PyTorch CUDA) | `cpu` |

Mở **Terminal 3** (chạy từ thư mục `BE/` hoặc đặt `$env:PYTHONPATH = "BE"`):

```powershell
Push-Location BE

$env:WORKER_PYTHON = "D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe"  # hoặc đường dẫn python.exe của worker env
$env:WORKER_API_BASE_URL = "http://127.0.0.1:8000"
$env:WORKER_TOKEN = "<same-worker-token-as-BE-.env>"
$env:WORKER_ID = "local-worker-1"
$env:MODEL_MANIFEST_PATH = "worker/manifest.json"
$env:MODEL_CHECKPOINT_PATH = "<path-to-best.pt>"
$env:WORKER_DEVICE = "cpu"

& $env:WORKER_PYTHON -m worker.service

Pop-Location
```

> **Kiểm tra trạng thái worker:** Sau khi khởi động, worker gửi heartbeat định kỳ; có thể xác minh `worker_online: true` qua `GET http://127.0.0.1:8000/api/v1/system/availability` hoặc tại trang quản trị `/admin/overview`. Lưu ý nếu đặt `WORKER_DEVICE=cuda` trên máy không có PyTorch CUDA, worker sẽ từ chối chạy thay vì tự fallback âm thầm sang CPU.

---

### 8. Sao lưu, Phục hồi cô lập & Khôi phục sự cố (Backup / Restore / Recovery Runbook)

#### 8.1. Chuyển hệ thống sang chế độ bảo trì (`Maintenance Mode`) trước khi backup

1. Đăng nhập tài khoản Admin, mở `/admin/settings` (hoặc gọi `PATCH /api/v1/admin/settings` với `version` hiện tại).
2. Tắt tùy chọn **"Nhận job AI mới"** (`accepting_jobs = false`) và lưu lại. Các job mới từ bác sĩ sẽ bị chặn tạm thời (`503 not_accepting_jobs`), trong khi job đang `running` vẫn hoàn tất bình thường.
3. Đợi toàn bộ job ở trạng thái `running` hoàn tất (theo dõi tại `/admin/jobs`) trước khi chụp snapshot.

#### 8.2. Tạo bản sao lưu nhất quán DB + Private Storage (`backup`)

Chạy từ thư mục gốc repository (thư mục `backups/` đã được cấu hình trong `.gitignore`):

```powershell
$env:PYTHONPATH = "BE"
BE\.venv\Scripts\python.exe -m scripts.backup_restore backup `
  --database-url "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev" `
  --storage-root "BE/storage" `
  --output-dir "backups/snapshot-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
```

- Mặc định `--docker-container` là `braintumorsegmentation-postgres-1` (nếu `pg_dump` chưa cài trên PATH Windows, script tự động thực thi qua `docker exec`).
- Script từ chối chạy nếu còn job `running` (trừ khi truyền `--force`), sao chép và kiểm tra SHA-256 mọi object ở trạng thái `committed`, bỏ qua tệp tạm `staging/`, và ghi `backup_manifest.json` không chứa PII bệnh nhân.

#### 8.3. Phục hồi vào môi trường cô lập & Xác minh toàn vẹn (`restore --create-db` + `verify`)

```powershell
$env:PYTHONPATH = "BE"

# 1. Phục hồi vào DB cô lập mới + thư mục storage đích
BE\.venv\Scripts\python.exe -m scripts.backup_restore restore `
  --backup-dir "backups/<snapshot-dir>" `
  --target-database-url "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_restore_verify" `
  --target-storage-root "backups/restored_storage_verify" `
  --create-db

# 2. (Tùy chọn) Chạy kiểm tra chỉ-đọc độc lập giữa DB và disk objects
BE\.venv\Scripts\python.exe -m scripts.backup_restore verify `
  --database-url "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_restore_verify" `
  --storage-root "backups/restored_storage_verify"
```

> **Cơ chế bảo vệ bắt buộc của `scripts.backup_restore`:**
> - **Chặn ghi đè DB sống:** Lệnh `restore` từ chối ngay nếu tên DB đích thuộc danh sách bảo vệ (`bts_dev`, `postgres`, hoặc kết thúc bằng `_dev` / `_prod`).
> - **Thu hồi phiên tự động sau restore:** Toàn bộ `sessions` và `refresh_tokens` còn hiệu lực trước thời điểm backup được đánh dấu thu hồi (`revoke_reason="backup_restore"`); mọi người dùng trên môi trường phục hồi phải đăng nhập lại.

Sau khi xác minh xong (hoặc sau khi bảo trì), bật lại **"Nhận job AI mới"** (`accepting_jobs = true`) tại `/admin/settings`.

#### 8.4. Khôi phục sự cố Worker Crash & Quên mật khẩu Admin

- **Worker crash hoặc mất kết nối giữa chừng:** Mỗi job attempt giữ lease **90 giây** (`LEASE_SECONDS = 90`, worker gia hạn mỗi 15 giây). Khi worker ngưng heartbeat quá 90 giây, background reaper trong `BE/app/main.py` tự động thu hồi attempt quá hạn (`state = "expired"`) và đưa job về hàng đợi tối đa **1 lần tự động** (`max_auto_retries = 1`). Worker cũ quay lại gửi kết quả muộn sẽ bị từ chối với `409 stale_attempt`. Nếu quá ngưỡng retry tự động, job chuyển `failed` (`worker_lost`); Admin kiểm tra lại worker rồi bấm **Gửi lại** tại `/admin/jobs` (`POST /api/v1/admin/jobs/{job_id}/retry`).
- **Khôi phục mật khẩu Admin qua CLI:** Chạy lệnh tương tác từ thư mục `BE/` (tự động thu hồi mọi phiên cũ của admin đó và ghi sự kiện `system.reset_admin` vào `audit_events`):

```powershell
Push-Location BE
.\.venv\Scripts\python.exe -m scripts.bootstrap_admin --username adminops --reset
Pop-Location
```

---

## Chạy bộ kiểm thử & kiểm tra chất lượng

### Backend & AI (yêu cầu PostgreSQL đang chạy; integration test dùng DB cô lập `bts_test`)

```powershell
# Bộ kiểm thử Backend từ gốc repo (108 tests: 35 unit + 66 integration + 7 contract; chạy bằng BE/.venv):
BE\.venv\Scripts\python.exe -m pytest BE/tests/unit BE/tests/integration BE/tests/contract -v

# Hoặc chạy bộ kiểm thử Backend từ bên trong thư mục BE/:
Push-Location BE
.\.venv\Scripts\python.exe -m pytest tests/unit tests/integration tests/contract -v
Pop-Location

# Lưu ý: Do Backend API và AI worker dùng 2 môi trường Python tách biệt, lệnh trên chạy 108 tests BE còn 13 tests AI (12 P0 + 1 P7 real worker E2E) được chạy riêng qua $env:WORKER_PYTHON (`BE/tests/ai`), tổng cộng 121 Python tests.

# Lint Python (BE app, scripts, migrations, worker service, test suite BE + P7 AI E2E)
BE\.venv\Scripts\ruff.exe check BE/app BE/scripts BE/migrations BE/worker/service.py BE/tests/conftest.py BE/tests/unit BE/tests/integration BE/tests/contract BE/tests/ai/test_p7_real_worker_e2e.py

# Kiểm tra OpenAPI deterministic artifact
$env:PYTHONPATH = "BE"
BE\.venv\Scripts\python.exe -m scripts.export_openapi --check
```

### AI Adapter, Real Worker E2E & Real AI Smoke Benchmark (P0 / P7)

Chạy bằng môi trường Python dành cho worker có đầy đủ `torch`, `gudhi`, `scipy`, `nibabel`, `scikit-image`, `psutil` (và `pytest` khi chạy test; tạo tách riêng ngoài `BE/.venv` hoặc trỏ tới venv PyTorch/CUDA có sẵn trên máy qua biến `$env:WORKER_PYTHON`):

```powershell
$env:WORKER_PYTHON = "D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe"  # hoặc đường dẫn python.exe của worker env trên máy

# Kiểm thử adapter AI & P7 real 155-slice worker HTTP/PostgreSQL E2E (13 tests)
& $env:WORKER_PYTHON -m pytest BE/tests/ai -v

# Chạy smoke E2E thật 155 lát + CPU benchmark qua FastAPI + PostgreSQL cô lập (bts_ai_smoke_test)
& $env:WORKER_PYTHON BE/scripts/run_p7_real_ai_smoke.py --case-dir "<path-to-BraTS20_Training_001>" --checkpoint "<path-to-best.pt>"

# Chạy benchmark adapter thuần 155 lát (P0)
& $env:WORKER_PYTHON BE/worker/verify_p0.py --case-dir "<path-to-BraTS20_Training_001>" --checkpoint "<path-to-best.pt>"
```

### Frontend (Vitest: 10 files, 76 tests · Playwright Chromium E2E: 4 tests)

```powershell
cd FE
npm run typecheck
npm test -- --run
npm run build

# E2E Desktop Google Chrome trên live FastAPI + PostgreSQL (bts_e2e_test) + Vite proxy + deterministic_fake_worker (`BE/scripts/run_p7_e2e_stack.py`):
npm run test:e2e
```

---

## Quy tắc bảo mật dữ liệu & repository

- Không commit `.env`, private keys (`*.pem`, `*.key`), thư mục `storage/`, model weights (`*.pt`, `*.pth`, `*.onnx`), hoặc tệp MRI/mask bệnh nhân (`*.nii`, `*.nii.gz`).
- Trên giao diện Frontend, `VITE_USE_FIXTURES=true` chỉ dùng để phát triển UI cục bộ khi không chạy Backend; luôn tắt (`false`) khi kiểm thử ghép nối thật.
