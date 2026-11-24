# Báo cáo Nghiệm thu QA — P5-QA (AI Model Registry, Inference Job Queue, Worker Leases & Kết quả bất biến)

- **Ngày thực hiện:** 2026-11-18
- **Phạm vi:** Migration `0005_p5_inference_jobs` (`model_versions`, `inference_jobs`, `job_attempts`, `worker_instances`, `job_create_idempotency_keys`, FK/unique `mask_versions.job_id`); Worker service (`BE/worker/service.py`); Public API `GET /api/v1/system/availability`, `GET/POST /api/v1/cases/{case_id}/jobs`, `GET /api/v1/jobs/{job_id}`, `POST /api/v1/jobs/{job_id}/cancel`; Internal worker API `/api/v1/internal/worker/heartbeat`, `/api/v1/internal/worker/claim`, `GET /api/v1/internal/files/{file_id}/content`, `/api/v1/internal/jobs/{job_id}/{heartbeat,complete,fail}`; lease reaper nền trong `BE/app/main.py`; FE `CaseDetailPage.tsx` và `ViewerWorkspacePage.tsx` (`?version=<mask_version_id>`, `QA-MASK-06`).
- **Môi trường:** Windows, Python `3.13.5` (`BE/.venv`), Python Worker AI (`D:\Nam4\Ky1\PBL6\.venv`), Node `v22.23.2`, PostgreSQL `postgres:16-alpine` (`braintumorsegmentation-postgres-1`, `127.0.0.1:5432`).

## 1. Migration, OpenAPI & đồng bộ BE ↔ FE

| Kiểm tra | Lệnh | Kết quả quan sát |
|---|---|---|
| Alembic current & drift (`bts_dev`) | `$env:DATABASE_URL="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"; BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini check` | `0006_p6_admin_settings (head)`, `No new upgrade operations detected.` |
| OpenAPI export & check | `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m scripts.export_openapi --check` | exit `0`, khớp 100% FastAPI runtime |
| FE typegen | `Push-Location FE; npm run generate:types; Pop-Location` | `FE/src/shared/api/schema.d.ts` đồng bộ (`204.1ms`, gồm `CaseOut.is_inputs_locked` và DTO P5/P6) |

## 2. Kết quả Test suite, Lint, Build & AI Adapter

| Hạng mục | Kết quả quan sát |
|---|---|
| `ruff check` (`BE/app BE/scripts BE/migrations BE/worker/service.py BE/tests/...`) | `All checks passed!` |
| BE unit | `35 passed, 1 warning in 5.82s` |
| BE integration (`bts_test`) | `62 passed in 114.05s (0:01:54)` |
| BE contract | `3 passed in 5.60s` |
| **Tổng BE** | **`100 passed`** |
| AI adapter (`BE/tests/ai` qua `D:\Nam4\Ky1\PBL6\.venv`) | `12 passed in 38.49s` (**112 Python tests**) |
| FE `tsc -b --noEmit` | exit `0` |
| FE `vitest --run` | `9 passed (9)` files, `73 passed (73)` tests trong `23.30s` (`jobsAndAdminOps.test.tsx`: `7`) |
| FE `vite build` | exit `0` (`built in 7.54s`) |

## 3. Đối chiếu Ma trận Ca kiểm thử P5

| Mã ca | Bằng chứng kiểm chứng | Kết quả |
|---|---|---|
| `QA-AI-01` / `QA-AI-03` | `BE/tests/ai/test_p0_adapter.py`: `12 passed` (chỉ FLAIR/T1ce không dùng `_seg`, crop→restore, nhãn `{0,1,2,4}`, coverage metadata) | **ĐẠT** |
| `QA-JOB-01` | BE `test_doctor_job_idempotency_active_conflict_and_worker_claim` (cùng `Idempotency-Key` trả cùng job `202`, trùng active job trả `409 active_job_conflict`); FE `QA-JOB-01` single pending request, retry cùng khóa, offline worker warning, block khi `accepting_jobs=false`, cancel `queued` vs `409 job_not_cancellable`, polling 3s dừng ở trạng thái kết thúc | **ĐẠT** |
| `QA-JOB-02` | BE `test_qa_job_02_concurrent_workers_claim_only_one_wins` (`Barrier(2)` claim đồng thời trên PostgreSQL: đúng 1 worker nhận job, worker còn lại nhận `null`) | **ĐẠT** |
| `QA-JOB-03` | BE `test_qa_job_03_lease_expiry_reaper_retry_stale_attempt_and_worker_lost` (`reap_expired_attempts` hết hạn lần 1 requeue `auto_retry_count=1`, attempt cũ gửi heartbeat/complete/fail trả `409 stale_attempt`; hết hạn lần 2 chuyển `failed` `worker_lost`) | **ĐẠT** |
| `QA-JOB-04` | BE `test_qa_job_04_and_qa_mask_06_complete_preserves_manual_mask_rejects_bad_data_and_replays` & `test_complete_job_ambiguous_commit_preserves_stored_files` (chặn corrupt mask trước commit, idempotent replay cùng digest, `409 complete_digest_conflict`, bảo toàn object khi ambiguous commit) | **ĐẠT** |
| `QA-JOB-05` | BE `test_qa_job_05_fail_job_admin_detail_retry_owner_inactive_and_intake_paused` (`fail_job` với `inference_error`, retry hữu hạn, chặn vòng lặp vô hạn) | **ĐẠT** |
| `QA-MASK-06` | BE `complete_job` tạo immutable AI `MaskVersion` mới mà không ghi đè manual `MaskVersion` trước đó; FE `QA-MASK-06` giữ nguyên voxel bản nháp đang sửa và hiển thị `"Có kết quả AI mới"` không tự ghi đè | **ĐẠT** |
| `QA-OPS-01` | BE `test_qa_ops_01_active_job_blocks_case_and_patient_deletion` (dùng bảng thật `inference_jobs`: ca đang có `queued`/`running` bị chặn xóa `409 active_job_conflict`) | **ĐẠT** |

- **Review 4 góc (`Gemini 4 Argon High` trên `/swarm`):** `rev-code`, `rev-security`, `rev-tests` đạt `REVIEW: PASS`; `rev-docs` xác nhận báo cáo khớp thực tế và chỉ ra 3 dòng tóm tắt đầu `README.md` chưa cập nhật số liệu P5/P6 (đã cập nhật đầy đủ).
