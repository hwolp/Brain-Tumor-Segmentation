# Brain Tumor Segmentation — Bộ đặc tả triển khai

Ngày lập: 17/11/2026. Trạng thái: **bản phát hành cục bộ v1 (P0–P7) đã được triển khai và nghiệm thu đầy đủ** (xem [IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md) và các báo cáo nghiệm thu trong `docs/reports/` từ [P0-AI-verification.md](reports/P0-AI-verification.md) đến [P7-QA-acceptance.md](reports/P7-QA-acceptance.md); P8 giữ ở trạng thái backlog sau v1).

## Đọc theo thứ tự

1. [SPEC tổng thể](SPEC.md): phạm vi, vai trò, kiến trúc và các quyết định đã chốt.
2. [Kế hoạch từng phase](PHASES.md): đầu vào, công việc, bàn giao, điều kiện qua phase.
3. [Hợp đồng tích hợp](CONTRACTS.md): quy ước API, dữ liệu và các bất biến FE/BE/AI.
4. [Backend](BE/README.md): đặc tả chi tiết theo module phía server.
5. [Frontend](FE/README.md): màn hình, tương tác, trạng thái và kiểm thử.
6. [Skill, agent và QA](AGENTS-AND-QA.md): cách chia việc, nạp skill, kiểm tra độc lập.
7. [Theo dõi công việc](IMPLEMENTATION-CHECKLIST.md): checklist triển khai và bằng chứng nghiệm thu P0–P7.
8. [Chia phần song song](PARALLEL-TRACKS.md): mã công việc BE, FE, AI và QA để chạy riêng.

## Cấu trúc tài liệu

```text
docs/
  README.md
  SPEC.md
  PHASES.md
  CONTRACTS.md
  AGENTS-AND-QA.md
  IMPLEMENTATION-CHECKLIST.md
  PARALLEL-TRACKS.md
  BE/
    README.md
    01-auth-rbac.md
    02-patients-cases-files.md
    03-ai-worker-jobs.md
    04-mask-versions-results.md
    05-admin-operations.md
    06-testing-deployment.md
  FE/
    README.md
    01-foundation-design.md
    02-auth-navigation.md
    03-patients-cases-upload.md
    04-viewer-mask-editor.md
    05-jobs-results.md
    06-admin.md
    07-testing.md
  reports/
    P0-AI-verification.md
    P1-QA-acceptance.md
    P2-QA-acceptance.md
    P3-QA-acceptance.md
    P4-QA-acceptance.md
    P5-QA-acceptance.md
    P6-QA-acceptance.md
    P7-QA-acceptance.md
```

## Quy tắc sử dụng

- Quyết định sản phẩm trong `SPEC.md` và hợp đồng dùng chung trong `CONTRACTS.md` là nguồn chuẩn khi tài liệu module diễn đạt khác nhau. Khi đổi hợp đồng, sửa cả module và kiểm thử liên quan trong cùng thay đổi.
- `PHASES.md` quy định thứ tự phụ thuộc; số module không phải thứ tự triển khai cứng.
- Mỗi phase chỉ hoàn tất khi có bằng chứng nghiệm thu. Mock chạy được không đồng nghĩa AI thật đã được tích hợp.
- Đối chiếu ground truth ở giao diện nằm ở P8; kiểm thử hình học và tính đúng pipeline AI vẫn bắt buộc ở P0–P7.
- Mọi đường dẫn dự án AI ngoài workspace chỉ là nguồn tham khảo cục bộ, không hardcode vào ứng dụng khi triển khai.
- Các giá trị giới hạn là mặc định thiết kế của bản đầu, không phải mô tả chính sách của nhà cung cấp cloud.
