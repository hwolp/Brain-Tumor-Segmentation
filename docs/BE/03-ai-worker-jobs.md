# BE-03 — TDA-SegUNet, worker và job lifecycle

## 1. P0: cổng xác minh mô hình

Repo AI cạnh workspace mô tả TDA-SegUNet 2D, hai ảnh FLAIR/T1ce và bốn kênh TDA (`[FLAIR, T1ce, FLAIR-H0, FLAIR-H1, T1ce-H0, T1ce-H1]`). Giai đoạn P0 đã hoàn tất xác minh checkpoint thật `D:/Nam4/Ky1/PBL6/Demo2/outputs/tda_seg_unet_cce_dice/best.pt` (`TDASegUNet(in_channels=6, num_classes=4, base=16)`, SHA-256 `6ec9edc3b0d75474d8d8d427e8d962b6f7fabff1d2aab08ad972b08775413d3f`), đóng gói manifest tái lập tại `BE/worker/manifest.json` và ghi nhận đầy đủ bằng chứng tại [báo cáo xác minh P0-AI](../reports/P0-AI-verification.md) (`docs/reports/P0-AI-verification.md`). Tuyệt đối không chọn checkpoint chỉ dựa vào tên `best` hoặc tự chuyển sang baseline khi gặp lỗi xác minh.

Checklist P0 (đã thực thi và dùng làm quy chuẩn khi nâng cấp model):

1. Đọc script huấn luyện/evaluation gốc tương ứng checkpoint; kiểm tra state dict, số kênh, số lớp, kích thước patch và tên layer.
2. Xác minh chuẩn hóa theo volume hay slice, nonzero mask, thứ tự kênh, persistence parameters, crop center và mapping labels. README và code khác nhau thì dùng đường huấn luyện thực làm nguồn chính, ghi rõ bằng chứng.
3. Hàm discover/prepare của training đang cần `_seg` và bốn modality: tách adapter inference nhận FLAIR/T1ce, tuyệt đối không gọi đường crop dựa vào ground truth.
4. Ghi manifest model: `model_id`, `version`, `checkpoint_sha256`, `architecture`, `required_modalities`, `input_profile`, `normalization`, `tda_config`, `crop_config`, `class_mapping`, `dependencies`, `verification_status`.
5. Chạy ca tham chiếu không có `_seg`; đối chiếu với inference gốc bằng cùng checkpoint và preprocessing. Test nội bộ được dùng nhãn chuẩn để đánh giá nhưng không làm input inference.
6. Đo thời gian từng stage, RAM/VRAM; kiểm tra CPU trước, CUDA khi môi trường hỗ trợ. Không hứa latency/GPU requirements trước khi đo.

Chỉ `verified` model mới active. Nếu chưa xác minh, API inference trả `503 MODEL_NOT_READY`; UI vẫn xem/sửa mask thủ công. Worker giả chỉ dùng testing/development có banner, không lưu kết quả như AI thật.

## 2. Adapter và hình học

Input adapter: file FLAIR/T1ce đã validate, manifest model, thư mục output riêng cho attempt. Output: NIfTI mask uint8, metadata và coverage file.

- Đọc đủ toàn volume; không mặc định chỉ 70 hoặc 30 lát như một số tập prepared/evaluation.
- Với profile BraTS thông thường, xử lý 155 lát. Số lát lấy từ input contract, không hard-code trong progress UI.
- Mỗi slice lưu crop bounds và padding để hoàn nguyên patch chính xác; ảnh output cùng shape và affine với reference volume.
- Map contiguous class IDs về `{0,1,2,4}` trước export. Labels từ manifest, không suy luận theo màu.
- Vùng ngoài crop có nhãn nền trong array để biểu diễn mask đầy đủ, nhưng metadata coverage nêu rõ chưa được mô hình đánh giá.
- Không đổi normalization, crop hoặc TDA để cải thiện tốc độ mà không đổi model pipeline version và kiểm chứng lại.
- Process all-zero slice theo hành vi pipeline đã xác minh; mọi đường skip phải được ghi coverage/metadata.

## 3. Schema job

`InferenceJob` (`inference_jobs`): `id`, `case_id`, `doctor_id`, `model_version_id`, `state`, `stage`, `completed_slices`, `total_slices`, `attempt_count`, `auto_retry_count`, `max_auto_retries` (`= 1`), `error_code`, `result_mask_version_id`, `result_digest`, `created_at`, `started_at`, `finished_at`.

Stage enum: `queued`, `loading`, `preprocessing`, `inference`, `reconstructing`, `saving`, `done`. Public DTO (`InferenceJobOut`) dùng `state`, không dùng `status`, và trả: `id`, `case_id`, `model_version_id`, `state`, `stage`, `completed_slices`, `total_slices`, `attempt_count`, `max_auto_retries`, `error_code`, `created_at`, `started_at`, `finished_at`, `result_mask_version_id`.

`JobAttempt` (`job_attempts`): `id`, `job_id`, `attempt_number`, `worker_id`, `state` (`running`, `succeeded`, `failed`, `expired`), `lease_token_hash`, `lease_expires_at`, `stage`, `completed_slices`, `total_slices`, `error_code`, `started_at`, `finished_at`; `lease_token` chỉ lưu dạng hash SHA-256 (`lease_token_hash`) và chỉ hợp lệ trong thời hạn `lease_expires_at` (được gia hạn qua heartbeat của job). Một case có tối đa một job `queued` hoặc `running` bằng partial unique index.

`WorkerInstance` (`worker_instances`): `worker_id`, `device_type`, `model_version_id`, `current_job_id`, `last_heartbeat_at`. Không chứa thông tin bệnh nhân. Worker xác thực API nội bộ bằng service credential riêng (`X-Worker-Token` đối chiếu hằng thời gian), tách biệt hoàn toàn với JWT doctor/admin. Với retry thủ công của Admin (`POST /admin/jobs/{id}/retry`), hệ thống tạo một bản ghi `InferenceJob` mới độc lập và liên kết lịch sử qua `audit_events.safe_diff.previous_job_id` (hoặc `retry_of_job_id` nếu mở rộng).

## 4. Public API

| Method/path | Contract |
|---|---|
| `POST /cases/{id}/jobs` | Header `Idempotency-Key` UUID; body rỗng v1 sử dụng active model. 202 `{job}` |
| `GET /jobs/{id}` | Trạng thái, stage, counters, safe error, result ID |
| `GET /cases/{id}/jobs` | Lịch sử job của ca |
| `POST /jobs/{id}/cancel` | Chỉ queued; 200 cancelled. running trả 409 `job_not_cancellable` |
| `GET /system/availability` | Doctor đọc `{accepting_jobs,worker_online,active_model_id,updated_at}` |

Idempotency key scoped theo actor+case (`JobCreateIdempotencyKey`: `doctor_id`, `case_id`, `idempotency_key`), lưu cùng job. Cùng key/cùng case trả job cũ; cùng key payload khác trả 409. Request không key trả 422. Job creation khi thiếu modality trả 422; model chưa verified trả 503; admission paused trả 503. Worker offline vẫn cho queue; giao diện đọc availability và báo đang chờ worker. Doctor chạy lại bằng POST tạo job mới với key mới khi ca không còn active job; admin retry failed có route riêng.

## 5. API internal worker

| Method/path | Hành vi |
|---|---|
| `POST /internal/worker/heartbeat` | Cập nhật `last_heartbeat_at` và capability của `WorkerInstance`, mỗi 15 giây |
| `POST /internal/worker/claim` | Atomic claim job phù hợp; 200 assignment hoặc 204 nếu không có |
| `GET /internal/files/{id}/content` | Worker service credential (`X-Worker-Token`) + headers `X-Job-ID`, `X-Attempt-ID`, `X-Worker-ID`, `X-Lease-Token`; stream file đầu vào chỉ cho worker/attempt đang giữ lease (tách biệt với `GET /files/{id}/content` dùng Bearer token owner-scoped dành cho Bác sĩ; hoặc `GET /files/{id}/content` kèm worker service credential + attempt/lease headers nếu hợp nhất) |
| `POST /internal/jobs/{id}/heartbeat` | `attempt_id` + `lease_token`, `stage`/counters; gia hạn `lease_expires_at` |
| `POST /internal/jobs/{id}/complete` | Multipart mask + JSON metadata/coverage (kèm headers attempt/lease); validate rồi commit |
| `POST /internal/jobs/{id}/fail` | `attempt_id` + `lease_token`, safe `error_code`; không gửi stack trace có PII |

Claim dùng PostgreSQL `FOR UPDATE SKIP LOCKED` trong transaction, đặt running và lease token mới (chỉ lưu `lease_token_hash` trong DB). Worker không có thông tin đăng nhập DB. Claim polling mỗi 5 giây khi rảnh; concurrency mặc định 1; model nạp một lần vào process worker.

Heartbeat mỗi 15 giây; lease 90 giây. Worker offline khi `last_heartbeat_at` quá 90 giây. Reaper chạy mỗi 15 giây, dùng advisory lock để không xử lý trùng giữa API replicas. Phần việc này ngắn và chỉ tác động DB, không chạy AI trong API.

## 6. State machine và phục hồi

```text
queued -> running -> succeeded
  |          |----> failed
  v          |----> queued (lease expired / worker_error, tối đa max_auto_retries = 1)
cancelled
```

- V1 không hủy running. Mọi chuyển trạng thái có điều kiện SQL theo state/attempt hiện tại.
- Lease hết lần đầu (hoặc lỗi worker tạm thời `worker_error` khi `auto_retry_count < max_auto_retries`): đánh dấu attempt `expired`/`failed`, tăng `auto_retry_count`, đưa job về `queued`. Hết ngân sách retry: chuyển `failed` (`lease_expired` / `worker_lost` / `worker_error`).
- Lỗi validation/model không transient: failed ngay, không tự retry vô hạn. Doctor/admin có thể retry thủ công sau khi xử lý nguyên nhân: tạo `InferenceJob` mới độc lập và ghi liên kết `audit_events.safe_diff.previous_job_id`.
- Complete/fail/heartbeat từ attempt cũ trả 409 `stale_attempt`, không đổi result hiện tại.
- Complete cùng attempt đã thành công và checksum giống trả kết quả cũ (idempotent); khác checksum trả 409.
- Hủy queued lock cùng row với claim; chỉ một hành động thắng. Không có job vừa cancelled vừa running.

## 7. Công bố kết quả

API xác thực lease, lưu staging, kiểm tra shape/affine/labels và metadata manifest, sau đó atomic commit file và transaction job+mask version. `succeeded` chỉ đặt khi mask tải được. Thất bại commit không tạo result ID giả.

AI result luôn là phiên bản immutable mới, append dưới transaction và cập nhật `latest_mask_version_id`. Không ghi đè phiên bản manual cũ. FE giữ nguyên version đang xem và bản nháp khi head thay đổi; save draft từ base cũ trả 409 để bác sĩ xử lý chủ động.

## 8. Nghiệm thu

- Không có `_seg` vẫn infer được; không đọc segmentation qua đường gián tiếp.
- Mismatch checkpoint/config chặn startup model, không trả mask rỗng giả thành công.
- Tất cả slice được xử lý/ghi coverage; nhãn, orientation, crop reconstruction khớp test fixture.
- Duplicate POST, hai workers claim, lease expiry, late complete, retry, restart API đều giữ invariant một active job/ca.
- Kill worker giữa TDA/inference/upload kết quả không công bố file dở.
- Worker credential không đọc ca khác hoặc gọi admin APIs; token user không gọi internal API.
