# BE-02 — Bệnh nhân, ca chụp và lưu MRI

## 1. Phạm vi

Phase P3, phụ thuộc BE-01. Mỗi bác sĩ quản lý tập bệnh nhân riêng; chưa có danh mục bệnh nhân chung, phân công, hội chẩn hoặc chia sẻ ca. Mã bệnh nhân do bác sĩ nhập, unique trong phạm vi mình.

## 2. Dữ liệu

| Entity | Fields |
|---|---|
| Patient | `id`, `owner_id`, `patient_code`, `full_name`, `birth_year`, `sex`, `created_at`, `updated_at`, `deleted_at` |
| Case | `id`, `patient_id`, `owner_id`, `study_date`, `notes`, `reference_volume_id`, `readiness`, `input_revision`, `inputs_locked_at`, `latest_mask_version_id`, timestamps |
| Volume | `id`, `case_id`, `modality`, `file_id`, `shape`, `spacing_mm`, `affine`, `orientation`, `datatype`, `validation_status`, `validation_errors` |
| StoredFile | `id`, `storage_key`, `original_name`, `size_bytes`, `sha256`, `media_type`, `state`, timestamps |

`sex`: `male`, `female`, `other`, `unknown`. `patient_code` 1–50 ký tự, unique theo owner không phân biệt hoa thường; `full_name` 1–150 sau trim; năm sinh từ 1900 đến năm hiện tại; ngày chụp không sau ngày hiện tại theo Asia/Ho_Chi_Minh. `notes` tối đa 5000 ký tự. Không thêm chẩn đoán AI hoặc bệnh án mở rộng trong phase này.

`readiness`: `missing_inputs`, `validating`, `ready`, `invalid`. Trạng thái inference nằm ở job, không trộn vào readiness. Một ca có tối đa một FLAIR và một T1ce ở v1. Quy tắc khóa đầu vào (`inputs_locked_at`): đầu vào bị khóa khi ca đã có phiên bản mask (`latest_mask_version_id != null`) hoặc có job đang chờ/đang chạy hay đã từng được worker nhận chạy (`attempt_count > 0`). Nếu bác sĩ hủy một job ở trạng thái `queued` chưa từng được worker claim (`attempt_count == 0`) và ca chưa có phiên bản mask hay job nào khác đã từng chạy (`attempt_count > 0`) thì `inputs_locked_at` được đặt lại `null` để mở khóa đầu vào. Khi đầu vào đã khóa vĩnh viễn (đã có mask hoặc job `attempt_count > 0`), file raw bất biến — muốn thay ảnh lúc đó phải tạo ca mới. Trước khi khóa, được bổ sung modality còn thiếu nếu cùng grid và không đổi reference đã có mask.

## 3. API public

| Method/path | Hành vi |
|---|---|
| `GET /patients?q=&page=&page_size=` | Search code/name trong owner hiện tại |
| `POST /patients` | Body code/name/birth_year/sex; 201 Patient |
| `GET/PATCH /patients/{id}` | Xem/sửa trường cho phép; không nhận owner_id |
| `DELETE /patients/{id}` | 202 tạo yêu cầu xóa nếu không có job active |
| `GET /patients/{id}/cases` | Danh sách ca trong hồ sơ |
| `POST /patients/{id}/cases` | Tạo ca từ `{study_date,notes}` với `Idempotency-Key` bắt buộc. Trả 201 cùng ca. Áp dụng quy tắc kiểm quyền, giao dịch và gửi lại trong [hợp đồng chung](../CONTRACTS.md#3-patient-case-volume) |
| `GET/PATCH /cases/{id}` | Detail ca; PATCH ngày chụp/ghi chú |
| `DELETE /cases/{id}` | 202 xóa có theo dõi; 409 nếu queued/running |
| `POST /cases/{id}/volumes` | Multipart `modality` + `file`, 201 Volume validation result |
| `DELETE /cases/{id}/volumes/{volume_id}` | Chỉ khi đầu vào chưa bị khóa (`inputs_locked_at == null`); nếu đang khóa trả 409 `inputs_locked` (mở khóa lại khi hủy job `queued` có `attempt_count == 0` mà ca chưa có mask và chưa có job nào từng chạy) |
| `GET /cases/{id}/volumes` | Metadata và file IDs, không storage_key |
| `GET /files/{id}/content` | Stream binary qua ownership check, Content-Disposition an toàn |

Modality trùng trả `409 modality_exists`; người dùng xóa volume cũ rồi upload lại nếu ca chưa khóa đầu vào (`inputs_locked_at == null`). Không âm thầm ghi đè. Case detail chứa readiness, `inputs_locked_at`, `is_inputs_locked`, `can_run_inference`, `blocking_reasons` và `latest_mask_version_id`; UI không tự suy đoán đủ điều kiện chỉ từ số file.

## 4. Validation upload theo thứ tự

1. Xác thực role/owner; chỉ cho upload mới hoặc bổ sung modality còn thiếu khi ca chưa khóa đầu vào (`inputs_locked_at == null` và chưa có mask version), không thay volume đã khóa.
2. Chỉ chấp nhận hậu tố `.nii`/`.nii.gz`; hậu tố không thay thế kiểm tra magic/header.
3. Stream vào staging file; tối đa 100 MiB file nén/không nén. Request multipart cho một file, overhead tối đa 1 MiB.
4. Giải nén có giới hạn 256 MiB và kiểm tra header/data length; không giải nén không giới hạn vào RAM.
5. V1 nhận NIfTI scalar 3D, numeric datatype; từ chối 4D, complex, vector, shape rỗng, affine singular và spacing không hữu hạn/dương.
6. Dữ liệu cường độ phải hữu hạn; không tự thay NaN/Inf bằng 0. File lỗi trả 422, không publish volume.
7. Metadata geometry đọc bằng NiBabel. Đơn vị không gian NIfTI `xyzt_units` chấp nhận `mm` (`1.0`), `meter` (`1000.0`), `micron` (`0.001`) — quy đổi sang `mm` — và `unknown` (mã `0`, mặc định hệ số `1.0` = `mm` khi `qform/sform` hợp lệ) đồng nhất giữa BE validator và AI worker; các đơn vị không gian khác bị từ chối (422 `invalid_nifti`). Hai modality phải cùng shape, voxel spacing sai khác tuyệt đối ≤ `1e-4 mm`, affine sai khác từng phần tử ≤ `1e-4` trong đơn vị chuẩn hóa mm, `rtol=0`; `qform/sform` không mâu thuẫn đáng kể.
8. Kiểm tra model contract từ P0. V1 tham chiếu BraTS `(240,240,155)`, spacing `(1,1,1) mm`; chỉ xác nhận inference-ready khi contract thực đã được khóa. Không tự resize/resample/raw clinical preprocessing để ép hợp lệ.
9. Nếu geometry không tương thích với modality đã có: trả 422 `GEOMETRY_MISMATCH`, staging bị xóa; giữ file đã có nguyên vẹn.
10. Hash SHA-256, atomic commit file, commit DB. Khi đủ hai modality và model contract hợp lệ, `readiness=ready`.

Upload một modality hợp lệ được giữ ở trạng thái missing_inputs và có thể xem. Volume ngoài profile model nhưng NIfTI hợp lệ có thể xem; inference bị chặn. Chạy AI luôn yêu cầu cả hai. `_seg` không được suy luận như MRI đầu vào; không có endpoint ground-truth upload trong v1.

## 5. Storage, xóa và ranh giới dữ liệu

- Key dạng UUID do server tạo, không chứa tên bệnh nhân; file nằm dưới `STORAGE_ROOT` riêng có quyền filesystem phù hợp.
- Content download route xác thực Bearer. Frontend fetch Blob/ArrayBuffer rồi cấp dữ liệu cho viewer; không dùng public URL bỏ quyền.
- Quota mặc định local: toàn storage 20 GiB; mỗi doctor 2 GiB; có thể chỉnh bởi admin. Upload vượt quota trả 413 `STORAGE_QUOTA_EXCEEDED` trước khi commit.
- Không cho directory traversal qua filename, download filename hoặc storage adapter.
- Xóa đánh dấu resource đang deleting, chặn truy cập mới; hàng dọn file retry được và ghi trạng thái kỹ thuật. API trả deletion status để frontend theo dõi.
- Worker không claim job của ca đang deleting. Delete bị từ chối khi có job queued/running; người dùng hủy queued hoặc đợi job running hoàn tất.
- Dọn staging/orphan chỉ xóa file đã xác minh không có tham chiếu DB và quá 24 giờ; không xóa bằng wildcard theo tên bệnh nhân.

## 6. Nghiệm thu

- Hai bác sĩ dùng cùng patient_code được; trùng trong một bác sĩ trả 409.
- Thay owner_id trong body không thể chuyển quyền; list/search không rò dữ liệu.
- File truncated, fake extension, gzip bomb, NaN/Inf, 4D và affine hỏng bị từ chối rõ ràng.
- Đúng 100 MiB được kiểm tra tiếp, vượt giới hạn bị chặn khi streaming; tổng quota được kiểm tra atomic khi upload đồng thời.
- FLAIR/T1ce khác shape/orientation không được đánh dấu ready.
- Restart API không làm mất file đã commit; upload gián đoạn không tạo ca ready giả.
- Xóa ca/bệnh nhân loại bỏ quyền truy cập ngay và dọn đủ file, mask, metadata theo quy trình; audit kỹ thuật vẫn tồn tại không chứa PII.
