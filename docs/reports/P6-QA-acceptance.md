# Báo cáo Nghiệm thu QA — P6-QA (Admin Operations, Cấu hình Optimistic Lock, Audit & In Báo cáo Mask)

- **Ngày thực hiện:** 2026-11-18
- **Phạm vi:** Migration `0006_p6_admin_settings` (seed `admin_settings` allowlist); BE `AdminOperationsService` & `admin_operations.py` (`GET /api/v1/admin/overview`, `GET /api/v1/admin/jobs`, `GET /api/v1/admin/jobs/{job_id}`, `POST /api/v1/admin/jobs/{job_id}/retry`, `GET /api/v1/admin/workers`, `GET /api/v1/admin/models`, `GET/PATCH /api/v1/admin/settings`, `GET /api/v1/admin/audit-events`); FE `AdminOverviewPage.tsx`, `AdminJobsPage.tsx`, `AdminSettingsPage.tsx`, và báo cáo in theo phiên bản chọn trong `ViewerWorkspacePage.tsx` + `FE/src/index.css` (`@media print`).
- **Môi trường:** Windows, Python `3.13.5` (`BE/.venv`), Node `v22.23.2`, PostgreSQL `postgres:16-alpine` (`braintumorsegmentation-postgres-1`, `127.0.0.1:5432`).

## 1. Kiểm tra Hợp đồng & Quy tắc An toàn Dữ liệu P6

| Kiểm tra | Cơ chế & Kết quả quan sát |
|---|---|
| Optimistic locking `PATCH /api/v1/admin/settings` | `AdminSettingsUpdate` đặt `extra="forbid"` (loại `updated_at`, trả `422` nếu thừa trường); tăng `version` nguyên tử dưới row lock `FOR UPDATE`, gửi version cũ trả `409 settings_version_conflict` |
| Cô lập PII tuyệt đối trên API/Audit Admin | `/admin/overview`, `/admin/jobs`, `/admin/jobs/{job_id}`, `/admin/workers`, `/admin/models`, `/admin/audit-events` chỉ trả metadata kỹ thuật (`job_id`, `case_id`, `doctor_username`, `attempt_number`, `worker_id`, `error_code`), không chứa `full_name`, ghi chú lâm sàng, đường dẫn storage nội bộ hoặc file tải |
| Điều kiện retry job thất bại | `POST /api/v1/admin/jobs/{job_id}/retry` kiểm tra trạng thái `failed`, `accepting_jobs` (`503 not_accepting_jobs`), bác sĩ sở hữu đang active (`409 retry_owner_inactive` khi bị khóa), đầu vào hợp lệ và không có job active (`409 active_job_conflict`) |
| Bản in báo cáo FE theo đúng phiên bản | `ViewerWorkspacePage.tsx` (`data-print-report="mask-version"`) đọc thông số trực tiếp của `selectedVersion` đang chọn (hỗ trợ mở `?version=<mask_version_id>`), bảo vệ bản nháp dirty bằng `DirtyPrintModal`, ẩn navigation/toolbars trong `@media print` |

## 2. Kết quả Test suite, Lint & Build (tại P6-QA)

| Hạng mục | Kết quả quan sát |
|---|---|
| `ruff check` (`BE/app BE/scripts BE/migrations BE/worker/service.py BE/tests/...`) | `All checks passed!` |
| `export_openapi --check` | exit `0` |
| BE unit / integration / contract | `35` unit (`5.82s`) + `62` integration (`114.05s`) + `3` contract (`5.60s`) = **`100 passed`** |
| FE `tsc -b --noEmit` | exit `0` |
| FE `vitest --run` | `9 passed (9)` files, `73 passed (73)` tests trong `23.30s` |
| FE `vite build` | exit `0` (`built in 7.54s`) |

## 3. Đối chiếu Ca kiểm thử P6 (`docs/AGENTS-AND-QA.md` & `docs/BE/05-admin-operations.md`)

| Mã ca | Bằng chứng kiểm chứng | Kết quả |
|---|---|---|
| `QA-ACL-01` / `QA-ACL-02` | BE `test_qa_acl_01_and_02_role_and_ownership_boundaries` & `test_admin_job_listing_and_audit_do_not_expose_patient_clinical_content`: phân tách chặt quyền bác sĩ / admin / internal worker (`401`/`403`/`404`), admin không truy cập được tệp/nội dung bệnh nhân và search `ILIKE` escape `%`/`_` an toàn | **ĐẠT** |
| Optimistic Settings & Admin Retry | BE `test_worker_token_is_required_and_admin_settings_use_optimistic_version` & `test_qa_job_05_fail_job_admin_detail_retry_owner_inactive_and_intake_paused`; FE `jobsAndAdminOps.test.tsx` (`AdminOverviewPage`, `AdminJobsPage` xem attempts không PII + `409 retry_owner_inactive` + `503 not_accepting_jobs` + retry `202`, `AdminSettingsPage` lưu tăng version & refetch khi `409`) | **ĐẠT** |
| `QA-OPS-03` | FE `jobsAndAdminOps.test.tsx`: mở `?version=v1` (khác latest `v2`) chọn đúng `v1`, khối `[data-print-report="mask-version"]` hiển thị đúng thông số/nhãn/ghi chú của `v1` (không lẫn `v2`) và gọi `window.print()`, đồng thời chặn trộn bản nháp dirty | **ĐẠT** |

- **Review 4 góc (`Gemini 4 Argon High` trên `/swarm`):** `rev-code`, `rev-security`, `rev-tests` đạt `REVIEW: PASS`; `rev-docs` xác nhận báo cáo khớp thực tế và chỉ ra 3 dòng tóm tắt đầu `README.md` chưa cập nhật số liệu P5/P6 (đã cập nhật đầy đủ).
