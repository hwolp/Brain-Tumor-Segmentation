---
name: api-tdd
description: Áp dụng TDD với pytest khi thêm, sửa hoặc review hành vi FastAPI trong Brain Tumor Segmentation, nhất là phân quyền, idempotency, trạng thái job và lưu mask.
---

# TDD cho API FastAPI

1. Đọc `docs/CONTRACTS.md`, spec BE liên quan và tìm test hiện có. Chọn một hành vi quan sát được qua HTTP.
2. **Red:** viết test tối thiểu trước thay đổi. Chạy riêng test và xác nhận nó thất bại đúng lý do nghiệp vụ. Lỗi import, fixture hoặc kết nối DB cần xử lý trước.
3. **Green:** thực hiện thay đổi nhỏ nhất đáp ứng hợp đồng. Chạy lại test và nhóm test trực tiếp liên quan.
4. **Refactor:** đơn giản hóa code hoặc fixture khi cần. Giữ nguyên kỳ vọng test và chạy lại nhóm kiểm thử.

Dùng pytest với FastAPI TestClient hoặc HTTPX ASGI transport theo cấu trúc hiện có. Dùng PostgreSQL test cô lập khi kiểm tra khóa, transaction hoặc constraint. Dùng fixture giả và storage tạm cho MRI. Mock worker AI ở ranh giới tích hợp nếu bài test chỉ nhắm tới API.

| Hành vi | Bằng chứng cần kiểm |
| --- | --- |
| Owner scope | Bác sĩ A bị trả 404 khi truy cập file của B. Admin gọi endpoint hồ sơ trả 403. |
| Lưu mask | Replay cùng khóa và payload trả cùng version ID, kể cả head đã thay đổi. Khóa mới với base cũ trả 409 và giữ nguyên dữ liệu. |
| Worker | Kết quả từ attempt hết lease bị từ chối và không tạo mask version. |
| Input AI | Thiếu FLAIR hoặc T1ce thì bị chặn chạy job. Ca đủ hai xung hợp lệ không cần file nhãn chuẩn. |

Ghi lệnh kiểm thử, kết quả Red/Green thực tế và giới hạn môi trường. Khi review thay đổi đã có, chỉ ghi nhận Red nếu có bằng chứng chạy test trước bản sửa.
