# Báo cáo Nghiệm thu QA Độc lập — P3-QA (Bệnh nhân, Ca chụp, Upload NIfTI & Phân quyền File)

- **Ngày thực hiện:** 2026-11-17
- **Phạm vi:** Nghiệm thu độc lập **P3-QA** cho toàn bộ tính năng Phase P3:
  - Migration `0003_p3_patients_cases_volumes` (`patients`, `cases`, `case_create_idempotency_keys`, `stored_files`, `volumes`) với PostgreSQL partial unique index và check constraints.
  - Cấu trúc module Backend (`BE/app/models/{patient,case,stored_file,volume}.py`, `BE/app/schemas/{patient,case,volume}.py`, `BE/app/repositories/{patient_repo,case_repo,file_repo,volume_repo}.py`, `BE/app/services/{nifti_validator,file_cleanup_service,patient_service,case_service,volume_service}.py`, `BE/app/api/v1/{patients,cases,files}.py`).
  - Quy trình đồng bộ OpenAPI → TypeScript (`npm run generate:types`), khớp kiểu và ghép nối `FE/` ↔ `BE/`.
  - Kiểm thử toàn bộ BE suite (`unit`, `integration`, `contract`), lint `ruff`, và toàn bộ FE suite (`typecheck`, `vitest`, `build`).
- **Môi trường kiểm thử:**
  - OS: `Windows-11-10.0.26300-SP0`
  - Python: `3.13.5` (`BE/.venv`), Node.js `v22.23.2` / npm `10.9.8`
  - PostgreSQL: `postgres:16-alpine` container `braintumorsegmentation-postgres-1` (`healthy` trên `127.0.0.1:5432`)
- **Kết luận tổng quát:** **ĐẠT (PASS)** toàn bộ tiêu chí nghiệm thu **P3-QA**.

---

## 1. Migration, OpenAPI Contract & Đồng bộ BE ↔ FE

### 1.1. Kết quả kiểm tra Migration & OpenAPI
| Kiểm tra | Lệnh đã chạy | Exit code | Kết quả quan sát |
|---|---|---|---|
| Alembic upgrade (`bts_dev`) | `$env:DATABASE_URL="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"; BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini upgrade head` | `0` | Nâng cấp sạch từ `0002_p2_auth_and_accounts` → `0003_p3_patients_cases_volumes` |
| Alembic drift check (`bts_dev`) | `BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini check` | `0` | `No new upgrade operations detected.` |
| OpenAPI sync check | `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m scripts.export_openapi --check` | `0` | `BE/openapi/openapi.json` khớp 100% với FastAPI runtime schema |
| FE OpenAPI Typegen | `Push-Location FE; npm run generate:types; Pop-Location` | `0` | Sinh `FE/src/shared/api/schema.d.ts` (`127ms`, gồm cả `VolumeOut.filename`) |

### 1.2. Các điểm lệch hợp đồng & harden BE ↔ FE đã phát hiện và xử lý tại P3-QA
1. **Khớp kiểu trực tiếp với `components['schemas']` (`FE/src/shared/api/types.ts`):** Chuyển `PatientDto`, `PatientCreateRequest`, `PatientUpdateRequest`, `CaseDto`, `CaseCreateRequest`, `CaseUpdateRequest`, `VolumeDto`, `DeletionStatusOut` sang dẫn xuất trực tiếp từ `FE/src/shared/api/schema.d.ts`, sửa kiểm tra `payload.patient_code !== null` tại [fixtures.ts](../../FE/src/shared/api/fixtures.ts#L527), và trả thêm trường `filename` (đã làm sạch ký tự điều khiển / đường dẫn) trên `VolumeOut` để UI hiển thị tên tệp thay vì UUID.
2. **Trường khóa đầu vào (`CaseDetailPage.tsx`):** Backend trả `inputs_locked_at` (timestamp hoặc `null`) trong `CaseOut`; đã cập nhật [CaseDetailPage.tsx](../../FE/src/features/cases/CaseDetailPage.tsx#L128-L133) kiểm tra cả `inputs_locked_at` lẫn `is_inputs_locked`, `hasActiveJob`, `hasMaskVersions`.
3. **Truy vấn subcollection trước khi P4/P5 mở route (`FE/src/shared/api/endpoints.ts`):** Trong `fetchCaseDetail`, `/cases/{id}` và `/cases/{id}/volumes` là bắt buộc; các truy vấn `/cases/{id}/jobs` và `/cases/{id}/mask-versions` xử lý fallback rỗng khi server trả `404` để trang ca chụp P3 chạy trực tiếp với Backend P3 trước khi P4/P5 được triển khai (nhưng vẫn ném lỗi ngay nếu chính `/cases/{id}` trả `404`/`403`/`401` hoặc gặp lỗi `5xx`).
4. **Gia cố an toàn NIfTI, concurrency, multipart ingress, cleanup, PII & UI idempotency/deletion (sau 2 vòng Codex review):**
   - `nifti_validator.py`: kiểm tra `vox_offset` + `raw_voxel_bytes` so với dung lượng tệp và `max_decompressed_bytes` trước khi đọc dữ liệu voxel, và quét `np.isfinite` theo khối 3D bounded (`max_tile_elems = 1_048_576`) để chặn OOM/CPU blowup kể cả khi ảnh bị scale `float64` hoặc lệch tỷ lệ trục.
   - `main.py` & `config.py`: `MultipartIngressLimitMiddleware` (đặt trong `CORSMiddleware`) chặn cả `Content-Length` lẫn request stream/chunked vượt `MAX_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES` (`100 MiB + 1 MiB`) bằng `413 payload_too_large` trước khi Starlette spool tràn đĩa tạm.
   - `volume_service.py`, `case_service.py`, `patient_service.py`, `patient_repo.py`, `case_repo.py`: dùng row lock `FOR UPDATE` để tuần tự hóa `create_case` vs `delete_patient`, kiểm tra geometry anh em, kiểm tra lại trạng thái active/locked trước commit, và khóa xung đột upload vs delete; giải phóng transaction DB (`self.db.rollback()`) trước `await validate_and_stage_nifti_upload(...)` và dùng `committed_to_db` tránh xóa nhầm file sau commit; loại `patient_id`/`study_date` value khỏi `safe_diff` tạo ca (`case_created` chỉ ghi tên trường).
   - `storage.py`, `file_repo.py`, `file_cleanup_service.py`, `db.py`, `errors.py`: từ chối symlink trên `staging`/`objects` và đặt POSIX permissions `0o700`/`0o600`; khử PII ngay khi xóa (`patient_code`, `full_name`, `birth_year`, `sex`, `notes`, `study_date`, `original_name`); tính cả file `deleting` vào quota; dọn orphan object trong `objects_root`, chạy cleanup nền trong `_lifespan` và chốt `Case`/`Patient.deleted_at`; bật `hide_parameters=True` trong `create_db_engine` và chỉ log `error_class`/`sqlstate` cho `SQLAlchemyError`.
   - `BE/tests/unit/test_nifti_validator.py`: ghim `anyio_backend = "asyncio"` khớp `BE/requirements.txt` để mọi checkout sạch chạy tái lập 100%.
   - `CaseFormModal.tsx`, `PatientDetailPage.tsx`, `PatientsListPage.tsx`, `CaseDetailPage.tsx`, `patientsCases.ts`: giữ lại `pendingCreateAttempt` khi đóng/mở lại modal tạo ca sau lỗi `5xx`/mạng, bắt buộc đồng bộ danh sách ca & tick xác nhận trước khi sửa payload tạo key mới, và hiển thị phân biệt `DeletionStatusOut.status` (`deleted` vs `deleting`).

---

## 2. Kết quả Toàn bộ Test Suite, Lint & Build

| Hạng mục | Lệnh đã chạy | Exit code | Kết quả quan sát |
|---|---|---|---|
| BE Unit tests | `BE\.venv\Scripts\python.exe -m pytest BE/tests/unit -v` | `0` | **`31 passed, 1 warning in 3.56s`** (`asyncio`) |
| BE Integration tests | `BE\.venv\Scripts\python.exe -m pytest BE/tests/integration -v` | `0` | **`45 passed in 50.26s`** (PostgreSQL `bts_test`) |
| BE Contract tests | `BE\.venv\Scripts\python.exe -m pytest BE/tests/contract -v` | `0` | **`3 passed in 2.10s`** |
| Tổng Backend BE suite | `BE unit + integration + contract` | `0` | **`79 passed`** (`31` unit + `45` integration + `3` contract) |
| Backend Ruff lint | `BE\.venv\Scripts\ruff.exe check BE/app BE/scripts BE/migrations BE/tests/conftest.py BE/tests/unit BE/tests/integration BE/tests/contract` | `0` | `All checks passed!` |
| FE TypeScript strict check | `Push-Location FE; npm run typecheck; Pop-Location` | `0` | `tsc -b --noEmit` pass (`0` errors) |
| FE Unit & Component tests | `Push-Location FE; npm test -- --run; Pop-Location` | `0` | **`7 passed (7)` files, `52 passed (52)` tests trong `12.93s`** (`patientsAndCases`: `7`, `authAndSession`: `11`, `routingAndGuards`: `10`, `viewerAdapter`: `9`, `formatters`: `9`, `sharedUi`: `5`, `adminUsers`: `1`) |
| FE Production build | `Push-Location FE; npm run build; Pop-Location` | `0` | `tsc -b && vite build` thành công (`5.46s`) |

---

## 3. Đối chiếu Ma trận Ca kiểm thử P3 (`docs/AGENTS-AND-QA.md` & `docs/BE/02-patients-cases-files.md`)

| Mã ca | Tình huống | Bằng chứng kiểm chứng | Kết quả |
|---|---|---|---|
| `QA-ACL-01` | Bác sĩ A truy cập/tạo/sửa/xóa/tải patient, case, volume hoặc file của B; trùng `patient_code` khác bác sĩ | `test_qa_acl_01_02_patient_case_volume_and_file_ownership_isolation`: hai bác sĩ tạo cùng `patient_code` thành công (`201`), trùng trong cùng bác sĩ trả `409 patient_code_exists`; truy cập chéo trả `404` và không lộ dữ liệu (kể cả khi gửi `Idempotency-Key` sang hồ sơ bác sĩ khác); đổi `owner_id` trong body bị từ chối `422`. | **ĐẠT** |
| `QA-ACL-02` | Admin gọi endpoints bệnh nhân/ca/volume/file & không rò PII trong lỗi/log/audit/exception | `test_qa_acl_01_02_patient_case_volume_and_file_ownership_isolation` & `test_db_engine_hides_parameters_and_errors_never_log_sql_detail`: tài khoản admin nhận `403 forbidden` trên danh sách/chi tiết/thao tác `/patients`, `/cases`, `/cases/{id}/volumes`, `/files/{id}/content`, phản hồi lỗi, log & mọi cột `AuditEvent` không chứa PII; SQLAlchemy `hide_parameters=True` và exception handler không rò `DETAIL`. | **ĐẠT** |
| `QA-CASE-01` | Tạo ca với `Idempotency-Key`, đua đồng thời & ca đã xóa | `test_qa_case_01_idempotency_concurrency_conflict_and_deleted_case` (dùng `threading.Barrier(2)` trên PostgreSQL thật): hai request đồng thời tạo đúng 1 ca; replay cùng key+nội dung trả `201` cùng ID; khác nội dung trả `409 idempotency_conflict`; sau xóa ca replay cùng key+nội dung trả `409 case_deleted` không tạo lại ca. FE `patientsAndCases.test.tsx`: giữ nguyên `Idempotency-Key` khi retry sau `5xx` (kể cả sau khi đóng/mở lại modal), bắt buộc đối soát & xác nhận trước khi sửa payload tạo key mới, và xử lý `409 idempotency_conflict` / `case_deleted`. | **ĐẠT** |
| `QA-FILE-01` | Extension giả, file rỗng/cắt cụt, 4D, complex/RGB, `NaN`/`Inf`, thiếu/mâu thuẫn `qform`/`sform`, affine suy biến, header phóng đại dim & scaled tile | `BE/tests/unit/test_nifti_validator.py` (`test_rejects_forged_giant_dim_header_without_oom`, `test_tiled_isfinite_handles_skewed_scaled_nifti`) & `test_qa_file_01_http_rejects_bad_uploads_cleanly` (qua HTTP trả `422`, staging rỗng, không đổi readiness); FE cảnh báo file `_seg` và từ chối định dạng/dung lượng sai trước khi gửi. | **ĐẠT** |
| `QA-FILE-02` | Giới hạn upload `100 MiB` thật, ingress multipart `> 101 MiB`, giải nén tối đa `256 MiB` & quota atomic (gồm file `deleting`) | `test_100_mib_exact_boundary_and_multipart_ingress_limit` (đúng `104,857,600` bytes pass `201`, `104,857,601` bytes và chunked stream / `Content-Length` `> 101 MiB` trả `413`), `test_enforces_streaming_upload_limit_and_decompression_bomb_limit`, `test_qa_file_03_atomic_quota_exhaustion_under_concurrency` (`Barrier(2)` → `1 × 201` + `1 × 413`) & `test_pii_redaction_deleting_quota_and_orphan_finalization`. | **ĐẠT** |
| `QA-FILE-03` | Hai xung cùng shape nhưng lệch spacing/affine (`> 1e-4 mm`), đua đồng thời cùng case, hoặc volume ngoài profile AI `(240,240,155)` | `test_geometry_compatibility_checks`, `test_qa_file_03_same_shape_affine_and_spacing_mismatch_via_http` (2 xung cùng shape `16×16×16` lệch affine hoặc lệch spacing qua HTTP đều trả `422 geometry_mismatch`, sạch staging, `can_run_inference=false`) & `test_concurrent_sibling_geometry_mismatch_and_upload_vs_delete_race` (`Barrier(2)` hai upload lệch geometry đồng thời chỉ cho phép đúng 1 `201` + 1 `422`); FE `patientsAndCases.test.tsx` cho phép mở Viewer khi có `>= 1` xung hợp lệ và khóa nút AI với lý do từ BE. | **ĐẠT** |
| `QA-FILE-04` | Path traversal, symlink guard, download security, cleanup orphan object & nền | `LocalStorageAdapter` + `_checked_subdir` + `test_rejects_symlinked_staging_or_objects_subdirs`: từ chối symlink `staging`/`objects`, file upload `../../evil` nằm gọn trong `objects_root`, `Content-Disposition` dùng `volume-<uuid>.nii(.gz)`, `VolumeOut.filename` sạch; `test_orphan_and_deleting_cleanup_is_idempotent` dọn staging, file `deleting`, orphan object & chốt `Case`/`Patient.deleted_at`. | **ĐẠT** |
| `QA-OPS-01` | Khóa đầu vào sau khi có job/mask, quy tắc xóa khi có active job, khử PII & race đồng thời | `test_qa_ops_01_active_job_blocks_case_and_patient_deletion` (`409 active_job_conflict` với cả `queued` và `running`), `test_qa_file_volume_lifecycle_geometry_mismatch_and_ops_lock` (`409 inputs_locked`), `test_pii_redaction_deleting_quota_and_orphan_finalization`, `test_create_case_vs_delete_patient_concurrent_race`, `test_concurrent_sibling_geometry_mismatch_and_upload_vs_delete_race` & FE `patientsAndCases.test.tsx`. | **ĐẠT** |

---

## 4. Ghi nhận & Bước tiếp theo
- Đã cập nhật [README.md](../../README.md) với migration `0003_p3_patients_cases_volumes`, danh sách module P3, và số lượng kiểm thử mới (`79` BE tests, `12` AI tests, `52` FE tests).
- Sau khi vòng review song song 4 góc của **Codex CLI (`gpt-6-luna` `xhigh`)** cho P3 đạt chuẩn, chuyển ngay sang triển khai song song **P4 (`P4-BE` + `P4-FE`)** cho Viewer & Manual Mask Editor.
