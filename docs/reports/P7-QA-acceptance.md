# Báo cáo Nghiệm thu QA & Phát hành Cục bộ v1 — P7-QA (End-to-End, Bảo mật, Phục hồi Dữ liệu, Hiệu năng & Bàn giao)

- **Ngày thực hiện:** 2026-11-18
- **Phạm vi:** Nghiệm thu tổng thể **P7** cho bản phát hành cục bộ **v1** (bao gồm kết quả tích hợp **P0–P6**):
  - Kiểm thử E2E trình duyệt Desktop Chrome thật trên live stack (`FastAPI` + `PostgreSQL` + `Vite` proxy + `deterministic_fake_worker` qua [`run_p7_e2e_stack.py`](../../BE/scripts/run_p7_e2e_stack.py) và [`p7-acceptance.spec.ts`](../../FE/e2e/p7-acceptance.spec.ts)).
  - Kiểm thử hồi quy BE toàn diện (cô lập quyền sở hữu/vai trò, xoay/thu hồi refresh token, xung đột đồng thời, mất lưu trữ nguyên tử, dọn orphan, khôi phục qua restart) trong [`test_p7_release_acceptance.py`](../../BE/tests/integration/test_p7_release_acceptance.py).
  - Kiểm chứng chu kỳ migration Alembic sạch 18 bảng (`upgrade head -> downgrade base -> upgrade head` trên `bts_test`) trong [`test_migrations_postgres.py`](../../BE/tests/integration/test_migrations_postgres.py).
  - Kiểm chứng sao lưu & phục hồi cô lập PostgreSQL + Private Flat Storage (`pg_dump`/`pg_restore`, kiểm tra SHA-256, thu hồi session/refresh token cũ) qua [`backup_restore.py`](../../BE/scripts/backup_restore.py).
  - Kiểm tra khóa phụ thuộc, biến môi trường mẫu an toàn, quy tắc `.gitignore` và vệ sinh Git trong [`test_repo_hygiene.py`](../../BE/tests/contract/test_repo_hygiene.py).
  - Chạy **AI thật 155 lát** trên checkpoint `best.pt` qua HTTP + PostgreSQL thật ([`run_p7_real_ai_smoke.py`](../../BE/scripts/run_p7_real_ai_smoke.py) & [`test_p7_real_worker_e2e.py`](../../BE/tests/ai/test_p7_real_worker_e2e.py)) kèm benchmark từng giai đoạn.
  - Hoàn thiện tài liệu vận hành ([`README.md`](../../README.md)) và bảng kiểm triển khai ([`IMPLEMENTATION-CHECKLIST.md`](../IMPLEMENTATION-CHECKLIST.md)).
- **Kết luận tổng quát:** **ĐẠT (PASS)** — **`0` lỗi chặn phát hành** (`0` open release blockers).

---

## 1. Môi trường & Phiên bản đã Kiểm chứng

| Thành phần | Giá trị quan sát thực tế |
|---|---|
| Hệ điều hành | Windows 11 (`Windows-11-10.0.26300-SP0`) |
| CPU & RAM | `Intel64 Family 6 Model 154 Stepping 3, GenuineIntel` (`16` logical cores), `15.68 GB` RAM |
| PyTorch / GPU | `torch 2.8.0+cpu` (`CUDA available: False`) |
| Python Runtime | `3.13.5` (`BE/.venv` cho FastAPI/tests; `D:\Nam4\Ky1\PBL6\.venv` cho AI worker & PyTorch/GUDHI) |
| Node.js / npm | `v22.23.2` / `10.9.8` |
| PostgreSQL & Dump Tools | `postgres:16-alpine` (container `braintumorsegmentation-postgres-1`, `127.0.0.1:5432`), `pg_dump` / `pg_restore 16.16` qua Docker |
| Browser E2E | Desktop Google Chrome `157.0.8103.79` (`@playwright/test 1.65.1`, `channel: 'chrome'`) |
| Alembic Head (`bts_dev`) | `0006_p6_admin_settings (head)` (`18` bảng) |

---

## 2. Lỗi Chặn Phát hiện & Đã Khắc phục trong P7

| Thành phần | Hiện tượng trước sửa | Khắc phục & Xác minh |
|---|---|---|
| [`WorkerClient.download`](../../BE/worker/service.py#L44-L73) (`BE/worker/service.py`) | Gọi `with self.client.send(response, stream=True) as streamed:` gây ngoại lệ `TypeError: 'Response' object does not support the context manager protocol` khi worker thật tải tệp NIfTI qua HTTP. | Sửa thành `with self.client.stream("GET", f"{self.base_url}/files/{file_id}/content", headers={...}) as streamed:` kèm streaming `iter_bytes(65536)` và đối chiếu `hmac.compare_digest` SHA-256. Đã xác minh pass qua [`test_p7_real_worker_e2e_full_155_slices`](../../BE/tests/ai/test_p7_real_worker_e2e.py#L90-L139) và [`run_p7_real_ai_smoke.py`](../../BE/scripts/run_p7_real_ai_smoke.py). |

---

## 3. Bảng Tổng hợp Lệnh Kiểm tra & Kết quả Quan sát

> **Lưu ý tách biệt hai loại E2E:** Bộ Playwright Chromium (`npm run test:e2e`) kiểm chứng toàn bộ UI + FastAPI + PostgreSQL (`bts_e2e_test`) + Vite proxy bằng `deterministic_fake_worker` (mask xác định không chạy TDA/CNN nặng để tránh timeout UI). Năng lực suy luận **AI thật 155 lát** trên checkpoint `best.pt` được kiểm chứng độc lập qua `run_p7_real_ai_smoke.py` và `test_p7_real_worker_e2e_full_155_slices`.

| Nhóm kiểm tra | Lệnh thực thi | Exit code | Kết quả quan sát chính xác |
|---|---|---|---|
| Alembic Drift Check (`bts_dev`) | `alembic -c BE/alembic.ini check` | `0` | `0006_p6_admin_settings (head)`, `No new upgrade operations detected.` |
| OpenAPI Deterministic Check | `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m scripts.export_openapi --check` | `0` | Exit `0`, khớp 100% giữa FastAPI runtime và [`openapi.json`](../../BE/openapi/openapi.json). |
| Python Lint (`ruff`) | `BE\.venv\Scripts\ruff.exe check BE/app BE/scripts BE/migrations BE/worker/service.py BE/tests/conftest.py BE/tests/unit BE/tests/integration BE/tests/contract BE/tests/ai/test_p7_real_worker_e2e.py` | `0` | `All checks passed!` |
| Backend Pytest (`BE/.venv`) | `BE\.venv\Scripts\python.exe -m pytest BE/tests/unit BE/tests/integration BE/tests/contract -v` | `0` | **`108 passed in 206.88s (0:03:26)`** (`35` unit + `66` integration + `7` contract; collected counts: `35` unit, `66` integration, `7` contract). |
| AI Adapter & Real Worker E2E (`PBL6/.venv`) | `D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe -m pytest BE/tests/ai -v` | `0` | **`13 passed in 59.80s`** (`12` P0 adapter tests + `1` P7 real 155-slice worker HTTP/PostgreSQL E2E `test_p7_real_worker_e2e_full_155_slices`). |
| **Tổng Python Tests (BE + AI)** | Tổng hợp `BE/tests/{unit,integration,contract,ai}` | `0` | **`121 passed`** (`108` BE + `13` AI). |
| Real AI Smoke & CPU Benchmark | `& "D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe" BE/scripts/run_p7_real_ai_smoke.py` | `0` | Chạy thật `BraTS20_Training_001` (`best.pt`, `tda-seg-unet:cce-dice-ep136`) qua HTTP + PostgreSQL (`bts_ai_smoke_test`); end-to-end `19,672.634 ms`, Peak RSS `781.957 MB`, zero PII/path leaks (chi tiết mục 5). |
| FE TypeScript Strict Check | `npm run typecheck` (`tsc -b --noEmit` trong `FE/`) | `0` | Exit `0` (`0` lỗi type). |
| FE Unit & Component Tests | `npm test -- --run` (Vitest `3.2.7` trong `FE/`) | `0` | **`10 passed (10)` files, `76 passed (76)` tests in `25.99s`** (bao gồm [`p7ResponsiveAndHygiene.test.tsx`](../../FE/src/test/p7ResponsiveAndHygiene.test.tsx): `3 tests`). |
| FE Production Build | `npm run build` (`tsc -b && vite build` trong `FE/`) | `0` | Exit `0`, **`built in 6.41s`**. |
| FE Playwright Chromium E2E (`deterministic_fake_worker`) | `npm run test:e2e` (Chrome `157.0.8103.79` trong `FE/`) | `0` | **`4 passed (1.4m)`** trên live FastAPI + PostgreSQL `bts_e2e_test` + Vite proxy + `deterministic_fake_worker`. |

### Chi tiết 4 kịch bản Playwright E2E (`FE/e2e/p7-acceptance.spec.ts`)

| # | Kịch bản kiểm thử (`p7-acceptance.spec.ts`) | Thời gian | Nội dung xác minh trên Desktop Chrome |
|---|---|---|---|
| 1 | `1. Full Doctor & Admin E2E Lifecycle + Axial Edit + Undo/Redo + Save + Reload + NIfTI Export Verification` | `32.4s` | Admin tạo Doctor A (mật khẩu tạm hiển thị 1 lần) → Doctor A đổi mật khẩu bắt buộc & đăng nhập lại → tạo bệnh nhân + ca chụp → upload FLAIR/T1ce → gửi job AI (xác nhận `deterministic_fake_worker` hoàn tất) → mở Viewer tại lát `78/155` → tô brush trên canvas axial → Undo/Redo → lưu `v2 · Thủ công` → navigate/reload sạch vẫn nạp `v2` → xuất `.nii.gz` dùng tên kỹ thuật không PII (`sizeofHdr=348`, `dim=[3,240,240,155]`, `uint8`, `srowXNonZero=true`, `uniqueLabels` chứa `{0,1,2,4}`). |
| 2 | `2. QA-ACL-01, QA-ACL-02, QA-AUTH-05 — Negative Ownership, Role Isolation & Zero PII` | `6.2s` | Doctor B truy cập URL bệnh nhân/ca/viewer của Doctor A bị chặn không lộ PII; Admin xem `/admin`, `/admin/jobs`, `/admin/audit-events` không thấy bất kỳ mã/họ tên/ghi chú bệnh nhân nào; Admin mở route lâm sàng `/doctor/cases/...` bị chuyển hướng `/403` không lộ PII. |
| 3 | `3. P6 Admin Job Retry + QA-AUTH-04 Live Session Revocation When Admin Locks Doctor A` | `22.5s` | Doctor A mở sẵn phiên làm việc → Admin lọc job `failed` và thực hiện **Gửi lại** tạo job mới chạy tới `Hoàn tất` → Admin khóa tài khoản Doctor A → Doctor A thao tác tiếp ngay lập tức bị thu hồi phiên về `/login` (`Tài khoản đã bị khóa`, không còn PII trên DOM) và bị từ chối đăng nhập lại. |
| 4 | `4. Responsive Desktop 1920/1440/1024 vs Narrow Read-Only 768/375 & Keyboard Escape` | `4.7s` | Tại `1920×1080`, `1440×900`, `1024×768`: nút **Tô mask** bật, không tràn ngang (`overflow <= 0`); tại `768×1024` và `375×812`: **Tô mask** bị khóa (`Chỉnh sửa mask đang tạm khóa`), điều hướng lát vẫn hoạt động và không tràn ngang; tại `1280×800`: phím `Escape` đóng modal bệnh nhân sạch. |

---

## 4. Ma trận Nghiệm thu Toàn bộ v1 (`docs/AGENTS-AND-QA.md`)

| Mã ca | Tình huống kiểm thử | Bằng chứng kiểm chứng (Backend / AI / Frontend / E2E) | Kết quả |
|---|---|---|---|
| `QA-AUTH-01` | JWT hết hạn / sai chữ ký / sai `alg` / `aud` / `iss` / `kid` lạ | BE `test_qa_auth_01_protected_endpoint_rejects_bad_bearer_tokens_with_distinct_codes`, `test_access_jwt_claims_jwk_verification_and_qa_auth_01_rejections`, và [`test_p7_security_refresh_reuse_mid_save_expiry_conflict_and_orphan_cleanup`](../../BE/tests/integration/test_p7_release_acceptance.py#L530-L588) (`token_expired` khi JWT/session hết hạn). | **ĐẠT** |
| `QA-AUTH-02` | Dùng lại refresh token đã rotate & đua đồng thời | BE `test_qa_auth_02_*` ([báo cáo P2](P2-QA-acceptance.md)) & [`test_p7_security_refresh_reuse_mid_save_expiry_conflict_and_orphan_cleanup`](../../BE/tests/integration/test_p7_release_acceptance.py#L546-L560) (`refresh_reused` thu hồi cả gia đình token, access/refresh kế nhiệm đều `401`). | **ĐẠT** |
| `QA-AUTH-03` | Nhiều GET hết access token đồng thời | FE [`authAndSession.test.tsx`](../../FE/src/test/authAndSession.test.tsx): 10 GET `401` đồng thời gom thành đúng **1** `POST /auth/refresh` và retry tối đa 1 lần; mutation không tự replay mù. | **ĐẠT** |
| `QA-AUTH-04` | Admin khóa bác sĩ đang mở phiên/viewer | BE [`test_p7_full_doctor_and_admin_e2e_lifecycle`](../../BE/tests/integration/test_p7_release_acceptance.py#L519-L527) (`401 account_disabled` tức thì); E2E [`p7-acceptance.spec.ts` #3](../../FE/e2e/p7-acceptance.spec.ts#L455-L482); FE `authAndSession.test.tsx`. | **ĐẠT** |
| `QA-AUTH-05` | Đổi account / logout khi request cũ chưa xong | FE `authAndSession.test.tsx` & `routingAndGuards.test.tsx` (session epoch, xóa cache & `blob:` URL, reset viewer store); E2E [`p7-acceptance.spec.ts` #2 & #3](../../FE/e2e/p7-acceptance.spec.ts#L346-L482) xác nhận zero PII giữa các phiên. | **ĐẠT** |
| `QA-ACL-01` | Doctor A truy cập patient/case/job/version/file của Doctor B | BE [`test_p7_full_doctor_and_admin_e2e_lifecycle`](../../BE/tests/integration/test_p7_release_acceptance.py#L310-L318) & `test_qa_acl_01_02_patient_case_volume_and_file_ownership_isolation` (`404`, không lộ dữ liệu); E2E [`p7-acceptance.spec.ts` #2](../../FE/e2e/p7-acceptance.spec.ts#L354-L369). | **ĐẠT** |
| `QA-ACL-02` | Admin gọi API lâm sàng & không PII trong admin UI/API/audit/logs | BE [`test_p7_full_doctor_and_admin_e2e_lifecycle`](../../BE/tests/integration/test_p7_release_acceptance.py#L319-L321) (`403` hai chiều, zero PII trên `/admin/overview`, `/admin/jobs`, `/admin/audit-events`), `test_admin_job_listing_and_audit_do_not_expose_patient_clinical_content`; E2E [`p7-acceptance.spec.ts` #2](../../FE/e2e/p7-acceptance.spec.ts#L372-L392). | **ĐẠT** |
| `QA-FILE-01` | Extension giả, NIfTI hỏng/cắt cụt, 4D, `NaN`/`Inf`, phóng đại header | BE `test_nifti_validator.py` (`test_rejects_forged_giant_dim_header_without_oom`, `test_tiled_isfinite_handles_skewed_scaled_nifti`) & `test_qa_file_01_http_rejects_bad_uploads_cleanly` (`422`, sạch staging); FE `patientsAndCases.test.tsx`. | **ĐẠT** |
| `QA-FILE-02` | Vượt giới hạn upload `100 MiB`, giải nén `256 MiB` & quota | BE `test_100_mib_exact_boundary_and_multipart_ingress_limit`, `test_enforces_streaming_upload_limit_and_decompression_bomb_limit`, `test_qa_file_03_atomic_quota_exhaustion_under_concurrency` (`413`). | **ĐẠT** |
| `QA-FILE-03` | Hai volume cùng shape nhưng lệch affine/spacing | BE `test_geometry_compatibility_checks`, `test_qa_file_03_same_shape_affine_and_spacing_mismatch_via_http`, `test_concurrent_sibling_geometry_mismatch_and_upload_vs_delete_race` (`422 geometry_mismatch`, `can_run_inference=false`). | **ĐẠT** |
| `QA-FILE-04` | Tên file chứa traversal/control chars & symlink guard | BE `LocalStorageAdapter`, `test_rejects_symlinked_staging_or_objects_subdirs`, `test_orphan_and_deleting_cleanup_is_idempotent`, và `run_orphan_cleanup` trong [`test_p7_security_refresh_reuse_mid_save_expiry_conflict_and_orphan_cleanup`](../../BE/tests/integration/test_p7_release_acceptance.py#L726-L741). | **ĐẠT** |
| `QA-CASE-01` | Tạo ca với `Idempotency-Key`, gửi lại đồng thời & sau khi xóa | BE `test_qa_case_01_idempotency_concurrency_conflict_and_deleted_case` (`Barrier(2)`, `201` tái sử dụng vs `409 idempotency_conflict` / `case_deleted`); FE `patientsAndCases.test.tsx`. | **ĐẠT** |
| `QA-AI-01` | Inference thật chỉ dùng FLAIR + T1ce (không `_seg`, T1, T2) | AI `test_p0_adapter.py::test_qa_ai_01_inference_without_seg_t1_t2`, [`test_p7_real_worker_e2e_full_155_slices`](../../BE/tests/ai/test_p7_real_worker_e2e.py#L90-L139) & [`run_p7_real_ai_smoke.py`](../../BE/scripts/run_p7_real_ai_smoke.py) (thư mục đầu vào cô lập chỉ gồm 2 file FLAIR + T1ce). | **ĐẠT** |
| `QA-AI-02` | Crop sát 4 biên, lát trống & chống negative wrapping | AI `test_p0_adapter.py::test_qa_ai_02_crop_clamping_all_four_edges_and_restore` & `test_qa_ai_02_empty_slice_tda_and_corner_hotspot_adapter`. | **ĐẠT** |
| `QA-AI-03` | Nhãn raw `{0,1,2,4}`, dtype `uint8`, affine & coverage metadata | AI `test_p0_adapter.py::test_qa_ai_03_labels_dtype_nifti_roundtrip_and_coverage` & [`test_p7_real_worker_e2e_full_155_slices`](../../BE/tests/ai/test_p7_real_worker_e2e.py#L118-L133) (`unevaluated_outside_crop: true`, `affine_match=True`, `spacing_match=True`). | **ĐẠT** |
| `QA-MASK-01` | Volume landmark bất đối xứng (trái/phải & click-to-voxel) | BE `test_qa_mask_01_single_t1ce_locks_reference_and_asymmetric_roundtrip`; FE [`viewerMaskEditor.test.tsx`](../../FE/src/test/viewerMaskEditor.test.tsx) (`QA-MASK-01`). | **ĐẠT** |
| `QA-MASK-02` | Edit lát `k`, chuyển lát `k+1` không làm rò edits | BE `test_qa_mask_02_rejects_invalid_labels_geometry_and_headers`; FE `viewerMaskEditor.test.tsx` (`QA-MASK-02` chỉ pane axial editable). | **ĐẠT** |
| `QA-MASK-03` | Stroke → Undo → Redo → Save → Export → Reload | BE [`test_p7_full_doctor_and_admin_e2e_lifecycle`](../../BE/tests/integration/test_p7_release_acceptance.py#L402-L446) & `test_qa_mask_03_*`; FE `viewerMaskEditor.test.tsx`; E2E [`p7-acceptance.spec.ts` #1](../../FE/e2e/p7-acceptance.spec.ts#L259-L343). | **ĐẠT** |
| `QA-MASK-04` | Hai tab/request save cùng `base_version_id` | BE [`test_p7_security_refresh_reuse_mid_save_expiry_conflict_and_orphan_cleanup`](../../BE/tests/integration/test_p7_release_acceptance.py#L634-L660) (`Barrier(2)`: `[201, 409 mask_version_conflict]`); FE `viewerMaskEditor.test.tsx`. | **ĐẠT** |
| `QA-MASK-05` | Save lỗi mạng / hết phiên / resize hẹp khi dirty | FE `viewerMaskEditor.test.tsx` (`409` & `503` giữ nguyên draft, retry cùng `Idempotency-Key`) & [`p7ResponsiveAndHygiene.test.tsx`](../../FE/src/test/p7ResponsiveAndHygiene.test.tsx#L184-L239) (resize `1440 -> 768` khi `isDirty=true` không auto-commit). | **ĐẠT** |
| `QA-MASK-06` | AI hoàn tất khi có bản thủ công / bản nháp | BE `test_qa_job_04_and_qa_mask_06_complete_preserves_manual_mask_rejects_bad_data_and_replays`; FE `jobsAndAdminOps.test.tsx` (giữ draft, thông báo `"Có kết quả AI mới"`). | **ĐẠT** |
| `QA-JOB-01` | Double-click / cùng `Idempotency-Key` khi tạo job | BE `test_doctor_job_idempotency_active_conflict_and_worker_claim`; FE [`jobsAndAdminOps.test.tsx`](../../FE/src/test/jobsAndAdminOps.test.tsx) (`QA-JOB-01` single pending request, cancel/polling 3s). | **ĐẠT** |
| `QA-JOB-02` | Hai worker claim cùng lúc trên PostgreSQL | BE `test_qa_job_02_concurrent_workers_claim_only_one_wins` (`Barrier(2)` + `FOR UPDATE SKIP LOCKED`: đúng 1 worker nhận job). | **ĐẠT** |
| `QA-JOB-03` | Worker chết, reaper hết hạn lease & complete muộn `409` | BE [`test_p7_security_refresh_reuse_mid_save_expiry_conflict_and_orphan_cleanup`](../../BE/tests/integration/test_p7_release_acceptance.py#L662-L725) (`reap_expired_attempts`, `409 stale_attempt`, lần 2 chuyển `failed` `worker_lost`). | **ĐẠT** |
| `QA-JOB-04` | Storage write fail lúc `/complete` (atomicity) | BE [`test_p7_restart_persistence_and_storage_failure_atomicity`](../../BE/tests/integration/test_p7_release_acceptance.py#L808-L881) (giả lập `OSError` lúc `commit`: trả `500`, job giữ `running`, không lưu file/mask nửa vời; lần complete sạch + restart app đọc lại đúng SHA-256). | **ĐẠT** |
| `QA-JOB-05` | Retry quá budget / lỗi input & Admin retry | BE `test_qa_job_05_fail_job_admin_detail_retry_owner_inactive_and_intake_paused`; E2E [`p7-acceptance.spec.ts` #3](../../FE/e2e/p7-acceptance.spec.ts#L418-L453). | **ĐẠT** |
| `QA-OPS-01` | Xóa ca/bệnh nhân khi có job active | BE `test_qa_ops_01_active_job_blocks_case_and_patient_deletion` (`409 active_job_conflict` cho cả `queued` và `running`). | **ĐẠT** |
| `QA-OPS-02` | Backup DB + storage & restore vào môi trường cô lập | BE [`test_qa_ops_02_backup_and_isolated_restore_preserves_checksums_and_revokes_sessions`](../../BE/tests/integration/test_p7_release_acceptance.py#L884-L1106) (chi tiết mục 6). | **ĐẠT** |
| `QA-OPS-03` | In summary đúng phiên bản chọn (khác latest) | FE `jobsAndAdminOps.test.tsx` (`?version=v1` khi `v2` là latest: `[data-print-report="mask-version"]` hiển thị đúng số liệu `v1`, chặn trộn bản nháp dirty). | **ĐẠT** |

---

## 5. Benchmark Real AI Worker 155 Lát trên HTTP + PostgreSQL (`run_p7_real_ai_smoke.py`)

### 5.1. Dữ liệu, Checkpoint & Checksum xác minh

- **Lệnh thực thi:** `& "D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe" BE/scripts/run_p7_real_ai_smoke.py`
- **Mô hình & Pipeline:** `tda-seg-unet:cce-dice-ep136`, pipeline `tda-segunet-2d-v1`, checkpoint `best.pt` (SHA-256 `6ec9edc3b0d75474d8d8d427e8d962b6f7fabff1d2aab08ad972b08775413d3f`).
- **Ca kiểm chứng:** `BraTS20_Training_001` (sao chép sang thư mục tạm cô lập **chỉ chứa** FLAIR và T1ce; không có `_seg`, `_t1`, `_t2`).
- **`flair_sha256`:** `1671dfab75fbaaede29989011cabcef12b7825c72a315f293441b698a8e8d39c`
- **`t1ce_sha256`:** `ed3732f26987226748147562cc64e58958564a6a7e47611b726773fd4e057b99`
- **`output_mask_sha256`:** `9eba359abb45ce797f4c9b1f09255f6b548b6194a5be54ac0c87d8bc19814df5` (`31,568` bytes `.nii.gz`)

### 5.2. Thời gian từng Giai đoạn & Bộ nhớ (CPU)

| Chỉ số đo | Giá trị đo được | Ghi chú |
|---|---|---|
| Nạp trước model (`model_preload_ms`) | **`373.964 ms`** | Tăng RSS **`+40.469 MB`** (`InferenceWorker` nạp 1 lần khi khởi động) |
| Giai đoạn `load` | `148.823 ms` | Đọc & kiểm tra hình học FLAIR/T1ce |
| Giai đoạn `preprocess` | `1388.115 ms` | Z-score volume & định tâm crop `128×128` 155 lát |
| Giai đoạn `tda` | **`14132.389 ms`** | **Nút thắt CPU (~`72%` tổng thời gian E2E `14,132.389 / 19,672.634 ms`)** — tính 4 kênh Persistence Image qua `gudhi` cho 155 lát |
| Giai đoạn `inference` | `2185.7 ms` | Suy luận `TDASegUNet` trên CPU (`torch 2.8.0+cpu`) |
| Giai đoạn `reconstruct` | `90.118 ms` | Khôi phục patch `128×128` về lưới `[240, 240, 155]` |
| Giai đoạn `save` | `80.808 ms` | Ghi `mask.nii.gz`, `coverage.json`, `metadata.json` |
| **Tổng thời gian job E2E qua HTTP (`_claim -> _run_claim -> /complete`)** | **`19,672.634 ms`** (~**`19.67 s`**) | Bao gồm tải input qua HTTP internal API, 155 lát suy luận & upload/commit artifact vào PostgreSQL + storage |
| Peak RSS / Adapter Peak RAM | **`781.957 MB`** | Đo qua `psutil` trên tiến trình worker/smoke (`VRAM: N/A` do `CUDA available: False`) |

> **Lưu ý về GPU/CUDA:** Phiên bản phát hành cục bộ này chỉ đo benchmark trên CPU (`torch 2.8.0+cpu`, `CUDA available: False`). Khi triển khai trên máy có GPU NVIDIA, cần cài đặt **PyTorch CUDA build** tương thích và thực hiện benchmark riêng cho `WORKER_DEVICE=cuda` (lưu ý nút thắt `tda` chạy trên CPU qua `gudhi`).

### 5.3. Kiểm chứng Đầu ra Hình học & Thể tích

| Thuộc tính đầu ra | Giá trị quan sát |
|---|---|
| `export_shape` / `dtype` | `[240, 240, 155]` / `uint8` |
| `labels_present` | `[0, 1, 2, 4]` (`0`: `8,738,764` · `1`: `16,862` · `2`: `144,227` · `4`: `28,147` voxels) |
| Thể tích nhóm chồng lấp (`group_volumes_mm3`) | `WT = 189,236.0 mm³` · `TC = 45,009.0 mm³` · `ET = 28,147.0 mm³` |
| Coverage & Hình học | `empty_slices = 20`, `unevaluated_outside_crop = true`, `affine_match = true`, `spacing_match = true` |
| Bảo mật Metadata & Export | `metadata_has_no_absolute_paths = true`, `metadata_has_no_patient_pii = true` |

---

## 6. Bằng chứng Migration DB Sạch, Backup/Restore (`QA-OPS-02`) & Vệ sinh Repo

1. **Migration chu kỳ đầy đủ trên PostgreSQL sạch (`test_migrations_postgres.py`):**
   - `test_alembic_upgrade_downgrade_upgrade_cycle` chạy `upgrade head -> downgrade base -> upgrade head` trên `bts_test`, xác nhận đủ **18 bảng** (`system_settings`, `users`, `sessions`, `refresh_tokens`, `login_attempts`, `audit_events`, `patients`, `cases`, `case_create_idempotency_keys`, `stored_files`, `volumes`, `mask_versions`, `mask_save_idempotency_keys`, `model_versions`, `inference_jobs`, `job_attempts`, `job_create_idempotency_keys`, `worker_instances`), các partial unique index và seed `admin_settings` (`version=1`, `accepting_jobs=True`).
   - `test_downgrade_guard_rejects_dev_and_prod_databases` xác nhận từ chối chạy downgrade phá hủy lên `bts_dev`, `*_dev`, `*_prod`.
2. **Sao lưu & Phục hồi cô lập (`test_qa_ops_02_backup_and_isolated_restore_preserves_checksums_and_revokes_sessions`):**
   - Sử dụng [`backup_restore.py`](../../BE/scripts/backup_restore.py) cùng `pg_dump`/`pg_restore 16.16` qua Docker container `braintumorsegmentation-postgres-1`.
   - Từ chối backup khi có inference job ở trạng thái `running` (trừ khi truyền `--force`); bỏ qua các tệp rác trong `staging/`; `backup_manifest.json` không chứa PII.
   - Từ chối `restore` vào `bts_dev` hoặc `*_prod`.
   - Phục hồi thành công vào DB cô lập `bts_restore_test_<hex>` và storage tạm; **tự động thu hồi toàn bộ `sessions` và `refresh_tokens` cũ** (`revoke_reason="backup_restore"`, mọi token cũ nhận `401`).
   - Đăng nhập lại trên môi trường phục hồi, tải lại volume FLAIR gốc và xuất mask `v2` (`manual_v2_arr`) cho SHA-256 và NiBabel voxel/affine khớp 100% trước backup.
3. **Vệ sinh Dependency, Secrets & Git ([`test_repo_hygiene.py`](../../BE/tests/contract/test_repo_hygiene.py)):**
   - `BE/requirements.txt` ghim chặt toàn bộ bằng `==`; `BE/worker/manifest.json` ghim semver chính xác cho từng dependency AI; `FE/package-lock.json` tồn tại và hợp lệ (`lockfileVersion >= 2`).
   - `BE/.env.example` và `FE/.env.example` chỉ chứa placeholder an toàn (`REPLACE_WITH_*`, không có private key hoặc mật khẩu dev thật).
   - `.gitignore`, `git ls-files` và `git check-ignore` xác nhận **0** tệp `.env`, khóa riêng (`*.pem`, `*.key`), `secrets/`, `storage/`, `backups/`, checkpoint (`*.pt`, `*.pth`, `*.onnx`, `*.ckpt`) hoặc dữ liệu MRI nặng ngoài fixtures kiểm thử bị theo dõi trong Git.

---

## 7. Giới hạn Đã Biết của Phiên bản v1

1. **Profile hình học cố định của AI:** Pipeline `tda-segunet-2d-v1` chỉ chấp nhận volume MRI 3D scalar kích thước **`240×240×155`**, spacing **`1.0×1.0×1.0 mm`**; volume ngoài profile bị từ chối rõ ràng và không tự resample âm thầm.
2. **Vùng ngoài cửa sổ crop AI (`unevaluated_outside_crop: true`):** Ở mỗi lát cắt axial, mô hình suy luận trên patch `128×128`; vùng ngoài vùng crop được điền nền `0` và đánh dấu `unevaluated_outside_crop: true` trong `coverage.json` cũng như trên UI/metadata (không diễn giải thành vùng đã được AI đánh giá âm tính).
3. **Chỉnh sửa mask chỉ hỗ trợ mặt phẳng Axial trên lưới thẳng hàng (Axis-aligned):** Công cụ tô/xóa mask chỉ chỉnh trên pane Axial tại lưới voxel gốc (`isAffineAxisAligned`); khối MRI có affine nghiêng (**oblique**), cũng như các pane **Coronal**, **Sagittal** và **Lát lân cận (`k-1`/`k+1`)** ở chế độ chỉ đọc trong v1.
4. **Bản nháp chỉnh sửa chưa lưu chỉ nằm trong bộ nhớ trình duyệt (in-memory):** Thay đổi chưa lưu thành `MaskVersion` không lưu vào `localStorage`/`IndexedDB` để tránh lưu PII cục bộ ngoài kiểm soát; tải lại trang, đăng xuất, đổi tài khoản hoặc bị Admin khóa tài khoản sẽ xóa bản nháp (có cảnh báo trước khi thoát/xuất/in khi đang `isDirty`).
5. **Mục tiêu trình duyệt nghiệm thu v1:** Bộ kiểm thử E2E v1 nghiệm thu trên **Desktop Google Chrome** (chế độ chỉnh sửa mở từ `>= 1024px`; `< 1024px` tự chuyển sang chế độ chỉ đọc an toàn); chưa chứng nhận tự động đa trình duyệt (Safari/Firefox).
6. **Hiệu năng CPU & yêu cầu CUDA riêng:** Số liệu benchmark (~`19.67 s`/ca, trong đó TDA chiếm `~72%`) đo trên CPU; triển khai CUDA GPU cần môi trường PyTorch CUDA và benchmark độc lập trước khi đưa vào vận hành.
7. **Các tính năng thuộc P8 (ngoài phạm vi v1):** Upload Ground Truth để chấm Dice/IoU trên UI, chia sẻ/hội chẩn đa bác sĩ, kết nối DICOM/PACS và lưu thông tin lâm sàng mở rộng, mô hình đơn xung/so sánh đa mô hình, công cụ vẽ/nội suy 3D, và triển khai hạ tầng cloud.

---

## 8. Vấn đề Mở / Lỗi Chặn Phát hành

- **Open Release Blockers:** **`0`** (không còn lỗi chặn nào về xác thực, phân quyền/PII, hình học NIfTI, lưu mask đồng thời, worker recovery, hay sao lưu/phục hồi).
