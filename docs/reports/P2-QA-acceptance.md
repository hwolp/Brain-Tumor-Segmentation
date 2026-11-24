# Báo cáo Nghiệm thu QA Độc lập — P2-QA (Ghép nối & Kiểm chứng An ninh P2)

- **Ngày thực hiện:** 2026-11-17
- **Phạm vi:** Nghiệm thu độc lập **P2-QA** (cấu trúc `BE/app/` + `BE/scripts/`, Alembic `0002_p2_auth_and_accounts`, OpenAPI → TypeScript FE contract sync, ghép nối E2E live qua Vite proxy → FastAPI → PostgreSQL, kiểm thử đồng thời refresh rotation, kiểm tra an ninh `QA-AUTH-01`..`05` và `QA-ACL-02`, toàn bộ test suite BE/AI/FE và cập nhật `README.md`).
- **Môi trường kiểm thử:**
  - OS: `Windows-11-10.0.26300-SP0`
  - Python: `3.13.5` (`BE/.venv`)
  - Node.js / npm: `v22.23.2` / `10.9.8`
  - Docker / Docker Compose: `29.8.1` / `v5.5.1` (`postgres:16-alpine` container `braintumorsegmentation-postgres-1`, trạng thái `healthy` trên `127.0.0.1:5432`)
- **Kết luận tổng quát:** **ĐẠT (PASS)** toàn bộ tiêu chí nghiệm thu **P2-QA**.

---

## 1. Kiểm tra Cấu trúc `BE/app/` & `BE/scripts/` và Migration / OpenAPI

### 1.1. Xác minh cây thư mục Backend

- `BE/app/` khớp mẫu thiết kế:
  - `api/` (`__init__.py`, `v1/` gồm `admin_users.py`, `auth.py`, `doctor.py`, `health.py`, `jwks.py`, `__init__.py`)
  - `core/` (`config.py`, `db.py`, `errors.py`, `logging.py`, `security.py`, `storage.py`, `__init__.py`)
  - `models/` (`audit_event.py`, `base.py`, `session.py`, `system_setting.py`, `user.py`, `__init__.py`)
  - `repositories/` (`audit_repo.py`, `session_repo.py`, `system_setting_repo.py`, `user_repo.py`, `__init__.py`)
  - `schemas/` (`admin_user.py`, `auth.py`, `common.py`, `error.py`, `health.py`, `__init__.py`)
  - `services/` (`admin_user_service.py`, `auth_service.py`, `health_service.py`, `__init__.py`)
  - `dependencies.py`, `main.py`, `__init__.py`
- Đã kiểm tra không còn `BE/app/infrastructure/`, `BE/app/scripts/`, hoặc `BE/app/api/dependencies.py` (`Test-Path` trả `False`).
- `BE/scripts/` gồm: `__init__.py`, `bootstrap_admin.py`, `export_openapi.py`.

### 1.2. Migration & OpenAPI Contract

| Kiểm tra | Lệnh | Exit code | Kết quả |
|---|---|---|---|
| OpenAPI sync | `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m scripts.export_openapi --check` | `0` | Khớp 100% với `BE/openapi/openapi.json`. |
| Alembic current (`bts_dev`) | `$env:DATABASE_URL="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"; BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini current` | `0` | `0002_p2_auth_and_accounts (head)`. |
| Alembic schema drift check (`bts_dev`) | `$env:DATABASE_URL="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"; BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini check` | `0` | `No new upgrade operations detected.` |

---

## 2. Đồng bộ OpenAPI → TypeScript FE (`schema.d.ts` → `FE/src/`)

1. Chạy `npm run generate:types` trong `FE/` (`openapi-typescript ../BE/openapi/openapi.json -o src/shared/api/schema.d.ts`) → Exit code `0` (`72.5ms`–`82.7ms`).
2. **Phát hiện lệch kiểu khi đối chiếu `FE/src/shared/api/types.ts` với `schema.d.ts`:**
   - `FE/src/shared/api/types.ts` trước đó định nghĩa thủ công `UserDto`, `AuthTokenResponseDto`, `LoginRequestDto`, `ChangePasswordRequestDto`, `AdminDoctorUserDto`, `AdminCreateDoctorRequestDto`, `AdminUpdateDoctorRequestDto`, `AdminResetPasswordResponseDto` thay vì dẫn xuất trực tiếp từ `components['schemas']` trong `schema.d.ts`.
   - Sai khác cụ thể:
     - `UserOut` thực tế yêu cầu `created_at: string` và **không** có `updated_at` / `password_changed_at` (nhưng `UserDto` cũ để `created_at?: string`, có `updated_at?`, `password_changed_at?`).
     - `AdminDoctorUserOut` thực tế yêu cầu **cả** `created_at: string` và `updated_at: string`, và **không** có `password_changed_at` (nhưng `AdminDoctorUserDto` cũ để `updated_at?: string`).
     - `AuthTokenResponse` thực tế khóa `token_type: "bearer"` (literal `"bearer"`, không phải `string` chung).
     - `AdminUpdateDoctorRequest` thực tế cho phép `display_name?: string | null` và `is_active?: boolean | null`.
   - Khi chuyển `FE/src/shared/api/types.ts` sang tham chiếu trực tiếp `components['schemas']`, `npm run typecheck` (`tsc -b --noEmit`) lập tức phát hiện `7` lỗi `TS2741` tại `adminUsers.ts`, `fixtures.ts`, `adminUsers.test.tsx`, `authAndSession.test.tsx`.
3. **Các tệp FE đã được cập nhật đồng bộ 100% với `schema.d.ts`:**
   - [types.ts](../../FE/src/shared/api/types.ts) — Export trực tiếp `UserOut`, `AuthTokenResponse`, `LoginRequest`, `ChangePasswordRequest`, `JwkItem`, `JwksResponse`, `AdminDoctorUserOut`, `AdminCreateDoctorRequest`, `AdminUpdateDoctorRequest`, `TemporaryPasswordResponse`, `PaginatedResponse_AdminDoctorUserOut_` từ `components['schemas']` (kèm alias `*Dto` tương thích ngược), `UserRole = UserOut['role']`.
   - [adminUsers.ts](../../FE/src/shared/api/adminUsers.ts) — Dùng `PaginatedResponse_AdminDoctorUserOut_` và bổ sung `updated_at` bắt buộc cho dữ liệu fixture `createAdminDoctorUser` / `updateAdminDoctorUser`.
   - [fixtures.ts](../../FE/src/shared/api/fixtures.ts) — Bổ sung `updated_at` bắt buộc cho `FIXTURE_ADMIN_USERS`.
   - [adminUsers.test.tsx](../../FE/src/test/adminUsers.test.tsx) — Bổ sung `updated_at` cho mock `AdminDoctorUserDto`.
   - [authAndSession.test.tsx](../../FE/src/test/authAndSession.test.tsx) — Bổ sung `created_at` cho `DOCTOR_B_USER: UserDto`.
   - [routingAndGuards.test.tsx](../../FE/src/test/routingAndGuards.test.tsx) — Bổ sung `updated_at` vào mock danh sách `AdminDoctorUserOut`.

---

## 3. Kiểm thử Tích hợp End-to-End Live qua Vite Proxy → FastAPI → PostgreSQL

### 3.1. Thiết lập Môi trường Cô lập & Bootstrap

- **Database cô lập:** `bts_test` (`alembic upgrade head` → `0002_p2_auth_and_accounts`, `TRUNCATE` sạch trước và sau phiên kiểm thử; `bts_dev` hoàn toàn không bị chạm tới).
- **Khóa RSA-2048 & Storage tạm:** Tạo trong thư mục tạm ngoài workspace (`%APPDATA%\...\Temp\bts_p2_qa_live_*`), sinh khóa bằng `BE/.venv/Scripts/python.exe -m scripts.bootstrap_admin --init-jwt-keys` (`JWT_KEY_ID=qa-p2-rs256-v1`).
- **Bootstrap Admin trên `bts_test`:** Chạy `scripts.bootstrap_admin --username qa.admin --display-name "QA P2 Admin"` qua stdin pipe (`sys.stdin = open(0, encoding='utf-8', closefd=False)` để kích hoạt `fallback_getpass` trên Windows) → tạo thành công `qa.admin` (`d8244f33-0fff-436c-99c7-3c2d4e6742d3`).
- **Tiến trình live:**
  - FastAPI `uvicorn app.main:app --host 127.0.0.1 --port 8001` (`APP_ENV=local`, `PUBLIC_ORIGIN=http://127.0.0.1:5173`, `COOKIE_SECURE=false`). *(Lưu ý: cổng `8000` trên máy đang bị container `testdocker_app` ngoài dự án chiếm nên dùng `8001`.)*
  - Tạo `FE/.env` tạm (`VITE_API_PROXY_TARGET=http://127.0.0.1:8001`, `VITE_USE_FIXTURES=false`) và khởi chạy Vite dev server tại `http://127.0.0.1:5173`.

### 3.2. Kết quả Từng bước qua Vite Proxy (`http://127.0.0.1:5173`)

| Bước | Kiểm thử | HTTP Status & Code | Chi tiết xác minh thực tế |
|---|---|---|---|
| 1 | `GET /`, `GET /api/v1/health/live`, `GET /api/v1/health/ready` | `200`, `200`, `200` | `live`: `{"status":"ok","service":"brain-tumor-api","environment":"local"}`; `ready`: `{"status":"ready","checks":{"database":"ok","storage":"ok"}}`; có `Cache-Control: no-store` và UUID `X-Request-ID`. |
| 2 | `POST /api/v1/auth/login` (admin `qa.admin`, `Origin: http://127.0.0.1:5173`) | `200` | Trả `token_type="bearer"`, `expires_in=900`, `role="admin"`, `must_change_password=false`. `Set-Cookie: bts_refresh=<REDACTED>; HttpOnly; Max-Age=604799; Path=/api/v1/auth; SameSite=lax` (không `Domain`, không `Secure`). JWT header `alg=RS256`, `kid=qa-p2-rs256-v1`, xác thực chữ ký bằng JWKS public key thành công; claims chỉ gồm `["aud","exp","iat","iss","role","sid","sub"]`. |
| 3 | `POST /api/v1/admin/users` & `GET /api/v1/admin/users?q=dr.qa.e2e&status=active` | `201`, `200` | Tạo bác sĩ `dr.qa.e2e` với `must_change_password=true`, `is_active=true`, `role="doctor"`, không trả `password_hash`/`temporary_password`; list trả `total=1`. |
| 4 | Bác sĩ login mật khẩu tạm → gate `must_change_password` → `/auth/change-password` | `200` → `403` → `200` → `204` → `401` | `GET /api/v1/doctor/profile` bị chặn `403 password_change_required`; `GET /api/v1/auth/me` trả `200`; `POST /api/v1/auth/change-password` (mật khẩu mới có khoảng trắng đầu/cuối) trả `204` + xóa cookie `bts_refresh` (`Max-Age=0`); token cũ gọi `GET /api/v1/auth/me` bị từ chối `401 unauthenticated`. |
| 5 | Bác sĩ login mật khẩu mới + ranh giới RBAC (`QA-ACL-02`) | `200`, `200`, `403`, `403` | Login mật khẩu mới (giữ nguyên khoảng trắng) thành công (`must_change_password=false`); bác sĩ gọi `GET /api/v1/doctor/profile` → `200`; bác sĩ gọi `GET /api/v1/admin/users` → `403 forbidden`; admin gọi `GET /api/v1/doctor/profile` → `403 forbidden`. |
| 6 | Refresh rotation, phát hiện reuse & kiểm thử đồng thời (`QA-AUTH-02`) | `200` → `401` → `401` → `401`; race `[401,401,401,200,401]` | `POST /api/v1/auth/refresh` cookie `C1` → `200` + cookie kế nhiệm `C2`; replay `C1` → `401 refresh_reused`; dùng `C2` sau replay → `401 refresh_reused` (toàn family bị thu hồi); access token thuộc family đó gọi `/auth/me` → `401 unauthenticated`. **Kiểm thử đồng thời 5 luồng (`ThreadPoolExecutor`)** gửi `POST /api/v1/auth/refresh` cùng 1 cookie qua Vite proxy → đúng **1** request `200` và **4** request `401`, không cấp hai successor hợp lệ. |
| 7 | Admin khóa bác sĩ (`PATCH /api/v1/admin/users/{id}` `{is_active: false}`, `QA-AUTH-04`) | `200` → `401` | Access token đang sống của bác sĩ bị chặn ngay lập tức ở cả `GET /api/v1/doctor/profile` (`401 account_disabled`) và `GET /api/v1/auth/me` (`401 account_disabled`). |
| 8 | Admin mở khóa & `POST /api/v1/admin/users/{id}/reset-password` | `200`, `200`, `200` | `reset-password` trả `200 {temporary_password}` độ dài `20` ký tự (`>= 16`), header `Cache-Control: no-store`; bác sĩ đăng nhập bằng mật khẩu tạm mới có `must_change_password=true`. |
| 9 | CSRF Origin & Fetch Metadata | `403`, `403` | `POST /api/v1/auth/login` với `Origin: http://evil.example` → `403 csrf_origin_denied`; `POST /api/v1/auth/refresh` với `Sec-Fetch-Site: cross-site` → `403 csrf_origin_denied`. |
| 10 | `GET http://127.0.0.1:8001/.well-known/jwks.json` | `200` | Trả 1 RSA JWK (`kty="RSA"`, `use="sig"`, `alg="RS256"`, `kid="qa-p2-rs256-v1"`) khớp `kid` trên JWT đã phát hành. |

- **Kiểm tra log & audit sau phiên live:**
  - `audit_events` trên `bts_test` ghi nhận `21` sự kiện; kiểm tra tự động xác nhận không có bất kỳ mật khẩu nào xuất hiện trong `safe_diff`.
  - Log `uvicorn` (`42` dòng) xác nhận không rò bất kỳ mật khẩu, access token, hoặc refresh cookie nào.
- **Dọn dẹp sau kiểm thử live:**
  - Đã đóng sạch `vite` (`5173`) và `uvicorn` (`8001`), xóa `FE/.env` tạm, xóa thư mục tạm RSA keys + storage, truncate sạch dữ liệu test trên `bts_test`.
  - Xác nhận cuối: `fe_env_exists=false`, `temp_root_exists=false`, `port_8001_open=false`, `port_5173_open=false`.
  - Kiểm tra `bts_dev`: đang ở `0002_p2_auth_and_accounts (head)`, `users` có `0` bản ghi, `audit_events` có `0` bản ghi.

---

## 4. Kết quả Toàn bộ Test Suite, Lint, OpenAPI & Build (Chạy Tuần tự sau Chỉnh sửa Cuối)

| Hạng mục | Lệnh đã chạy | Exit code | Kết quả quan sát |
|---|---|---|---|
| BE Pytest (sau bản sửa Round 1) | `BE\.venv\Scripts\python.exe -m pytest BE/tests/unit BE/tests/integration BE/tests/contract -v` | `0` | `50 passed in 28.87s` (16 unit, 31 integration, 3 contract) |
| Backend + AI Pytest (vòng QA gốc trước sửa barrier) | `BE\.venv\Scripts\python.exe -m pytest BE/tests -v` | `0` | `62 passed in 80.89s` (16 unit, 31 integration, 3 contract, 12 AI; dùng `--system-site-packages`) |
| Backend Ruff lint | `BE\.venv\Scripts\ruff.exe check BE/app BE/scripts BE/migrations BE/tests/conftest.py BE/tests/unit BE/tests/integration BE/tests/contract` | `0` | `All checks passed!` |
| OpenAPI contract check | `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m scripts.export_openapi --check` | `0` | Khớp 100% với `BE/openapi/openapi.json` |
| Alembic current & check (`bts_dev`) | `BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini current` & `check` | `0` | `0002_p2_auth_and_accounts (head)`, `No new upgrade operations detected.` |
| FE OpenAPI TypeScript gen | `npm run generate:types` (trong `FE/`) | `0` | Sinh `src/shared/api/schema.d.ts` (`82.7ms`) |
| FE TypeScript strict check | `npm run typecheck` (trong `FE/`) | `0` | Không có lỗi TypeScript |
| FE Unit & Component tests | `npm test -- --run` (trong `FE/`) | `0` | `6 passed (6)` files (`viewerAdapter`: 9, `formatters`: 9, `sharedUi`: 5, `adminUsers`: 1, `routingAndGuards`: 10, `authAndSession`: 11), `45 passed (45)` tests trong `10.38s` |
| FE Production build | `npm run build` (trong `FE/`) | `0` | `tsc -b && vite build` thành công (`6.01s`) |

---

## 5. Đối chiếu Ma trận Ca kiểm thử P2 (`docs/AGENTS-AND-QA.md`)

| Mã ca | Tình huống | Bằng chứng kiểm chứng | Kết quả |
|---|---|---|---|
| `QA-AUTH-01` | JWT expired / sai signature / alg / aud / iss / kid lạ | `test_qa_auth_01_protected_endpoint_rejects_bad_bearer_tokens_with_distinct_codes` & `test_access_jwt_claims_jwk_verification_and_qa_auth_01_rejections` (phân biệt `token_expired`, `invalid_signature`, `invalid_token_alg`, `invalid_issuer`, `invalid_audience`, `unknown_kid`, `unauthenticated`) + kiểm tra live JWKS chữ ký RS256. | **ĐẠT** |
| `QA-AUTH-02` | Dùng lại refresh đã rotate & race đồng thời | Live proxy test (C1→C2, replay C1 → `401 refresh_reused`, C2 bị từ chối `401`, access token bị chặn `401`; race 5x đồng thời → `[401,401,401,200,401]`) + `test_qa_auth_02_*` trên PostgreSQL `SELECT ... FOR UPDATE`. | **ĐẠT** |
| `QA-AUTH-03` | Nhiều GET hết access đồng thời | Vitest `authAndSession.test.tsx`: 10 GET đồng thời gặp `401` chỉ tạo **1** `POST /auth/refresh` và mỗi GET phát lại tối đa 1 lần (20 GET calls); mutation `POST` gặp `401` không tự replay âm thầm. | **ĐẠT (FE mock)** |
| `QA-AUTH-04` | Admin khóa bác sĩ đang hoạt động & bảo vệ draft | Live proxy test: `PATCH /api/v1/admin/users/{id}` `{is_active: false}` chặn access token đang sống của bác sĩ ngay lập tức (`401 account_disabled`). FE `authAndSession.test.tsx`: `account_disabled` xóa sạch cache, object URLs và dirty draft; hết hạn phiên thường giữ nguyên draft trong `ReauthModal` khi cùng bác sĩ đăng nhập lại. | **ĐẠT** |
| `QA-AUTH-05` | Đổi account khi đang có dữ liệu/draft | Vitest `authAndSession.test.tsx` & `routingAndGuards.test.tsx`: bump session epoch chặn response muộn, xóa singleton Query cache, reset viewer store, revoke tracked `blob:` URLs khi đổi tài khoản / logout / nhận broadcast `logged_out` từ tab khác. | **ĐẠT (FE mock)** |
| `QA-ACL-02` | Admin gọi API thuộc phạm vi bác sĩ & bác sĩ gọi admin | Live proxy test + `test_admin_and_doctor_role_boundaries`: bác sĩ gọi `/api/v1/admin/users` → `403 forbidden`; admin gọi `/api/v1/doctor/profile` → `403 forbidden`; `/admin/users` chỉ trả doctor và không chứa PII bệnh nhân. *(Phần `/patients`, `/cases`, `/files`, `/export` sẽ kiểm tiếp ở P3–P6.)* | **ĐẠT (phạm vi P2)** |

---

## 6. Tài liệu Cập nhật & Giới hạn / Ghi chú Kỹ thuật (Không chặn P2)

### 6.1. Tài liệu bàn giao đã cập nhật / tạo mới
- [README.md](../../README.md) — Cập nhật phản ánh đúng cấu trúc `BE/app/` + `BE/scripts/`, migration `0002_p2_auth_and_accounts (head)`, lệnh `scripts.export_openapi`, lệnh sinh khóa RSA-2048 & `scripts.bootstrap_admin`, tách biệt lệnh kiểm thử `BE/.venv` (`50` tests BE) với `$env:WORKER_PYTHON` (`12` tests AI), và kiểm thử FE (`6` files, `45` tests).
- [P2-QA-acceptance.md](P2-QA-acceptance.md) — Báo cáo nghiệm thu này.

### 6.2. Giới hạn & ghi nhận kỹ thuật
1. **Hành vi `getpass.getpass()` trên Windows khi pipe stdin:** Python 3.13 stdlib `getpass.win_getpass()` kiểm tra `if sys.stdin is not sys.__stdin__` thay vì `sys.stdin.isatty()`, nên khi chạy trực tiếp từ terminal tương tác (`CONIN$`) hoạt động bình thường, còn nếu tự động hóa bằng stdin pipe cần wrap `sys.stdin` (như đã thực hiện trong kiểm thử E2E) để dùng `fallback_getpass`.
2. **Xung đột cổng `8000` trên máy kiểm thử:** Cổng `127.0.0.1:8000` vẫn đang được container ngoài dự án (`testdocker_app`) sử dụng, do đó kiểm thử live proxy P2 dùng `127.0.0.1:8001` cho `uvicorn` và cấu hình qua `FE/.env` tạm.
3. **Kiểm thử trình duyệt thực (Playwright multi-tab với Web Locks & Cookie thực):** Các kiểm thử phối hợp đa tab (`navigator.locks`, `BroadcastChannel`) và luồng UI P2 đã được xác minh qua Vitest + JSDOM và live HTTP proxy (`httpx`); kiểm thử Playwright trên trình duyệt Chromium thực cho toàn bộ luồng người dùng sẽ được tiếp tục ở P7 theo `docs/FE/07-testing.md`.
4. **Kế thừa gói AI trong `BE/.venv`:** Như đã ghi nhận từ P1-QA, `BE/.venv` sử dụng `--system-site-packages` để chạy được cả `BE/tests/ai` (`62/62`); môi trường chỉ cài `BE/requirements.txt` không `--system-site-packages` chỉ chạy được `50` tests BE (`unit` + `integration` + `contract`).
