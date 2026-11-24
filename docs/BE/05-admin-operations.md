# BE-05 — Admin và vận hành

## 1. Vai trò

Admin là owner hệ thống, không phải super-doctor. API admin không trả tên bệnh nhân, ngày sinh, scan notes, tên file chứa PII, ảnh thumbnail, mask hoặc link download. Khi cần kiểm tra ảnh phải dùng tài khoản bác sĩ có quyền sở hữu theo quy trình sản phẩm; không có nút impersonate trong v1.

Phase P2 triển khai quản lý tài khoản; P6 bổ sung dashboard, job, cấu hình, audit. Bootstrap admin qua CLI tương tác, không đặt password trong command argument hoặc commit dữ liệu seed chứa mật khẩu thật.

## 2. Quản lý tài khoản

| Endpoint | Contract |
|---|---|
| `GET /admin/users` | Pagination/search username/display_name, trạng thái; không count bệnh nhân theo danh tính |
| `POST /admin/users` | `{username,display_name,temporary_password}`; luôn tạo doctor, `must_change_password=true`; 201 user không chứa hash/password |
| `PATCH /admin/users/{id}` | Chỉ display_name, is_active của doctor; đổi username/role không thuộc v1 |
| `POST /admin/users/{id}/reset-password` | Body rỗng; server sinh password tạm ngẫu nhiên tối thiểu 16 ký tự, revoke tất cả session, force password change; 200 `{temporary_password}` hiển thị một lần, no-store |

Không xóa tài khoản có dữ liệu; disable để giữ tác giả lịch sử. Không cho disable/reset admin qua route dành cho doctor; admin tự đổi mật khẩu qua auth. Khôi phục admin bị mất mật khẩu bằng CLI local có audit; không có backdoor HTTP.

Khi tạo user admin nhập password tạm hợp lệ; khi reset server sinh và trả một lần. Admin chuyển ngoài ứng dụng theo quy trình demo; web không tự gửi email. Không log/body audit password và không có endpoint đọc lại password đã cấp.

## 3. Dashboard và job operations

| Endpoint | Output/hành vi |
|---|---|
| `GET /admin/overview` | Tổng user active/disabled, job counts by status, storage used/quota, worker_online, active model ID/version |
| `GET /admin/jobs` | Filter state/date; chỉ job ID, case ID opaque, model, worker, stage, timing, safe error code |
| `GET /admin/jobs/{id}` | Technical attempts/heartbeat/lease, không input payload hoặc file IDs |
| `POST /admin/jobs/{id}/retry` | Failed only; tạo job mới độc lập, ghi audit `safe_diff.previous_job_id`; không cho chỉ định file/checkpoint tùy ý |
| `GET /admin/workers` | ID, `last_heartbeat_at`, online, capability (`device_type`, `model_version`), `active_jobs` |
| `GET /admin/models` | Verified model registry metadata; không đường dẫn checkpoint tuyệt đối |

Retry vẫn kiểm tra ca còn tồn tại, user owner active, đầu vào hợp lệ và không có active job. Khi tài khoản bác sĩ sở hữu bị khóa (hoặc ca không còn hoạt động): trả 409 `retry_owner_inactive` (ngữ nghĩa hợp đồng `owner_disabled`); quản trị viên cần mở khóa tài khoản trước khi gửi lại công việc mới. Job đã chạy trước thời điểm disable tiếp tục hoàn tất, kết quả vẫn riêng tư; disable không phải lệnh hủy worker.

Không trả stack trace raw qua API admin. Log kỹ thuật server có stack trace đã redact và request/job IDs; quyền truy cập log filesystem là vấn đề vận hành, không đưa vào giao diện.

## 4. Cấu hình

`GET/PATCH /admin/settings` quản lý allowlist trường sau, có `version` optimistic locking để tránh ghi đè cập nhật:

| Trường | Default | Khoảng cho phép |
|---|---:|---|
| `accepting_jobs` | true | boolean |
| `max_upload_mib` | 100 | 1–100 |
| `max_decompressed_mib` | 256 | 1–256 |
| `default_doctor_quota_gib` | 2 | 1–100 |
| `system_quota_gib` | 20 | 1–1000 |

Các trần hard limits nằm trong deployment config (`MAX_UPLOAD_BYTES`, `MAX_DECOMPRESSED_BYTES`, `DOCTOR_QUOTA_BYTES`, `SYSTEM_QUOTA_BYTES`) và đảm bảo `default_doctor_quota_gib <= system_quota_gib` để admin UI không nâng quá khả năng máy chủ. Hạ quota dưới mức đang dùng không xóa dữ liệu; chỉ chặn upload mới. Pause nhận job không hủy running/queued; queued tiếp tục được worker xử lý. UI phải ghi rõ semantics này.

Model checkpoint, signing keys, DB credentials, storage root, worker token và CUDA config không thay qua admin UI. Model mới cần quy trình xác minh P0 và lệnh deploy có manifest.

## 5. Audit

`AuditEvent`: id, timestamp UTC (`created_at`), actor_type (`user`,`worker`,`system`), actor_id, action, resource_type, resource_id, outcome, request_id, safe_diff. Append-only qua ứng dụng; không có endpoint sửa/xóa.

Actions tối thiểu: user create/disable/enable/reset, login/security events, settings change, retry (`admin.job_retry` với `safe_diff.previous_job_id`), case delete, mask save, model activation. `safe_diff` whitelist fields, không snapshot nguyên Patient/Case hoặc payload upload. Ghi user ID thay vì tên trong event kỹ thuật.

`GET /admin/audit-events` filter actor/action/date và pagination; admin chỉ thấy sự kiện quản trị/bảo mật kỹ thuật. Audit mask/case cho doctor được lấy qua lịch sử resource thuộc mình, không biến thành kênh đọc bệnh án toàn viện.

## 6. Health và storage maintenance

- `GET /health/live`: 200 nếu process hoạt động, không secrets.
- `GET /health/ready`: DB accessible và storage writable; 503 khi lỗi. Worker offline không làm API unready vì vẫn xem/sửa được.
- Worker status riêng ở dashboard. API không giả báo ready inference khi model chưa verified.
- Maintenance dọn staging/orphan và deletion jobs có log count/status; chạy CLI/scheduled process cấu hình, không expose arbitrary path qua endpoint.
- Backup local là thao tác vận hành có hướng dẫn ở BE-06; v1 không xây nút tải toàn database chứa PII qua admin UI.

## 7. Nghiệm thu

- Admin account ops hoạt động; revoke session có hiệu lực ngay.
- Response/admin logs không có full_name bệnh nhân, scan notes, file URL hoặc MRI data.
- Admin retry không bỏ qua validation, admission policy hoặc ownership storage.
- Hai PATCH settings cùng version chỉ một thành công, request còn lại 409.
- Hạ quota không xóa file; pause không làm mất job.
- Public health không tiết lộ DB URL, filesystem path hoặc checkpoint location.
