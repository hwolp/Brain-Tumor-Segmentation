# FE-01 — Nền tảng và thiết kế giao diện

## Mục tiêu / điều kiện bắt đầu

Phase P1. Có repository FE và hợp đồng API đang hình thành; có thể dùng fixture cho module chưa có API. Thiết kế là ứng dụng làm việc, không phải landing page quảng cáo.

## Cấu trúc triển khai

- `app`: router, providers, auth bootstrap, global error boundary.
- `features`: auth, patients, cases, viewer, jobs, admin; mỗi feature sở hữu components/hooks/API mapping của mình.
- `shared`: API client, UI primitives, form helpers, error mapping, định dạng ngày/đơn vị.
- `viewer-adapter`: lớp tương tác NiiVue, hình học, lịch sử nét vẽ, serialization; tách logic thuần để kiểm thử không cần WebGL.
- Query key luôn chứa phạm vi user khi dữ liệu theo tài khoản; logout phải hủy request và clear cache.

## Route và layout

| Route | Vai trò | Nội dung |
|---|---|---|
| `/login` | Khách | Đăng nhập |
| `/change-password` | Đã đăng nhập | Đổi mật khẩu bắt buộc/tự nguyện |
| `/doctor` | Bác sĩ | Tổng quan ca riêng |
| `/doctor/patients` | Bác sĩ | Danh sách bệnh nhân |
| `/doctor/patients/:id` | Bác sĩ | Hồ sơ và các lần chụp |
| `/doctor/cases/:id` | Bác sĩ | Thông tin ca, volume, job và phiên bản |
| `/doctor/cases/:id/viewer` | Bác sĩ | Viewer/editor |
| `/doctor/profile` | Bác sĩ | Tài khoản cá nhân |
| `/admin` | Admin | Tổng quan hệ thống |
| `/admin/users` | Admin | Tài khoản bác sĩ |
| `/admin/jobs` | Admin | Metadata tác vụ |
| `/admin/settings` | Admin | Cấu hình vận hành |
| `/admin/audit-events` | Admin | Nhật ký quản trị |

Router guard chờ auth bootstrap trước khi redirect. Route lỗi không hiển thị thoáng qua dữ liệu cache của người dùng trước. Trang 404/403 có đường quay lại vùng làm việc hợp lệ.

## Design tokens và thành phần

- Font Noto Sans hỗ trợ tiếng Việt, đóng gói local để bản cục bộ không phụ thuộc mạng. Body 16 px, line-height 1.5; nhãn phụ tối thiểu 12 px.
- Màu nền quản lý `#F8FAFC`, chữ chính `#0F172A`, màu hành động `#0369A1`, border `#CBD5E1`, lỗi `#B91C1C`. Dùng semantic tokens thay vì rải mã màu trong component.
- Viewer nền `#0B1020`, chữ `#F8FAFC`; vùng toolbar có nền khác canvas và focus nhìn rõ.
- Kích thước vùng bấm mục tiêu 44×44 px; focus ring rõ, tương phản chữ thường tối thiểu 4.5:1.
- Button/IconButton, FormField, DataTable, Pagination, Modal, ConfirmDialog, Alert, Toast, StatusBadge, Skeleton, EmptyState và ErrorState là component dùng chung.
- Nút icon có accessible name, tooltip bổ trợ; màu không là tín hiệu duy nhất. Status luôn có chữ.
- Loading có skeleton ở trang đọc, spinner tại hành động; disable nút đang submit, không khóa cả trang nếu không cần.
- Dialog giữ focus, Escape đóng khi không đang commit, đóng xong trả focus về phần tử mở dialog.
- Chuyển động ngắn 120–180 ms, tôn trọng reduced motion; không chuyển động trên canvas ảnh khi không do người dùng yêu cầu.

## Responsive và khả năng tiếp cận

- Từ 1024 px: đầy đủ editor, sidebar có thể thu gọn. Mốc nghiệm thu chính 1440×900 và 1280×800.
- 768–1023 px: viewer chỉ đọc, điều khiển lát và modality vẫn dùng được; hiển thị lý do nút sửa bị khóa.
- Dưới 768 px: ưu tiên hồ sơ/danh sách và viewer một khung chỉ đọc; không ép canvas ba khung nhỏ khó đọc.
- Không tràn ngang toàn trang; bảng rộng có vùng cuộn riêng và nhãn cột giữ ngữ nghĩa.
- Canvas không thể thay thế bằng screen reader: mọi điều khiển bên ngoài vẫn có label, giá trị lát/modality đọc được; không tuyên bố toàn bộ tác vụ tô mask hỗ trợ screen reader.

## Quản lý lỗi và request

- API error có envelope `{error: {code, message, details, request_id}}`, chi tiết field nếu có. Giao diện ánh xạ sang tiếng Việt, giữ request ID cho hỗ trợ.
- GET có tối đa 2 retry với backoff cho lỗi mạng/5xx; không retry 401/403/404/422 tự động trong query layer.
- Mutation không retry tự động. Upload/save chỉ retry có chủ ý với cùng khóa idempotency khi hợp đồng backend hỗ trợ.
- Request bị hủy khi đổi route không tạo toast lỗi. Giữ form đã nhập khi backend trả validation error.
- Không hiển thị stack trace, đường dẫn storage, SQL hoặc credential.

## Tiêu chí nghiệm thu

- Điều hướng trực tiếp/refresh từng route hoạt động; guard không làm nháy nội dung sai quyền.
- Loading/empty/error được kiểm tra cho mọi trang danh sách.
- Bàn phím đi qua menu, form, dialog theo thứ tự hợp lý; không mất focus.
- Bộ màu và typography dùng token; không có phụ thuộc CDN font khi chạy offline.
- Build TypeScript strict thành công; unit test cho formatters/error mapping và component tương tác chính.
