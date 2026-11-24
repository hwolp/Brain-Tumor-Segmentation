# Chia phase thành các phần triển khai song song

Mỗi mã trong bảng là một phạm vi có thể giao riêng. BE làm trong `BE/`, FE làm trong `FE/`, AI phụ trách adapter và manifest, QA kiểm theo tiêu chí của phase. Xem [kế hoạch phase](PHASES.md) để biết chi tiết và [hợp đồng chung](CONTRACTS.md) để thống nhất dữ liệu giữa các phần.

| Phase | Các phần có thể bắt đầu riêng | Điều kiện ghép và nghiệm thu |
|---|---|---|
| P0 | **P0-AI:** xác minh checkpoint, chạy FLAIR + T1ce, tạo mask cùng lưới ảnh và ghi manifest. Có thể làm cùng P1-BE và P1-FE. | **P0-QA:** đối chiếu hình học, nhãn, kết quả chạy thật và benchmark. Manifest xác minh là đầu vào của P5-AI. |
| P1 | **P1-BE:** tạo `BE/.venv`, khai báo dependency, dựng FastAPI, PostgreSQL, Alembic, health và xuất OpenAPI. **P1-FE:** dựng React/Vite, layout, thành phần chung, proxy và client với dữ liệu mẫu. | **P1-QA:** ghép FE với health API, sinh kiểu từ OpenAPI thật, kiểm build và migration trên DB trống. |
| P2 | **P2-BE:** JWT, phiên, phân quyền, quản lý tài khoản. **P2-FE:** đăng nhập, đổi mật khẩu, bảo vệ route và màn hình quản lý tài khoản với dữ liệu mẫu. | Sau P1 của phần tương ứng. **P2-QA:** ghép API thật rồi kiểm hết hạn phiên, refresh, khóa tài khoản và quyền theo vai trò. |
| P3 | **P3-BE:** bệnh nhân, ca, upload hai xung, khóa tạo ca và quyền tải file. **P3-FE:** form, danh sách, luồng tạo ca và upload theo hợp đồng. | Sau P2. **P3-QA:** ghép API thật và kiểm quyền sở hữu, retry tạo ca, lỗi file và readiness. Đối chiếu readiness với manifest đã xác minh nếu có. |
| P4 | **P4-BE:** lưu phiên bản mask, xử lý xung đột và xuất NIfTI. **P4-FE:** viewer, chuyển lát, tô/xóa, undo/redo và bản nháp với volume mẫu. | Sau P3. **P4-QA:** ghép lưu/tải thật, kiểm tọa độ và ghi đồng thời. Có thể nghiệm thu với mask mẫu hoặc mask trống. |
| P5 | **P5-BE:** API tác vụ, nhận job, thời hạn xử lý, retry và ghi kết quả. **P5-AI:** nối adapter P0 vào giao thức worker. **P5-FE:** tiến độ, lỗi và trạng thái offline với phản hồi mẫu. | BE/FE có thể dựng phần riêng sau P3. Ghép worker thật sau P0 và dùng giao diện phiên bản mask từ P4-BE. **P5-QA:** chạy một ca thật và kiểm worker dừng giữa chừng. |
| P6 | **P6-BE:** API admin, audit và metadata xuất kết quả. **P6-FE:** dashboard, lịch sử mask và trang in. Có thể chuẩn bị UI bằng dữ liệu mẫu. | Ghép chức năng vận hành sau P5 và phần bản xuất sau P4. **P6-QA:** kiểm dữ liệu admin và tính nhất quán giữa mask, metadata và bản in. |
| P7 | **P7-BE:** migration, backup/restore, runbook. **P7-FE:** build và kiểm trình duyệt. **P7-AI:** smoke và benchmark. | **P7-QA:** nghiệm thu xuyên suốt sau các phần P4–P6, tổng hợp kết quả và vấn đề còn mở. |
| P8 | Chia BE/FE/AI theo từng tính năng mở rộng được chọn. | Mỗi tính năng có hợp đồng và tiêu chí nghiệm thu riêng. |

Khi tách lượt chạy song song, thống nhất hợp đồng trước và giao một lượt chịu trách nhiệm sửa tài liệu hoặc cấu hình dùng chung. FE có thể hoàn thành giao diện trên dữ liệu mẫu trước, sau đó ghép API thật để đóng phần QA. Chỉ đánh dấu checklist của phase khi có bằng chứng cho mục tương ứng.

## Bắt đầu

Đọc quy trình phân vai, nạp skill và tiêu chí QA tại [AGENTS-AND-QA.md](AGENTS-AND-QA.md) kết hợp với [PHASES.md](PHASES.md), sau đó giao các phần theo mã. Có thể bắt đầu bằng hai yêu cầu riêng:

> Thực thi P0-AI theo đặc tả trong `PHASES.md` và `AGENTS-AND-QA.md`.

> Thực thi P1-BE theo đặc tả trong `PHASES.md` và `AGENTS-AND-QA.md`.

Khi muốn làm giao diện, giao thêm `P1-FE`. Dùng `P1-QA` khi phần BE và FE đã sẵn sàng để ghép.
