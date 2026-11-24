# FE-03 — Bệnh nhân, ca chụp và upload

## Phạm vi và API

Phase P3. Các route nghiệp vụ chỉ dành cho doctor và dữ liệu thuộc doctor hiện tại.

API sử dụng: `/patients`, `/patients/{id}`, `/patients/{id}/cases`, `/cases/{id}`, `/cases/{id}/volumes`, `/files/{id}/content`. Type/pagination/error chi tiết theo OpenAPI backend.

## Danh sách và hồ sơ bệnh nhân

- Tìm theo mã hoặc họ tên trong phạm vi bác sĩ; phân trang 20; giữ query trên URL.
- Form gồm `patient_code`, `full_name`, `birth_year`, `sex`; mã/họ tên bắt buộc. Mã 1–50 ký tự sau trim, duy nhất theo doctor không phân biệt hoa thường; họ tên 1–150 ký tự. Năm sinh số nguyên từ 1900 đến năm hiện tại; giới tính chọn `male`, `female`, `other`, `unknown` theo enum API.
- Mã trùng trả lỗi tại field patient_code; không tạo bản sao tự động.
- Chi tiết hiển thị thông tin tối thiểu, các ca theo ngày mới nhất, nút tạo ca và sửa hồ sơ.
- Không triển khai tìm bệnh nhân toàn viện hay dò mã bệnh nhân bác sĩ khác.

## Tạo ca

1. Mở từ hồ sơ bệnh nhân; không nhập lại patient ID thủ công.
2. Nhập ngày chụp không ở tương lai và ghi chú tùy chọn tối đa 5000 ký tự; tạo ca draft.
3. Chuyển đến màn hình ca có hai vùng upload độc lập: FLAIR và T1ce.
4. Sau mỗi upload, API kiểm tra volume; frontend hiển thị shape, voxel spacing, modality, tên file và kết quả kiểm tra.
5. Khi đủ hai modality hợp lệ và tương thích, backend trả khả năng `readiness=ready`; frontend không tự suy ra chỉ từ việc có hai file.

Tạo một UUID cho mỗi lần người dùng xác nhận tạo ca và gửi qua header `Idempotency-Key`. Giữ khóa và nội dung đã gửi khi chưa rõ kết quả do timeout. Khi người dùng chọn thử lại, gửi đúng khóa và nội dung cũ. Chuyển đến trang ca khi nhận ID từ phản hồi 201. Nếu muốn gửi nội dung khác, làm mới danh sách ca để đối chiếu trước khi xác nhận một lần tạo mới với khóa mới. Hiển thị lỗi 409 do xung đột khóa hoặc ca đã bị xóa và tải lại danh sách.

## Upload

- Hỗ trợ file chooser và kéo thả; mỗi ô nhận một file `.nii` hoặc `.nii.gz`.
- Mỗi file tối đa 100 MiB; kiểm tra tên mở rộng và size phía client là hỗ trợ UX, backend kiểm tra nội dung thật và giới hạn giải nén 256 MiB.
- Không cho một file `_seg` được tự gán thành FLAIR/T1ce. Cảnh báo tên có `_seg`; quyết định từ validation server.
- Trong bản đầu upload trực tiếp authenticated API; không đưa file qua frontend server hoặc public URL.
- Dùng tiến độ upload thực qua XHR/adapter tương đương; sau khi gửi xong chuyển sang trạng thái “Đang kiểm tra ảnh”, không giữ giả 99%.
- Upload tuần tự từng file để giới hạn RAM và giảm lỗi; giữ file còn lại trong bộ nhớ tab nếu file đầu lỗi.
- Cho hủy upload đang gửi; thành công/hủy phải reconcile trạng thái ca từ server.
- Không cho đổi/xóa volume khi đã có job hoặc mask version. Muốn dùng bộ ảnh khác, tạo ca mới để bảo toàn lịch sử.
- Reference volume ưu tiên FLAIR; nếu bắt đầu mask thủ công khi chỉ có T1ce, reference cố định vào T1ce. Bổ sung FLAIR sau đó phải cùng grid và không được thay reference của mask đã có.
- Không đưa file chưa xác minh vào viewer như dữ liệu hợp lệ.
- Profile AI dự kiến BraTS 240×240×155, spacing 1 mm, được chốt bằng manifest P0. File ngoài profile còn xem được nếu hợp lệ cho viewer nhưng AI bị chặn; không tự resample hoặc registration tại frontend.
- Upload v1 trả 201 sau validation thành công hoặc 422 khi reject. Trạng thái “Đang kiểm tra ảnh” là lúc request còn chờ; không cần endpoint polling upload riêng.

## Trạng thái màn hình ca

| Trạng thái | Hành vi |
|---|---|
| Chưa có ảnh | Hiện hai ô upload và hướng dẫn |
| Có một volume hợp lệ | Cho mở viewer/manual; AI khóa, nêu modality còn thiếu |
| Đang upload/validate | Tiến độ và thông báo cụ thể; không tạo job |
| Hai volume không khớp | Hiển thị lỗi hình học, không chạy AI; không tự resize frontend |
| Sẵn sàng | Cho chạy AI và mở viewer |
| Có job đang chờ/chạy | Khóa thay ảnh, hiển thị job hiện hành |
| Có kết quả | Cho chọn phiên bản, sửa, tải xuống |

## Lỗi và xóa

- Sai định dạng, NIfTI bị cắt cụt, thiếu modality, không hỗ trợ số chiều, quá dung lượng: hiển thị tại ô file liên quan và giữ ca draft.
- 403/404 của ca: không hiển thị thông tin từ cache; thông báo không truy cập được ca.
- Xóa bệnh nhân/ca có dialog nêu phạm vi dữ liệu bị xóa. Nếu active job: server chặn, UI nêu cần chờ hoàn tất/hủy queued job.
- Sau xóa thành công, invalidate danh sách và điều hướng về parent; không chỉ xóa hàng tại client.
- Không hiển thị đường dẫn tuyệt đối của máy chủ hoặc lỗi parse nội bộ.

## Nghiệm thu

- Tạo bệnh nhân → tạo ca → upload đúng FLAIR/T1ce → trạng thái sẵn sàng.
- Upload nhầm modality, file sai shape/affine hoặc file hỏng không mở nút AI.
- Upload một file vẫn mở viewer được; chưa có AI không cần mask `_seg`.
- Hủy/mất mạng/401 không tạo volume trùng hoặc hiển thị hoàn tất giả.
- Patient/case ID của bác sĩ khác không lộ qua deep link, search, download hoặc cache.
- Form không mất dữ liệu hợp lệ khi một field lỗi; keyboard và drag/drop cho kết quả tương đương.
