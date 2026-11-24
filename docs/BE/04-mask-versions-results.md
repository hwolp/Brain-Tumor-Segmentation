# BE-04 — Phiên bản mask, thống kê và xuất kết quả

## 1. Phạm vi

Phase P4: backend phiên bản phục vụ editor; P6: metadata export và tóm tắt kết quả. Không có ground-truth upload, Dice/IoU hoặc tự chẩn đoán trong v1.

Cho phép xem một MRI và tạo mask thủ công trống khi chưa có AI; FLAIR/T1ce đầy đủ chỉ bắt buộc khi chạy AI. Reference volume được cố định ngay khi tạo mask đầu tiên; v1 ưu tiên FLAIR nếu có, nếu chỉ T1ce thì dùng T1ce. Sau đó không thay input volumes của ca.

## 2. Entity và invariants

`MaskVersion`: `id`, `case_id`, `version_number`, `source` (`ai`,`manual`), `base_version_id`, `reference_volume_id`, `file_id`, `created_by` nullable đối với worker, `job_id` nullable, `model_version_id` nullable, `created_at`, `note`, `label_voxel_counts`, `label_volumes_mm3`, `coverage_file_id`, `sha256`.

- Unique `(case_id, version_number)`; mask file bất biến. Không PATCH binary hoặc DELETE riêng một version trong v1.
- `base_version_id` mô tả nguồn chỉnh sửa; tạo version mới không đổi base file.
- `case.latest_mask_version_id` là head của chuỗi chỉnh sửa; lựa chọn xem một bản cũ trên frontend không tự đổi head.
- Save từ bản cũ trả 409; v1 chưa có fork/merge các nhánh mask. User có thể tải bản cũ nhưng không ghi đè head.
- Audit đầy đủ tác giả và thời điểm; không xem chỉnh sửa thủ công là output gốc của AI.

## 3. API

| Method/path | Input/output |
|---|---|
| `GET /cases/{id}/mask-versions` | List metadata từng version, không binary inline |
| `GET /mask-versions/{id}` | Detail version + statistics + file ID |
| `POST /cases/{id}/mask-versions` | Bắt buộc header `Idempotency-Key` và multipart `mask`, `base_version_id`, `reference_volume_id`, `note`. Trả 201 cùng phiên bản đã lưu. |
| `GET /mask-versions/{id}/export` | Binary `.nii.gz`, ownership checked |
| `GET /mask-versions/{id}/metadata` | Metadata+statistics; không storage paths |

Mọi path áp dụng prefix `/api/v1`. Mask trống ban đầu chỉ tồn tại trong RAM editor. Save đầu tiên gửi `base_version_id=null`, chỉ hợp lệ nếu ca chưa có version. Không có endpoint tạo mask trống riêng. V1 không tự retry save mutation; nếu response mất, FE tải lịch sử để đối chiếu trước khi người dùng lưu lại.

## 4. Save pipeline

1. Authorize doctor owner, ca không deleting; base version thuộc ca hoặc null cho save đầu tiên.
2. Stream file NIfTI theo limits upload; chỉ mask 3D integer với labels `{0,1,2,4}`.
3. Shape/affine/spacing phải khớp reference theo tolerance BE-02; không tự resample mask từ frontend.
4. Kiểm tra qform/sform và world coordinates sau serialization để chống lật trái/phải do viewer export.
5. Tính checksum/statistics server-side; không tin thể tích do frontend gửi.
6. Lock case; so sánh `base_version_id == latest_mask_version_id` (cả hai null được chấp nhận cho save đầu). Không khớp trả `409 mask_version_conflict` kèm latest version ID mà owner có quyền đọc.
7. Commit immutable file, tạo version_number mới, cập nhật head trong transaction và audit.
8. Trả metadata phiên bản mới. UI chỉ đánh dấu sạch khi nhận thành công.

Mỗi save hợp lệ tạo version mới, trả 201. FE tắt Save khi không có thay đổi để tránh phiên bản vô nghĩa. `note` tối đa 2000 ký tự.

## 5. Hình học và coverage

Frontend chỉnh ở axial slice nhưng gửi full 3D mask. Backend không giả định chiều array cuối là axial giải phẫu nếu affine khác; hợp đồng serialization phải được kiểm thử bằng volume synthetic bất đối xứng.

Coverage AI từ crop là thông tin vùng model đã thực sự xử lý, khác mask lớp u. Manual descendant giữ liên kết coverage nguồn AI; voxels người dùng thêm ngoài coverage vẫn được tính trong mask nhưng không biến thành AI-evaluated coverage. Mask manual tạo từ đầu có `coverage_file_id=null`.

## 6. Thống kê và export

Cho mỗi label 1/2/4: `voxel_count`, `volume_mm3`, `volume_ml`; total foreground là hợp của labels khác 0. Physical voxel volume dùng trị tuyệt đối determinant của phần 3×3 affine khi affine đã quy đổi mm; fixture profile trực giao bằng tích spacing. Tính `ml=mm3/1000`, giữ số thực đầy đủ backend, frontend làm tròn 2 số lẻ.

Không diễn giải thể tích thành mức độ nguy hiểm/chẩn đoán. Nhãn hiển thị theo manifest BraTS: 1 NCR/NET, 2 edema, 4 enhancing tumor, có chú giải phiên bản mapping.

JSON export gồm case ID, scan date, version ID/source/base, model version và pipeline hash nếu có, shape, affine, units, labels, statistics, coverage description, author display name và thời điểm. Không tự thêm thông tin hồ sơ không được yêu cầu. Export NIfTI giữ grid gốc, integer uint8, gzip.

Trang báo cáo/PDF bằng browser là FE; backend cung cấp DTO snapshot của đúng version đang xem. Báo cáo không tự lấy current version nếu người dùng đang xem version lịch sử.

## 7. Nghiệm thu

- Một MRI tạo được mask trống đúng shape/affine, không yêu cầu `_seg`.
- Save không thay byte/hash mask AI gốc.
- Lưu đồng thời hai tab từ cùng base: một thành công, một 409; không mất cập nhật.
- Download/upload round-trip cùng voxel labels, qform/sform và physical coordinates.
- Sửa một số voxel biết trước cho ra đúng count/volume; voxel chưa sửa giữ nguyên.
- Label lạ, float mask có giá trị phân số, shape lệch, affine lật trục bị từ chối.
- AI hoàn tất khi đã có manual head tạo head mới nhưng không sửa dữ liệu phiên bản cũ; FE không mất draft và stale save trả 409.
- Doctor B/admin không đọc metadata, statistics hoặc binary của doctor A.

### Gửi lại yêu cầu lưu

Sau khi kiểm tra quyền hiện tại, tra khóa theo bác sĩ và ca trước khi kiểm tra phiên bản nền. Cùng khóa và cùng digest trả phiên bản đã lưu. Cùng khóa nhưng khác digest trả 409 `idempotency_conflict`. Ghi liên kết khóa với phiên bản trong cùng transaction. Xem [hợp đồng lưu mask](../CONTRACTS.md).
