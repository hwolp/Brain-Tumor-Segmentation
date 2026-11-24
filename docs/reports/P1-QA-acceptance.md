# Báo cáo Nghiệm thu QA Độc lập — P0-QA & P1-QA

- **Ngày thực hiện:** 2026-11-17
- **Phạm vi:** Nghiệm thu độc lập **P0-QA** (AI adapter, manifest, môi trường thực thi, benchmark 155 lát cắt) và **P1-QA** (PostgreSQL Docker Compose, Alembic migration, persistence qua restart, đồng bộ OpenAPI → TypeScript FE, ghép nối live qua Vite proxy → FastAPI → PostgreSQL, toàn bộ test BE/FE/AI, runbook `README.md`).
- **Môi trường kiểm thử:**
  - OS: `Windows-11-10.0.26300-SP0` (16 logical CPU cores, `15.68 GB` RAM)
  - Python: `3.13.5` (`BE/.venv` và `D:\Nam4\Ky1\PBL6\.venv`)
  - Node.js / npm: `v22.23.2` / `10.9.8`
  - Docker / Docker Compose: `29.8.1` / `v5.5.1` (`postgres:16-alpine`)
- **Kết luận tổng quát:** **ĐẠT (PASS)** toàn bộ tiêu chí nghiệm thu **P0-QA** và **P1-QA** (có ghi nhận các phát hiện về đóng gói dependency cho checkout sạch và xung đột cổng `8000` trên máy chủ kiểm thử).

---

## 1. Kết quả Nghiệm thu P0-QA (AI Adapter & Manifest)

### 1.1. Đối chiếu Manifest, Báo cáo P0 và Tiêu chí `QA-AI-01` / `QA-AI-02` / `QA-AI-03`

Đã rà soát trực tiếp [manifest.json](../../BE/worker/manifest.json), [P0-AI-verification.md](P0-AI-verification.md), [adapter.py](../../BE/worker/adapter.py), [model.py](../../BE/worker/model.py), [preprocess.py](../../BE/worker/preprocess.py), [tda.py](../../BE/worker/tda.py), [verify_p0.py](../../BE/worker/verify_p0.py) và [test_p0_adapter.py](../../BE/tests/ai/test_p0_adapter.py):

| Tiêu chí | Yêu cầu đối chiếu (`docs/PHASES.md`, `AGENTS-AND-QA.md`) | Kết quả kiểm tra độc lập |
|---|---|---|
| Checkpoint & Manifest | SHA-256, kiến trúc, input channels, thứ tự kênh, TDA & crop config | **ĐẠT:** `manifest.json` khóa `model_id="tda-seg-unet"`, `version="cce-dice-ep136"`, `verification_status="verified"`, `checkpoint_sha256="6ec9edc3b0d75474d8d8d427e8d962b6f7fabff1d2aab08ad972b08775413d3f"`, `TDASegUNet` (`in_channels=6`, `num_classes=4`, `base_channels=16`, `1,943,060` tham số, 118 tensors, thứ tự 6 kênh `[flair, t1ce, flair_h0_pi, flair_h1_pi, t1ce_h0_pi, t1ce_h1_pi]`). `load_verified_model` kiểm tra SHA-256 (so sánh hằng thời gian bằng `hmac.compare_digest`), chấp nhận cả `state_dict` tensor thuần lẫn dict có key `'model'`, từ chối dict chứa metadata không phải tensor mà thiếu key `'model'` / sai shape / không fallback CPU khi yêu cầu `cuda`. |
| `QA-AI-01` | Inference chỉ nhận FLAIR + T1ce; loại `_seg`, T1, T2 | **ĐẠT:** Kiểm thử tĩnh xác nhận không có tham chiếu `_seg`, `ground_truth`, `_t1.nii`, `_t2.nii` trong module suy luận; test `test_qa_ai_01_inference_without_seg_t1_t2` và `verify_p0.py` sao chép chỉ 2 file FLAIR + T1ce vào thư mục tạm cô lập trước khi gọi `run_case`. |
| `QA-AI-02` | Crop sát 4 biên/góc, lát trống, chống negative wrapping | **ĐẠT:** `crop_centered` kẹp `[0, 112]` với cửa sổ `128×128` trên lưới `240×240`; `restore_patch_to_slice` từ chối `x0 < 0` hoặc tràn biên bằng `ValueError`; `make_tda_channels` trên lát trống trả mảng all-zero `float32` sạch (không NaN/Inf). |
| `QA-AI-03` | Nhãn raw `{0,1,2,4}`, dtype `uint8`, bảo toàn affine/qform/sform/zooms, coverage | **ĐẠT:** Export `.nii.gz` `uint8` đúng shape `(240, 240, 155)`, nhãn thuộc `{0, 1, 2, 4}`, giữ nguyên `affine`, `zooms`, `qform`, `sform`, `xyzt_units`. `coverage.json` ghi tọa độ crop từng lát và đánh dấu `unevaluated_outside_crop: true`; `metadata.json` tách riêng `WT/TC/ET` không cộng gộp. |

### 1.2. Kiểm tra Môi trường `BE/.venv` vs `D:\Nam4\Ky1\PBL6\.venv` vs `BE/requirements.txt`

QA đã kiểm tra chi tiết cấu hình hai virtualenv (`pyvenv.cfg`, `pip list --local`, `importlib.metadata` và đường dẫn `__file__` của từng gói):

1. **Cách tạo hai virtualenv trên máy hiện tại:**
   - Cả `BE/.venv` và `D:\Nam4\Ky1\PBL6\.venv` đều được tạo với Python `3.13.5` và tùy chọn **`--system-site-packages`** (`include-system-site-packages = true` trong `pyvenv.cfg`).
   - Trong `BE/.venv`, các gói cài **cục bộ** (`pip list --local`) gồm: `alembic==1.20.1`, `nibabel==5.5.0`, `psycopg==3.3.9`, `psycopg-binary==3.3.9`, `ruff==0.17.5`, `scikit-image==0.26.0` (cùng phụ thuộc `ImageIO`, `lazy-loader`, `Mako`, `tifffile`).
   - Các gói khác mà `BE/.venv` dùng được gồm API stack (`fastapi==0.135.3`, `uvicorn==0.44.0`, `SQLAlchemy==2.0.49`, `numpy==2.2.6`, `pytest==9.0.3`) **và** AI stack (`torch==2.8.0`, `gudhi==3.13.0`, `scipy==1.16.1`, `pandas==2.3.1`, `psutil==7.0.0`) hiện **đang kế thừa từ system site-packages** (`C:\Users\ADMIN\AppData\Local\Programs\Python\Python313\Lib\site-packages` và `%APPDATA%\Python\Python313\site-packages`).
   - Trong `D:\Nam4\Ky1\PBL6\.venv`, các gói cài cục bộ gồm `gudhi==3.13.0`, `nibabel==5.4.2`, `scikit-image==0.26.0`; **không có** `alembic`, `psycopg`, `ruff`.
2. **So sánh với `BE/requirements.txt` và `BE/pyproject.toml`:**
   - `BE/requirements.txt` chỉ ghim 14 gói phục vụ Backend API (`fastapi==0.135.3`, `uvicorn[standard]==0.44.0`, `pydantic==2.12.5`, `pydantic-settings==2.13.1`, `sqlalchemy==2.0.49`, `alembic==1.20.1`, `psycopg[binary]==3.3.9`, `httpx==0.28.1`, `pytest==9.0.3`, `nibabel==5.5.0`, `numpy==2.2.6`, `scikit-image==0.26.0`, `python-multipart==0.0.26`, `ruff==0.17.5`) và **cố ý không khai báo** `torch`, `gudhi`, `scipy`, `pandas`, `psutil`.
   - Điều này phù hợp với kiến trúc tách runtime tại `docs/BE/06-testing-deployment.md` mục 4 (*"Worker khởi động bằng Python environment riêng để tái sử dụng PyTorch/CUDA"*).
   - **Phát hiện cần lưu ý cho checkout sạch:** Nếu tạo `BE/.venv` mới **không** có `--system-site-packages` và chỉ cài `pip install -r BE/requirements.txt`, thì `BE/.venv` sẽ **thiếu** `torch`, `gudhi`, `scipy`, `psutil` để chạy `BE/tests/ai` hoặc worker. Ngoài ra có chênh lệch nhỏ phiên bản `nibabel` (`5.5.0` trong `BE/requirements.txt` vs `5.4.2` ghi nhận trong `BE/worker/manifest.json`) — cần chốt rõ một file khóa dependency riêng cho worker (ví dụ `requirements-worker.txt`) ở P5-AI.

### 1.3. Kết quả Chạy Thực tế `BE/tests/ai` và `BE/worker/verify_p0.py`

| Lệnh kiểm tra | Exit code | Kết quả đo được |
|---|---|---|
| `BE\.venv\Scripts\python.exe -m pytest BE/tests -v` (bao gồm 12 tests `BE/tests/ai`) | `0` | `38 passed in 27.88s` (gồm `12/12` AI tests) |
| `D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe -m pytest BE/tests/ai -v` | `0` | `12 passed in 25.40s` |
| `D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe BE/worker/verify_p0.py` | `0` | Chạy thành công toàn bộ 155 lát trên `BraTS20_Training_001` (input cô lập chỉ gồm FLAIR + T1ce) |

Chi tiết đối chiếu output thật từ `verify_p0.py` với [P0-AI-verification.md](P0-AI-verification.md):
- **Output NIfTI:** `shape=[240, 240, 155]`, `dtype=uint8`, `unique_labels=[0, 1, 2, 4]`, `affine_match=true`, `zooms_match=true`, `qform_match=true`, `sform_match=true`, `xyzt_units=["mm", "unknown"]`, `mask_nii_gz_bytes=84577`.
- **Coverage:** `total_slices=155`, `evaluated_slices=155`, `empty_slices=20` (`[0, 1, 2, 3, 139..154]`), `unevaluated_outside_crop=true`.
- **Voxel counts & Group volumes (`mm³`):** `0`: `8,738,764`, `1`: `16,862`, `2`: `144,227`, `4`: `28,147`; `WT`: `189,236.0`, `TC`: `45,009.0`, `ET`: `28,147.0` (trùng khớp 100% số liệu đã báo cáo trong `P0-AI-verification.md`).
- **Stage timings & Peak RAM (lần chạy xác minh QA trên CPU):** `load=385.319 ms`, `preprocess=1267.706 ms`, `tda=13781.094 ms`, `inference=1828.216 ms`, `reconstruct=81.867 ms`, `save=83.262 ms`; tổng `17,427.464 ms`, `peak_ram_mb=681.82`.
- **Đối chiếu nội bộ sau suy luận với `_seg`:** `WT Dice=0.928734` (`IoU=0.86695`), `TC Dice=0.948545` (`IoU=0.902127`), `ET Dice=0.895811` (`IoU=0.811285`), `gt_wt_crop_recall=0.999877` (`211,953 / 211,979` voxel).

---

## 2. Kết quả Nghiệm thu P1-QA (BE + FE + PostgreSQL + OpenAPI)

### 2.1. Docker Compose, PostgreSQL, Migration & Restart Persistence

| Kiểm tra | Lệnh / Quy trình | Exit code | Kết quả |
|---|---|---|---|
| Docker daemon & Compose | `docker info`, `docker compose up -d postgres`, `docker compose ps` | `0` | Container `braintumorsegmentation-postgres-1` (`postgres:16-alpine`) chạy ở trạng thái `healthy` trên `127.0.0.1:5432->5432/tcp`. |
| Alembic upgrade/downgrade/upgrade & DB cô lập test | `$env:DATABASE_URL="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"`, chạy `upgrade head` → `downgrade base` → `upgrade head` → `current`; sau chỉnh sửa `P1-BE`, test integration chạy trên DB cô lập `bts_test` kèm guard chống downgrade nhầm DB dev/prod | `0` | Bảng `system_settings` được tạo ở `0001_p1_foundation`, xóa sạch ở `downgrade base`, tạo lại thành công ở `upgrade head`. Sau khi chạy toàn bộ suite `BE/tests` trên `bts_test`, kiểm tra lại `bts_dev` vẫn còn nguyên bảng `['alembic_version', 'system_settings']` ở `0001_p1_foundation (head)`. |
| Persistence qua restart container | Insert bản ghi `key='qa.p1.restart_persistence'` vào `system_settings`, chạy `docker compose restart postgres`, đợi `healthy`, truy vấn lại và xóa bản ghi test | `0` | Dữ liệu (`value_json={'phase': 'P1', 'qa_check': True}`, `updated_by='11111111-1111-4111-8111-111111111111'`, `updated_at='2026-11-17 11:05:01.562301+00:00'`) tồn tại nguyên vẹn sau restart; đã dọn sạch (`remaining count: 0`). |

### 2.2. Kiểm tra OpenAPI, Sinh TypeScript Types & Khắc phục Lệch Hợp đồng FE/BE

1. Chạy `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m app.scripts.export_openapi --check` → **Exit code `0`** (`BE/openapi/openapi.json` khớp 100% với FastAPI app).
2. Chạy `npm run generate:types` trong `FE/` (`openapi-typescript ../BE/openapi/openapi.json -o src/shared/api/schema.d.ts`) → **Exit code `0`** (`36.2ms`–`42.2ms`).
3. **Phát hiện lệch kiểu giữa placeholder FE cũ và OpenAPI thật của BE** (khi chạy `npm run typecheck` ngay sau `generate:types`, `tsc -b --noEmit` báo lỗi `TS2339` exit code `2`):
   - `FE/src/shared/api/types.ts` cũ tham chiếu `ErrorEnvelope`, `HealthLiveResponse`, `HealthReadyResponse`, trong khi OpenAPI thật xuất `ErrorResponse`, `ErrorBody`, `ErrorDetailItem`, `LivenessResponse`, `ReadinessChecks`, `ReadinessResponse`.
   - `FE/src/shared/api/fixtures.ts` cũ dùng field `timestamp` (không tồn tại trong OpenAPI) và thiếu trường bắt buộc `environment: 'local' | 'test' | 'production'` trên `LivenessResponse`.
   - `FE/src/shared/api/errors.ts` cũ định nghĩa `ApiErrorDetailItem` với `{ field?: string; reason?: string; message?: string }`, lệch với `ErrorDetailItem` thật trong OpenAPI (`{ field?: string | null; reason: string; type?: string | null }`).
   - `FE/src/test/routingAndGuards.test.tsx` cũ mock `/health/` trả `{ status: 'ok' }` chung cho cả `/live` và `/ready`.
4. **Các tệp FE đã được đồng bộ 100% với `schema.d.ts` sinh từ OpenAPI thật:**
   - [schema.d.ts](../../FE/src/shared/api/schema.d.ts) — file sinh tự động từ `BE/openapi/openapi.json`.
   - [types.ts](../../FE/src/shared/api/types.ts) — export trực tiếp `ErrorResponse`, `ErrorBody`, `ErrorDetailItem`, `LivenessResponse`, `ReadinessChecks`, `ReadinessResponse` từ `components['schemas']` (giữ alias `ErrorEnvelope`, `HealthLiveResponse`, `HealthReadyResponse`).
   - [errors.ts](../../FE/src/shared/api/errors.ts) — dùng `ErrorResponse` và `ApiErrorDetailItem = ErrorDetailItem`.
   - [fixtures.ts](../../FE/src/shared/api/fixtures.ts) — cập nhật `FIXTURE_HEALTH_LIVE` (`status: 'ok', service: 'brain-tumor-api', environment: 'local'`) và `FIXTURE_HEALTH_READY` (`status: 'ready', checks: { database: 'ok', storage: 'ok' }`), bỏ `timestamp`.
   - [health.ts](../../FE/src/shared/api/health.ts) — dùng `LivenessResponse` và `ReadinessResponse`.
   - [routingAndGuards.test.tsx](../../FE/src/test/routingAndGuards.test.tsx) — cập nhật mock `/health/live` & `/health/ready` theo đúng schema OpenAPI thật và xác minh badge `API sẵn sàng` hiển thị trên `AppShell`.

### 2.3. Kiểm tra Ghép nối End-to-End thật qua Vite Proxy → FastAPI → PostgreSQL

- **Ghi nhận môi trường cổng & kiểm tra `loadEnv` (`FE/.env`):** Khi kiểm tra trước khi khởi chạy `uvicorn`, cổng `127.0.0.1:8000` đang bị một container Docker không thuộc dự án (`testdocker_app`, image `testdocker-web`, PID `31696` qua `com.docker.backend.exe`) chiếm giữ. Để không can thiệp vào container ngoài phạm vi dự án, QA khởi động FastAPI ở `127.0.0.1:8001` (với `STORAGE_ROOT` tạm ngoài workspace, `PUBLIC_ORIGIN=http://127.0.0.1:5173`, kết nối PostgreSQL thật `bts_dev`) và kiểm tra cả hai cách cấu hình Vite proxy tại `127.0.0.1:5173`: qua biến môi trường shell và qua `FE/.env` tạm (`VITE_API_PROXY_TARGET=http://127.0.0.1:8001`, xóa biến `VITE_API_PROXY_TARGET` khỏi process env để chứng minh `FE/vite.config.ts` dùng `loadEnv` hoạt động đúng).
- **Kết quả request HTTP thật qua Vite proxy (`http://127.0.0.1:5173`):**

| Request qua Vite proxy | Status | Response JSON xác minh | Headers xác minh |
|---|---|---|---|
| `GET http://127.0.0.1:5173/` | `200` | HTML Vite SPA (`text/html`) | — |
| `GET http://127.0.0.1:5173/api/v1/health/live` (cấu hình qua `loadEnv` `FE/.env`) | `200` | `{"status": "ok", "service": "brain-tumor-api", "environment": "local"}` | `Cache-Control: no-store`, `X-Request-ID: ac6d8930-6d62-418f-bef9-902c356baea7` (UUID hợp lệ; kiểm tra bổ sung cũng echo đúng UUID gửi qua `X-Request-ID`) |
| `GET http://127.0.0.1:5173/api/v1/health/ready` (cấu hình qua `loadEnv` `FE/.env`) | `200` | `{"status": "ready", "checks": {"database": "ok", "storage": "ok"}}` | `Cache-Control: no-store`, `X-Request-ID: ba0b3c97-a668-438b-8bfd-5fff8c24c368` |
| `GET http://127.0.0.1:5173/api/v1/nonexistent` | `404` | `{"error": {"code": "not_found", "message": "Không tìm thấy tài nguyên yêu cầu.", "details": null, "request_id": "41e7c6e9-805a-4b0e-b957-87df8cd84ac1"}}` | `Cache-Control: no-store`, `X-Request-ID: 41e7c6e9-805a-4b0e-b957-87df8cd84ac1` khớp body `error.request_id` |

- Sau kiểm thử, cả tiến trình `uvicorn` (`8001`) và `vite` (`5173`) đều được đóng sạch, tệp `FE/.env` tạm và thư mục storage tạm đều đã bị xóa (`FE/.env exists: False | storage exists: False | 8001 open: False | 5173 open: False`); container PostgreSQL (`braintumorsegmentation-postgres-1`) giữ nguyên trạng thái `healthy`.

### 2.4. Kết quả Toàn bộ Test Suite & Lint / Build Sau Chỉnh sửa Cuối cùng

| Hạng mục | Lệnh đã chạy | Exit code | Kết quả |
|---|---|---|---|
| Pytest collection (từ gốc repo & từ `BE/`) | `BE\.venv\Scripts\python.exe -m pytest --collect-only -q` và chạy lại từ `BE/` | `0` | `38 tests collected in 4.59s` (gốc repo) / `3.79s` (từ `BE/`) |
| OpenAPI contract sync | `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m app.scripts.export_openapi --check` | `0` | Khớp 100% với `BE/openapi/openapi.json` |
| Toàn bộ Backend + AI (`BE/.venv`, DB test cô lập `bts_test`) | `BE\.venv\Scripts\python.exe -m pytest BE/tests -v` | `0` | `38 passed in 27.88s` (12 unit, 11 integration, 3 contract, 12 AI — dựa trên gói hệ thống qua `--system-site-packages`) |
| AI adapter tests (`PBL6/.venv`) | `D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe -m pytest BE/tests/ai -v` | `0` | `12 passed in 25.40s` |
| Backend Ruff lint | `BE\.venv\Scripts\python.exe -m ruff check BE/app BE/tests/unit BE/tests/integration BE/tests/contract BE/migrations` | `0` | `All checks passed!` |
| Cô lập DB dev sau test tích hợp | Kiểm tra `alembic current` & `inspect` trên `bts_dev` | `0` | `0001_p1_foundation (head)`, tables `['alembic_version', 'system_settings']` còn nguyên vẹn |
| FE OpenAPI TypeScript gen | `npm run generate:types` (trong `FE/`) | `0` | Sinh `src/shared/api/schema.d.ts` trong `65ms` |
| FE TypeScript strict check | `npm run typecheck` (trong `FE/`) | `0` | Không có lỗi TypeScript |
| FE Unit & Component tests | `npm test -- --run` (trong `FE/`) | `0` | `4 passed (4)` files (`viewerAdapter`: 9, `formatters`: 9, `sharedUi`: 5, `routingAndGuards`: 10), `33 passed (33)` tests trong `12.90s` |
| FE Production build | `npm run build` (trong `FE/`) | `0` | Vite build thành công (`8.25s`), `niivue` tách chunk riêng (`688.28 kB`), Noto Sans tiếng Việt đóng gói local |

---

## 3. Tài liệu & Vấn đề Mở (Không chặn P1)

### 3.1. Tài liệu bàn giao mới tạo
- [README.md](../../README.md) — Hướng dẫn từng bước chạy local (Docker Compose Postgres, `BE/.venv`, `.env`, Alembic migration, OpenAPI/type generation, chạy FastAPI & Vite proxy, chạy test BE/FE/AI, lưu ý bảo mật). Phạm vi thực thi xác minh thực tế: các lệnh test, Alembic, OpenAPI, FE build và ghép nối proxy đã được kiểm chứng trên `BE/.venv` (tạo với `--system-site-packages`) và `D:\Nam4\Ky1\PBL6\.venv`, trong đó ghép nối live chạy qua `uvicorn --port 8001` (thay vì `8000` đang bị container ngoài dự án chiếm trên máy kiểm thử); **chưa** kiểm tra cài mới từ đầu trong một `.venv` cô lập hoàn toàn (không `--system-site-packages`) trên máy sạch.
- [P1-QA-acceptance.md](P1-QA-acceptance.md) — Báo cáo nghiệm thu này.

### 3.2. Ghi chú kỹ thuật / vấn đề không chặn cần theo dõi ở các phase sau
1. **Tách/khóa dependency worker trước P5-AI:** `BE/requirements.txt` chỉ khóa dependency API (`fastapi`, `alembic`, `psycopg`, `nibabel==5.5.0`, ...); chưa có file `requirements-worker.txt` khóa tập AI (`torch==2.8.0`, `gudhi==3.13.0`, `scipy==1.16.1`, `psutil==7.0.0`, `pandas==2.3.1`, `nibabel`). Nên bổ sung lock file worker ở P5-AI để môi trường worker tách biệt hoàn toàn với system site-packages.
2. **Ruff lint trên `BE/worker/` và `BE/tests/ai/`:** Khi chạy thử `ruff check BE/worker BE/tests/ai`, ghi nhận `78` lỗi style (chủ yếu `E501` độ dài dòng > 100 và `I001` thứ tự import ở các file P0), không ảnh hưởng tính đúng đắn runtime của P0; nên dọn dần khi tích hợp P5-AI nếu đưa vào phạm vi CI lint chung.
3. **Chunk size warning khi Vite build:** `niivue-LDsDYOE7.js` (`688.28 kB`) vượt ngưỡng cảnh báo mặc định `500 kB` của Vite nhưng đã được tách riêng qua `manualChunks` và lazy-load tại route viewer (`ViewerWorkspacePage`), đúng yêu cầu `docs/PHASES.md` P1.
4. **Kiểm tra trình duyệt Playwright (Desktop/Mobile):** Bộ test tự động P1 hiện kiểm qua Vitest + JSDOM và live HTTP proxy; kiểm thử Playwright Chromium thật trên giao diện đầy đủ sẽ được thực hiện ở P2–P7 theo `docs/FE/07-testing.md`.
