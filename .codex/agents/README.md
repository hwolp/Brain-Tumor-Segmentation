# Agent review

Các file TOML ở cấp này khai báo agent cho Codex. Mỗi thư mục con chứa hồ sơ Markdown để đọc và tra cứu theo vai trò.

| Agent | Phạm vi |
| --- | --- |
| [`code-reviewer`](code-reviewer/code-reviewer.md) | Rà soát thay đổi mã trước khi commit hoặc khi được giao xem PR hay diff. |
| [`doc-reviewer`](doc-reviewer/doc-reviewer.md) | Đối chiếu đặc tả và hướng dẫn vận hành đã sửa với phần triển khai. |
| [`frontend-designer`](frontend-designer/frontend-designer.md) | Rà soát khả năng sử dụng và tiếp cận của giao diện bác sĩ, admin và viewer MRI. |
| [`performance-reviewer`](performance-reviewer/performance-reviewer.md) | Rà soát suy giảm hiệu năng của API, PostgreSQL, tác vụ suy luận và viewer. |
| [`pr-test-analyzer`](pr-test-analyzer/pr-test-analyzer.md) | Rà soát độ phủ kiểm thử và TDD cho thay đổi API. |
| [`security-reviewer`](security-reviewer/security-reviewer.md) | Rà soát các biện pháp bảo vệ JWT, quyền truy cập và dữ liệu MRI riêng tư. |
| [`silent-failure-hunter`](silent-failure-hunter/silent-failure-hunter.md) | Rà soát lỗi bị che giấu giữa API, bộ lưu trữ, worker và giao diện. |

Ví dụ yêu cầu Codex dùng `code-reviewer` và `pr-test-analyzer` để review thay đổi API hiện tại. Khi thay đổi JWT hoặc phân quyền, thêm `security-reviewer`. Xem [skill API TDD](../skills/api-tdd/SKILL.md) và [kế hoạch QA](../../docs/AGENTS-AND-QA.md).

Mỗi hồ sơ Markdown ghi thao tác review trong bảng tools. Quyền công cụ thực tế lấy từ phiên Codex gọi agent. Các reviewer kết thúc bằng một dòng `REVIEW: PASS` hoặc `REVIEW: CHANGES-REQUESTED (...)`.
