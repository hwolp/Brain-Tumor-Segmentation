# Workflow triển khai theo phase

Dùng từ chat Codex đang mở ở gốc dự án. Chọn mã trong [bảng chia phần song song](../../docs/PARALLEL-TRACKS.md), rồi dán prompt bên dưới với phạm vi bạn chọn.

## Thứ tự triển khai

| Mốc | Việc giao cho Codex | Bằng chứng cần có khi bàn giao |
|---|---|---|
| P0 | Xác minh checkpoint và adapter TDA-SegUNet với FLAIR + T1ce | Manifest, một lần suy luận thật và kiểm tra mask cùng lưới ảnh |
| P1 | Dựng FastAPI, React, PostgreSQL, migration, OpenAPI và môi trường local | Khởi động được, API health phản hồi, build FE và kiểm tra migration |
| P2 → P3 | Xác thực, phân quyền, hồ sơ, tạo ca và upload | Test JWT, quyền sở hữu, hai xung MRI và gửi lại tạo ca với cùng khóa |
| P4 | Viewer và chỉnh mask từng lát | Kiểm tra tọa độ, lưu phiên bản, xử lý xung đột và xuất NIfTI |
| P5 → P6 | Worker AI, trạng thái tác vụ, quản trị và xuất kết quả | Một luồng AI thật, khôi phục tác vụ khi worker dừng và kiểm tra quyền admin |
| P7 | Nghiệm thu local | Kiểm thử đầu-cuối, báo cáo benchmark và phục hồi dữ liệu |

P0 và P1 độc lập. Nếu chưa xác minh được checkpoint, ghi điều kiện còn thiếu ở P0 và tiếp tục phần nền P1. P5 tích hợp AI thật sau khi P0 đạt. Xem [kế hoạch phase](../../docs/PHASES.md) để biết đầy đủ quan hệ phụ thuộc. P8 mở rộng theo phạm vi được giao riêng.

## Prompt chạy lần đầu

Sao chép nguyên khối dưới đây vào chat Codex.

```text
Thực thi workflow ở .codex/workflows/implement-phase.md cho P1-BE theo docs/PARALLEL-TRACKS.md. Các phần khác trong bảng được giao riêng.

1. Đọc docs/PHASES.md, docs/SPEC.md, docs/CONTRACTS.md, docs/IMPLEMENTATION-CHECKLIST.md và spec BE/FE liên quan. Kiểm tra workspace để biết phần nào đã có. Nạp các SKILL.md đúng phase theo bảng skill. Với P0, kiểm tra mô hình cục bộ và dữ liệu mẫu được nêu trong spec. Với P1, khởi tạo Git nếu workspace chưa là repository để có phạm vi rà soát thay đổi.
2. Triển khai các công việc thuộc phạm vi đã giao, theo thứ tự phụ thuộc khi có. Nếu phần AI thật thiếu dữ liệu hoặc checkpoint phù hợp, ghi rõ điều kiện còn thiếu và tiếp tục P1. Khi thêm hoặc đổi hành vi API, áp dụng api-tdd và lưu bằng chứng Red/Green. Dùng dữ liệu mẫu và môi trường test cô lập.
3. Chạy các kiểm tra tương ứng với tiêu chí nghiệm thu trong docs/PHASES.md. Báo chính xác lệnh đã chạy, kết quả và kiểm tra nào còn thiếu điều kiện.
4. Dùng subagent doc-reviewer cho thay đổi tài liệu. Với thay đổi code, dùng code-reviewer và pr-test-analyzer. Nếu diff chạm JWT, phân quyền hoặc dữ liệu MRI riêng tư, dùng thêm security-reviewer. Chỉ giao các reviewer phạm vi thay đổi của lượt này. Nếu tên agent tùy chỉnh chưa có trong phiên, dùng subagent với chỉ dẫn từ hồ sơ tương ứng trong .codex/agents. Xử lý phát hiện có căn cứ trong phạm vi và kiểm tra lại phần đã sửa.
5. Cập nhật docs/IMPLEMENTATION-CHECKLIST.md với các mục có bằng chứng hoàn thành. Bàn giao theo từng phase gồm thay đổi, kết quả kiểm tra, kết quả review và bước còn lại. Dừng ở cuối phạm vi đã giao.
```

Thay `P1-BE` bằng `P0-AI`, `P1-FE` hoặc mã phần tiếp theo và áp dụng các bước trong đúng phạm vi đó. Khi giao nhiều phần cùng lượt, liệt kê từng mã và báo kết quả riêng theo mã.
