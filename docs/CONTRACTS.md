# Hợp đồng dùng chung FE / BE / AI

Đây là hợp đồng thiết kế v1. Khi viết code, OpenAPI do FastAPI xuất là artifact máy đọc; mọi thay đổi trái hợp đồng này phải được cập nhật tài liệu và kiểm thử trước khi tích hợp.

## 1. Quy ước API

- Base path: `/api/v1`. JSON snake_case; UUID dạng chuỗi cho ID.
- Ngày: `YYYY-MM-DD`; thời gian: ISO 8601 UTC có `Z`. FE hiển thị Asia/Ho_Chi_Minh.
- Thành công trả resource trực tiếp; danh sách `{items, total, page, page_size}`.
- Lỗi `{error: {code, message, details, request_id}}`; `message` thân thiện, không stacktrace/path nội bộ/PII. `details` chỉ chứa trường và lý do được phép công khai.
- HTTP: 400 thao tác sai; 401 chưa xác thực/token lỗi; 403 sai vai trò; 404 không tồn tại hoặc không thuộc chủ sở hữu; 409 xung đột version/job/dữ liệu đang dùng; 413 quá lớn; 422 nội dung/validation không hợp lệ; 429 giới hạn; 503 hệ thống tạm không nhận job.
- Danh sách mặc định 20, tối đa 100; `page` bắt đầu 1. Tìm kiếm `q`, lọc/sort phải thuộc allowlist; bác sĩ chỉ tìm trong dữ liệu của mình.
- `GET` không thay đổi state. Mutation trả representation mới hoặc 204. FE không tự retry mutation không có bảo đảm idempotency.
- Sau logout/đổi account: hủy request cũ, xóa Query cache, viewer buffers và object URLs; không để response muộn khôi phục dữ liệu tài khoản cũ.

## 2. Auth và session

Access JWT claims: `sub`, `role`, `sid`, `iat`, `exp`, `iss`, `aud`; header `alg=RS256`, `kid`. Không chứa tên/email bệnh nhân hoặc thông tin hồ sơ. Server kiểm tra user/session còn hiệu lực trên mỗi request.

Refresh cookie: `bts_refresh`, HttpOnly, SameSite=Lax, Path=`/api/v1/auth`, không Domain. Secure=true cho HTTPS; chỉ cho phép false trong local localhost development. GET `/auth/me` cần access token. POST `/auth/refresh` dùng cookie và kiểm tra Origin; khi thành công rotate cookie và trả access mới. Fixed family expiry 7 ngày từ login, rotation không gia hạn quá hạn đó.

| API | Yêu cầu / phản hồi tối thiểu |
|---|---|
| `POST /auth/login` | `{username,password}` → `{access_token,token_type,expires_in,user}` + cookie |
| `POST /auth/refresh` | cookie → cùng access envelope + cookie mới |
| `POST /auth/logout` | thu hồi session family, clear cookie; idempotent |
| `GET /auth/me` | `{id,username,display_name,role,is_active,must_change_password}` |
| `POST /auth/change-password` | `{current_password,new_password}`; thu hồi các phiên, yêu cầu login lại |

Tài khoản `must_change_password=true` chỉ gọi me/logout/change-password. FE refresh single-flight, đồng bộ giữa tab bằng Web Locks/BroadcastChannel khi hỗ trợ; không chia sẻ refresh secret qua JS. Với tab/browser không hỗ trợ coordination, reuse được xử lý an toàn bằng yêu cầu đăng nhập lại, không miễn kiểm tra reuse. Duplicate refresh không được cấp hai successor.

## 3. Patient, case, volume

```text
Patient: id, patient_code, full_name, birth_year, sex,
         owner_id, created_at, updated_at
Case: id, patient_id, owner_id, study_date, notes, reference_volume_id,
      readiness, input_revision, inputs_locked_at, latest_mask_version_id,
      created_at, updated_at
CaseOut (DTO): kèm patient_code suy dẫn từ Patient thuộc chủ sở hữu
Volume: id, case_id, modality, file_id, validation_status,
        shape, spacing_mm, affine, orientation, size_bytes, sha256
```

- `sex`: `male | female | other | unknown`; năm sinh nguyên 1900 đến năm hiện tại; tên 1–150 ký tự sau trim; patient_code 1–50, unique theo owner không phân biệt hoa thường. `CaseOut` trả thêm `patient_code` suy dẫn trực tiếp từ `Patient` thuộc chủ sở hữu (tự động đồng bộ khi cập nhật hồ sơ bệnh nhân; không xuất hiện trong Admin schemas).
- `study_date` là ngày lịch, không ở tương lai; notes tối đa 5000 ký tự.
- `readiness`: `missing_inputs | validating | ready | invalid`; khác trạng thái job.
- `modality`: `flair | t1ce`; unique `(case_id,modality)`.
- Reference ưu tiên FLAIR; nếu bắt đầu chỉnh tay trước khi có FLAIR, chốt reference vào volume hiện hữu. Khi bổ sung modality còn lại phải cùng grid; không đổi reference đã có mask.
- `validation_status`: `validating | valid | invalid`; trước khi valid không cung cấp dữ liệu cho inference/editor.

| API | Vai trò và hành vi |
|---|---|
| `GET/POST /patients` | doctor; list/create |
| `GET/PATCH/DELETE /patients/{id}` | owner; xóa bị chặn khi có job active trong hồ sơ |
| `GET /patients/{id}/cases` | owner, danh sách ca |
| `POST /patients/{id}/cases` | owner, body `{study_date,notes}` và header `Idempotency-Key` dạng UUID bắt buộc. Trả 201 cùng ca đã tạo |
| `GET/PATCH/DELETE /cases/{id}` | owner; metadata và xóa theo quy tắc |
| `POST /cases/{id}/volumes` | multipart `modality`,`file`; upload/check; 201 sau khi valid hoặc 422 khi reject |
| `GET /cases/{id}/volumes` | owner; metadata và file IDs |
| `DELETE /cases/{id}/volumes/{volume_id}` | chỉ khi đầu vào chưa bị khóa (`inputs_locked_at == null`); trả 409 `inputs_locked` nếu đã khóa |
| `GET /files/{id}/content` | bác sĩ tải file qua Bearer token (owner-scoped), byte stream, `no-store`, admin bị từ chối (403); Internal Worker tải file đầu vào qua `GET /internal/files/{id}/content` (hoặc `GET /files/{id}/content` kèm worker service credential + attempt/lease headers) |

Quy tắc khóa đầu vào (`inputs_locked_at`): đầu vào của ca bị khóa khi ca đã có phiên bản mask (`latest_mask_version_id != null`) hoặc có job đang chờ/đang chạy hay đã từng chạy (`attempt_count > 0`). Nếu bác sĩ hủy một job ở trạng thái `queued` chưa từng được worker claim (`attempt_count == 0`) và ca chưa có phiên bản mask cũng như chưa có bất kỳ job nào khác đã từng chạy (`attempt_count > 0`), hệ thống đặt lại `inputs_locked_at = null` để mở khóa đầu vào.

Khi tạo ca, server kiểm tra quyền trước khi tra khóa theo bộ `(doctor_id, patient_id, key)`. Thiếu khóa hoặc UUID sai trả 422. Lưu digest của body đã xác thực và liên kết khóa với ID ca trong cùng giao dịch tạo ca. Ràng buộc duy nhất trên bộ khóa bảo đảm các yêu cầu đồng thời chỉ tạo một ca. Cùng khóa và nội dung trả 201 cùng ID. Cùng khóa và nội dung khác trả 409 `idempotency_conflict`. Giữ bản ghi khóa trong vòng đời hồ sơ bệnh nhân. Nếu ca đã bị xóa, gửi lại cùng khóa và nội dung trả 409 `case_deleted` và không tạo lại ca.

Không ghi thông tin invalid vào ca dưới dạng valid. `validating` có thể là trạng thái tạm nội bộ trong lúc request upload chạy; v1 không đòi frontend polling endpoint upload riêng. File staging lỗi phải được dọn.

NIfTI: scalar 3D, dữ liệu hữu hạn; không nhận vector/4D hoặc RGB trong v1. Giới hạn byte phải kiểm cả compressed và decompressed trước khi materialize. Kiểm tra spacing dương hữu hạn, affine khả nghịch và qform/sform không mâu thuẫn đáng kể. Nếu không xác định được không gian vật lý, báo lỗi thay vì tự đặt identity.

Đơn vị không gian NIfTI `xyzt_units` chấp nhận `mm` (`1.0`), `meter` (`1000.0`), `micron` (`0.001`) — quy đổi sang `mm` — và `unknown` (mã `0`, mặc định hệ số `1.0` = `mm` khi `qform/sform` hợp lệ) đồng nhất giữa BE validator và AI worker; đơn vị khác bị từ chối (422). Hai volume: shape bằng nhau; spacing `rtol=0, atol=1e-4 mm`; affine `rtol=0, atol=1e-4` theo đơn vị mm. Không tự resample hoặc registration khi sai. Profile inference khóa theo manifest P0 (`240×240×155`, `1.0 mm`).

## 4. Job và worker

```text
InferenceJob (DB): id, case_id, doctor_id, model_version_id,
 state, stage, completed_slices, total_slices,
 attempt_count, auto_retry_count, max_auto_retries, error_code,
 result_mask_version_id, result_digest,
 created_at, started_at, finished_at
InferenceJobOut (DTO): id, case_id, model_version_id,
 state, stage, completed_slices, total_slices,
 attempt_count, max_auto_retries, error_code,
 created_at, started_at, finished_at, result_mask_version_id
JobAttempt (server): id, job_id, attempt_number, worker_id, state,
 lease_token_hash, lease_expires_at, stage,
 completed_slices, total_slices, error_code,
 started_at, finished_at
WorkerInstance (server): worker_id, device_type, model_version_id,
 current_job_id, last_heartbeat_at
```

`state = queued | running | succeeded | failed | cancelled` (attempt `state = running | succeeded | failed | expired`).
`stage = queued | loading | preprocessing | inference | reconstructing | saving | done`.

Transitions: queued→running→succeeded/failed; queued→cancelled. Attempt hết lease hoặc lỗi worker tạm thời: running→queued tối đa `max_auto_retries` lần (`auto_retry_count`, mặc định 1); hết ngân sách→failed. Retry thủ công của Admin (`POST /admin/jobs/{id}/retry`) tạo bản ghi `InferenceJob` mới độc lập (không sửa lịch sử job cũ) và liên kết lịch sử qua `audit_events.safe_diff.previous_job_id` (hoặc `retry_of_job_id` nếu mở rộng).

| API | Hợp đồng |
|---|---|
| `POST /cases/{id}/jobs` | `Idempotency-Key` bắt buộc; 202 `{job}`; cùng key/body trả job cũ, khác body 409; key scope theo actor+case lưu cùng job |
| `GET /cases/{id}/jobs` | owner; lịch sử job của ca, phân trang |
| `GET /jobs/{id}` | owner đọc trạng thái và result id |
| `POST /jobs/{id}/cancel` | owner; queued only; nếu running trả409 |
| `GET /system/availability` | doctor; `{accepting_jobs,worker_online,active_model_id,updated_at}` không lộ đường dẫn/hạ tầng |
| `POST /internal/worker/claim` | service credential (`X-Worker-Token`); claim nguyên tử; job+attempt+lease token, hoặc 204 |
| `POST /internal/worker/heartbeat` | heartbeat process cập nhật `last_heartbeat_at` kể cả không có job; không tự giữ job lease |
| `GET /internal/files/{id}/content` | service credential + headers `X-Job-ID`, `X-Attempt-ID`, `X-Worker-ID`, `X-Lease-Token`; stream file đầu vào |
| `POST /internal/jobs/{id}/heartbeat` | attempt+lease token; gia hạn `lease_expires_at` 90s, báo stage/counters |
| `POST /internal/jobs/{id}/complete` | multipart mask + metadata; validate, publish atomic, đánh dấu succeeded |
| `POST /internal/jobs/{id}/fail` | mã lỗi có kiểm soát, áp dụng retry classification |

Worker heartbeat15s, claim khi idle mỗi5s, concurrency1. Backend scheduler/reaper mỗi15s kiểm lease và cleanup; local single API process chỉ một reaper. Worker heartbeat online cutoff90s. Khi offline vẫn cho queue nếu accepting_jobs=true nhưng hiển thị rõ chờ worker; khi maintenance accepting_jobs=false trả503. `completed_slices/total_slices` chỉ mô tả bước có đo, không giả phần trăm toàn pipeline.

Lease token cần cho file đầu vào của job và kết quả. Late completion/heartbeat từ attempt cũ trả409. Lỗi input/model không tương thích không retry tự động. Lỗi transient I/O hoặc worker chết có thể retry một lần. Không log toàn bộ exception có filename patient; internal detail chỉ ở log đã lọc.

## 5. Mask version và thống kê

```text
MaskVersion: id, case_id, version_number, source (ai|manual),
 base_version_id, reference_volume_id, file_id, created_by,
 created_at, note, model_version_id?, job_id?, coverage_file_id?,
 label_voxel_counts, label_volumes_mm3, sha256
```

Version là immutable. `version_number` tăng tuần tự trong case dưới khóa transaction. `latest_mask_version_id` là head đã lưu; UI không tự đổi version đang xem khi có head mới. Mask trống chưa lưu chỉ tồn tại trong editor; save lần đầu `base_version_id=null` chỉ hợp lệ nếu case chưa có version, ngược lại409.

| API | Hợp đồng |
|---|---|
| `GET /cases/{id}/mask-versions` | owner; danh sách metadata |
| `POST /cases/{id}/mask-versions` | `Idempotency-Key` bắt buộc; multipart `mask`,`base_version_id`,`reference_volume_id`,`note`; manual only; 201 |
| `GET /mask-versions/{id}` | metadata và counts |
| `GET /mask-versions/{id}/export` | `.nii.gz` bảo toàn geometry |
| `GET /mask-versions/{id}/metadata` | JSON provenance, geometry, coverage, thống kê; không token/path server |

Nếu base_version_id không bằng head hiện tại trả409 `mask_version_conflict`; giữ edits trên client để người dùng tự chọn bỏ hoặc xuất bản nháp cục bộ, không tự merge. AI completion được append dưới transaction và cập nhật head; không sửa version cũ và không ép FE bỏ bản nháp.

Save idempotency: key scope actor+case, gắn digest mask và metadata, lưu receipt cùng version trong transaction. Request cùng key và digest trả đúng version đã tạo, kể cả head hiện tại đã thay đổi; khác digest trả409 `idempotency_conflict`. Kiểm quyền hiện tại trước khi trả receipt và tra receipt trước khi kiểm stale base. Receipt sống cùng version. Khi timeout chưa biết đã commit, FE giữ payload/key để retry đúng request (không key mới); edits phát sinh sau lúc gửi thuộc draft mới và không bị đánh dấu saved bởi response cũ. Không tự retry upload thông thường.

Mask chỉ số nguyên `{0,1,2,4}`, uint8 khi lưu, cùng grid với reference. Nhãn:0 nền,1 NCR/NET,2 edema,4 ET theo profile BraTS2020. Palette v1:1 cam `#F59E0B`,2 xanh lá `#22C55E`,4 tím `#A855F7`; nhãn có text, không chỉ màu.

`voxel_volume_mm3 = abs(det(affine[:3,:3]))` khi affine đã quy về mm. Thể tích mỗi nhãn = count×voxel_volume; mL = mm³/1000. Server tính lại, không tin số liệu client. Có thể xuất WT={1,2,4},TC={1,4},ET={4} như nhóm thống kê; không cộng các nhóm chồng lấp thành tổng.

Coverage AI ghi vị trí crop từng lát, shape gốc và pipeline version. Manual version lưu provenance coverage nguồn nếu có; số voxel được bác sĩ tô ngoài coverage không biến thành vùng được AI đánh giá. Thống kê thể tích là của mask đang chọn, không gọi là độ tin cậy hoặc độ chính xác.

## 6. Admin interfaces

| API | Phạm vi |
|---|---|
| `GET/POST /admin/users` | chỉ quản lý tài khoản doctor qua UI |
| `PATCH /admin/users/{id}` | display name, active; khóa thu hồi mọi session |
| `POST /admin/users/{id}/reset-password` | password tạm hiển thị một lần, forced change; không ghi log |
| `GET /admin/overview` | aggregate tài khoản/job/dung lượng |
| `GET /admin/jobs` | ID kỹ thuật, state, stage, timings, error code; không patient/case notes |
| `POST /admin/jobs/{id}/retry` | tạo job mới độc lập, ghi audit `safe_diff.previous_job_id`; không bypass input/account validation (409 `retry_owner_inactive` khi bác sĩ bị khóa) |
| `GET /admin/workers` | trạng thái worker |
| `GET/PATCH /admin/settings` | giới hạn trong allowlist, maintenance; không expose secrets |
| `GET /admin/models` | thông tin manifest; kích hoạt model qua CLI xác minh, không upload web |
| `GET /admin/audit-events` | phân trang, dữ liệu đã lọc |

## 7. Chỉnh sửa theo lát và hệ tọa độ

- Backend dùng voxel indices0-based; UI hiển thị lát1-based. Không gọi `shape[2]` là axial cho mọi file: viewer đọc affine và mapping.
- Editor axial cần mapping rõ giữa display-space và original voxel grid. Không chỉnh vào texture màn hình rồi lưu trực tiếp với affine gốc.
- Chỉ cho chỉnh nếu có thể ánh xạ chính xác vào lưới native không resample. Volume oblique có thể xem nhưng tắt editor v1 với giải thích; không âm thầm nội suy label.
- Brush mặc định radius3 voxel, cho1–20; mỗi stroke là một undo unit. History riêng mỗi lát, tối đa100 strokes/lát và64MiB toàn session; vượt thì bỏ lịch sử undo cũ nhất, không bỏ edits, báo người dùng.
- Các kiểu bố cục dùng chung một volume buffer và một dirty state; không tạo bản mask độc lập theo khung.
- Lát lân cận: k-1,k,k+1; đầu/cuối hiển thị khung rỗng có nhãn, không wrap-around.

## 8. Xung đột, xóa và tính bền vững

- Xóa case/patient có job queued/running:409. Xóa phải gỡ quyền đọc ngay rồi dọn file bằng cleanup có thể chạy lại; không báo đã giải phóng dung lượng nếu cleanup chưa xong.
- File được ghi staging, xác minh checksum/header rồi rename/commit. Có cleanup cho orphan sau sự cố; DB không tham chiếu file ghi dở.
- File MRI đầu vào và version lưu bền vững qua restart; editor draft chỉ ở RAM và chưa bền vững trước Save.
- File export client hoặc bản nháp phải mang tên an toàn theo technical case/version IDs, không tự nhúng tên bệnh nhân.
