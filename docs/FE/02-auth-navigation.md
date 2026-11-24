# FE-02 — Xác thực, phiên và điều hướng

## Phạm vi P2

Đăng nhập tài khoản admin/bác sĩ, bootstrap phiên bằng refresh cookie, đổi mật khẩu, logout và chặn route theo vai trò. Không tự đăng ký công khai, không OAuth hoặc email reset trong bản đầu.

## State machine

`bootstrapping → anonymous | authenticated | must_change_password`.

- Khi tải app: gọi refresh một lần; thành công lấy access token và `/auth/me`; không có cookie hợp lệ thì về anonymous.
- Access token chỉ nằm trong bộ nhớ runtime. Refresh cookie do server thiết lập HttpOnly; JavaScript không đọc/ghi token này.
- Access token sống 15 phút; refresh family hết hạn cố định sau tối đa 7 ngày từ login, không gia hạn vô hạn qua rotation. Cookie `bts_refresh`, SameSite=Lax, Path `/api/v1/auth`, không Domain.
- Bootstrap lỗi mạng hiển thị trang thử lại; không coi người dùng là đã logout chỉ vì API tạm thời không truy cập được.
- `must_change_password` chỉ cho phép trang đổi mật khẩu và logout; không prefetch hồ sơ bệnh nhân.

## API và hành vi

| Endpoint | Frontend xử lý |
|---|---|
| `POST /auth/login` | Gửi thông tin đăng nhập; giữ form khi sai, thông báo chung không tiết lộ tài khoản tồn tại |
| `POST /auth/refresh` | `credentials: include`, single-flight trong một tab, cập nhật access token |
| `GET /auth/me` | Nhận ID, vai trò, trạng thái buộc đổi mật khẩu và thông tin hiển thị |
| `POST /auth/change-password` | Xác thực form; thành công theo chính sách thu hồi phiên backend và đăng nhập lại |
| `POST /auth/logout` | Thu hồi phiên trên server, dọn bộ nhớ/cache rồi về login |

Cookie endpoints được backend kiểm tra Origin theo hợp đồng cùng origin; không dùng access/refresh JWT làm token CSRF. Localhost HTTP sử dụng cấu hình cookie dev; không hardcode việc bỏ Secure cho các hostname khác. Khi chuyển kiến trúc cross-origin phải cập nhật riêng chính sách CSRF/CORS/cookie, không chỉ nới allowlist.

## Refresh và request đang chạy

- Khi access token hết hạn: chỉ một promise refresh chạy, các request chờ kết quả của promise đó.
- Read request có thể phát lại tối đa một lần sau refresh thành công. Không tạo vòng lặp 401 → refresh → 401.
- Upload, lưu mask và mutation đã có khả năng được server xử lý không phát lại âm thầm. Kiểm tra kết quả trước, hoặc cho người dùng retry với cùng khóa idempotency theo hợp đồng backend.
- Tab đang gửi refresh phải phối hợp qua Web Locks/BroadcastChannel trước khi dùng chung refresh cookie; kênh này chỉ truyền trạng thái phối hợp, không phát tán token.
- Nếu Web Locks không có, các tab xử lý mất phiên rõ ràng; không tự nới lỏng reuse detection ở backend để che lỗi UI.
- Khi hết hạn refresh token hoặc gặp `refresh_reused`: nếu không có chỉnh sửa mask chưa lưu (`!isDirty`), hủy các request đang chạy, xóa sạch query cache, object URLs, toasts và bộ nhớ ảnh/mask rồi chuyển về `/login` với lý do ngắn gọn; nếu đang có bản nháp mask chưa lưu (`isDirty`), UI khóa thao tác và mở `ReauthModal` cho phép cùng bác sĩ đăng nhập lại tại chỗ để giữ nguyên bản nháp trong RAM.
- Khi tài khoản bị khóa (`account_disabled`), thu hồi do đổi mật khẩu, hoặc đăng nhập sang tài khoản khác: hủy ngay mọi request, xóa sạch toàn bộ dữ liệu bộ nhớ phiên và không bao giờ giữ dữ liệu bệnh nhân sang tài khoản mới.

## Editor và hết phiên

- Access token hết hạn nhưng refresh được: giữ nguyên mask chưa lưu (`isDirty`) trong bộ nhớ RAM.
- Refresh token hết hạn (hoặc `refresh_reused`) trong lúc đang có chỉnh sửa mask chưa lưu (`isDirty`): UI khóa thao tác và hiển thị `ReauthModal` cho phép đúng bác sĩ hiện tại xác thực lại để tiếp tục phiên và giữ nguyên bản nháp trong RAM (hoặc tự khôi phục khi tab khác của cùng bác sĩ đăng nhập/làm mới phiên thành công qua `BroadcastChannel`). Không lưu mask vào `localStorage`/`IndexedDB` như một cách khôi phục ngầm.
- Chỉ xóa sạch dữ liệu bộ nhớ (query cache, MRI buffers, bản nháp mask trong RAM, object URLs) khi người dùng chủ động chọn đăng xuất / bỏ bản nháp, đổi sang tài khoản khác, hoặc tài khoản bị khóa (`account_disabled`).
- Người dùng bấm logout (hoặc điều hướng rời Viewer) khi `isDirty`: hộp thoại xác nhận chọn quay lại hoặc bỏ thay đổi. Không thể dùng hộp thoại để trì hoãn khóa tài khoản từ server.
- Trước thao tác lưu lớn, refresh chủ động nếu access token gần hết hạn để giảm nguy cơ upload bị gián đoạn.

## Điều hướng theo vai trò

- Login admin → `/admin`; doctor → `/doctor`. Return URL chỉ chấp nhận đường dẫn nội bộ và thuộc vai trò.
- Admin không có item Bệnh nhân/Viewer. Gõ URL trực tiếp phải bị guard chặn và backend vẫn từ chối.
- Sidebar không chứa dữ liệu bệnh nhân; breadcrumb chỉ lấy dữ liệu sau khi quyền được backend xác nhận.
- Khóa tài khoản được phát hiện qua request/API; không chờ token tự hết hạn.

## Tiêu chí nghiệm thu / test

- Token không xuất hiện trong localStorage, URL, console hoặc crash report.
- 10 GET đồng thời cùng gặp expiry tạo một refresh trong một tab và mỗi GET phát lại không quá một lần.
- Hai tab không vô tình tái sử dụng refresh token do race trong luồng thông thường.
- Cookie hợp lệ khôi phục phiên sau refresh trang; cookie không hợp lệ trở về login.
- Tài khoản buộc đổi mật khẩu không lấy được dữ liệu nghiệp vụ trước khi đổi.
- Logout/chuyển tài khoản không để lại ảnh hoặc query cache của người trước.
- Upload/save timeout không tự tạo thêm ca/phiên bản.
