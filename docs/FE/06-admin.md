# FE-06 — Quản trị hệ thống

## Nguyên tắc

Admin là chủ hệ thống trong tầng ứng dụng. Không có quyền xem hồ sơ, ảnh MRI, mask, nhận xét bác sĩ hoặc bản in kết quả. Các màn hình chỉ dùng metadata vận hành đã lọc tại backend. Quyền quản trị máy chủ thực tế nằm ngoài giới hạn vai trò ứng dụng này.

## P2 — Tài khoản bác sĩ

- Danh sách người dùng: tên tài khoản, tên hiển thị, trạng thái, ngày tạo; tìm kiếm/lọc/phân trang.
- Tạo tài khoản doctor bằng form; backend trả mật khẩu tạm một lần hoặc nhận mật khẩu tạm theo hợp đồng. Dialog một lần có nút copy, không ghi vào log hoặc cache bền vững.
- Khóa/mở tài khoản có xác nhận; khóa thông báo các phiên sẽ bị thu hồi, không xóa bệnh nhân.
- Reset mật khẩu cấp thông tin tạm và buộc đổi lần tiếp theo; admin không xem mật khẩu cũ.
- Không cho UI đổi doctor thành admin hay tạo admin mới. Bootstrap/admin lifecycle do công cụ vận hành riêng trong bản đầu.
- API: `GET/POST /admin/users`, `PATCH /admin/users/{id}` với `is_active` theo OpenAPI, `POST /admin/users/{id}/reset-password`. Không tạo endpoint lock/unlock riêng.

## P6 — Dashboard vận hành

- Cards: tài khoản hoạt động/bị khóa; job queued/running/failed; dung lượng đã dùng; worker online/offline.
- Không hiện tên bệnh nhân, thumbnail, tên file chứa thông tin bệnh nhân hoặc link sang viewer.
- Refresh 15 giây khi dashboard đang mở; nút cập nhật thủ công; thông tin stale có nhãn thời điểm cập nhật.
- Worker online/offline dựa trên API với ngưỡng heartbeat 90 giây. Hiển thị model version, loại thiết bị CPU/GPU và số job đang xử lý nếu được phép.

## Quản lý job

- Lọc theo trạng thái, thời gian, ID job, tài khoản doctor; không tìm theo tên bệnh nhân.
- Hiển thị ID kỹ thuật, model version, tiến độ, thời điểm, attempt và error code đã khử dữ liệu nhạy cảm.
- Cho retry job failed nếu backend cho phép; không retry running/succeeded/cancelled qua cùng action.
- Sau retry chuyển tới job/lượt xử lý API trả về; không tự sửa status local thành running.
- V1 admin chỉ retry job lỗi, không có action cancel quản trị; bác sĩ sở hữu hủy job queued qua màn hình ca. Admin không tải input/output để debug qua web.

## Settings và audit

- Cấu hình: nhận job mới bật/tắt, giới hạn upload trong ngưỡng server hỗ trợ. Form hiển thị giá trị hiện tại và cảnh báo chỉ áp dụng cho request mới.
- Model đang hoạt động hiển thị read-only. Không có nút tải `.pt` hoặc thực thi checkpoint tùy ý trong web.
- Dung lượng: tổng đã dùng và số file theo loại, không lộ đường dẫn/case medical content.
- Audit: actor, action, target technical ID, thời gian, kết quả, request ID; filter/pagination. Không render raw JSON chứa secrets.
- API theo nhóm `/admin/overview`, `/admin/jobs`, `/admin/workers`, `/admin/models`, `/admin/settings`, `/admin/audit-events`.

## Xử lý lỗi và bảo vệ thao tác

- Mọi mutation có pending state, tránh double submit; form settings giữ giá trị khi validation lỗi.
- 403 đưa về trang không có quyền; không fallback sang gọi endpoint bác sĩ.
- Retry/khóa tài khoản thành công cần refetch, không dựa duy nhất vào optimistic UI cho trạng thái bảo mật.
- Không tự giải quyết lỗi job bằng hiển thị stack trace; dùng mã lỗi và request ID.

## Nghiệm thu

- Admin tạo/khóa/mở/reset tài khoản đúng, bác sĩ bị khóa mất quyền truy cập ngay theo backend.
- Không có dữ liệu patient hoặc ảnh trong DOM/network response admin hợp lệ.
- Gõ URL viewer/file bằng admin bị server từ chối, không chỉ ẩn menu.
- Retry/dừng nhận job/cập nhật giới hạn có audit event và phản ánh đúng sau refresh.
- Audit error handling không làm lộ mật khẩu tạm, token, storage path.
