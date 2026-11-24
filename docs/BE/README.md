# Backend specification — Brain Tumor Segmentation

Trạng thái: **v1 (P0–P7) đã được triển khai và nghiệm thu đầy đủ** theo bộ đặc tả này (xem [IMPLEMENTATION-CHECKLIST.md](../IMPLEMENTATION-CHECKLIST.md) và các báo cáo trong `docs/reports/`, tổng hợp tại [P7-QA-acceptance.md](../reports/P7-QA-acceptance.md)). Ngày chốt đặc tả gốc: 17/11/2026.

## 1. Phạm vi và nguyên tắc

- FastAPI phục vụ API; PostgreSQL là nguồn sự thật cho quyền, metadata, phiên bản và job.
- Bác sĩ sở hữu bệnh nhân/ca của mình. Admin chỉ quản lý hệ thống, không được truy cập nội dung bệnh nhân qua API.
- AI v1 dùng FLAIR + T1ce cùng ca; file ground truth `_seg.nii` không phải đầu vào inference.
- File NIfTI lưu riêng ngoài web root. Không trả đường dẫn storage tuyệt đối cho client.
- Mask AI bất biến; chỉnh sửa tạo phiên bản mới. Tọa độ ảnh được giữ xuyên suốt upload → inference → chỉnh sửa → export.
- Chạy local trước; dữ liệu thử là BraTS và hồ sơ giả. Không mô tả bản v1 là hệ thống đã thẩm định lâm sàng.
- Quyền admin ở ứng dụng không ngăn người sở hữu máy chủ truy cập hạ tầng/storage bên dưới.

## 2. Danh mục module

| Spec | Nội dung | Phase |
|---|---|---|
| [01 — Auth/RBAC](01-auth-rbac.md) | JWT, session, mật khẩu, ownership | P2 |
| [02 — Patients/Cases/Files](02-patients-cases-files.md) | Hồ sơ, MRI, validation, storage | P3 |
| [03 — AI/Worker/Jobs](03-ai-worker-jobs.md) | Adapter TDA, queue, lease, phục hồi | P0, P5 |
| [04 — Mask/Results](04-mask-versions-results.md) | Phiên bản, thống kê, export | P4, P6 |
| [05 — Admin/Operations](05-admin-operations.md) | Tài khoản, vận hành, audit | P2, P6 |
| [06 — Testing/Deployment](06-testing-deployment.md) | CI, nghiệm thu, local release | P1, P7, P8 |

## 3. Cấu trúc thư mục triển khai

```text
BE/
  app/
    api/                  # routers /api/v1 và /api/v1/internal (v1/*)
    core/                 # config, db, errors, logging, security, storage adapter
    models/               # SQLAlchemy ORM models
    repositories/         # truy vấn PostgreSQL và khóa giao dịch
    schemas/              # Pydantic request/response DTOs
    services/             # nghiệp vụ, phân quyền, validation, reaper
    dependencies.py       # FastAPI dependencies, auth/CSRF guards
    main.py               # khởi tạo FastAPI app, middleware, lifespan
  migrations/             # Alembic migrations (0001_p1 .. 0006_p6)
  openapi/                # openapi.json xuất tự động từ FastAPI
  scripts/                # bootstrap_admin, export_openapi, backup_restore, smoke/E2E
  tests/                  # unit, integration, contract, ai
  worker/                 # TDA-SegUNet adapter, manifest.json và HTTP worker service
```

Router chỉ parse request và gọi service. Service chịu trách nhiệm authorization và transaction. Storage adapter cung cấp `put_temp`, `commit`, `open`, `delete`; dữ liệu đường dẫn do server sinh. Không copy logic preprocessing vào router.

## 4. Quy ước API chung

- Prefix API public `/api/v1`; API worker `/api/v1/internal` và credential riêng.
- ID UUID; datetime ISO 8601 UTC. UI hiển thị theo Asia/Ho_Chi_Minh.
- DTO JSON dùng `snake_case`; enum dùng giá trị chữ thường.
- Response thành công trả resource trực tiếp; list trả `{items, page, page_size, total}`.
- Phân trang `page=1`, `page_size=20`, tối đa 100. Thứ tự mặc định `created_at desc, id desc`.
- Lỗi `{error: {code, message, details, request_id}}`. `details` không chứa đường dẫn, stack trace, token hoặc dữ liệu bệnh nhân ngoài phạm vi quyền.
- 401 thiếu/sai/hết hạn phiên; 403 sai vai trò; 404 ID không tồn tại hoặc không thuộc bác sĩ; 409 xung đột trạng thái/phiên bản; 413 quá dung lượng; 422 validation; 429 giới hạn truy cập; 503 dịch vụ bắt buộc chưa sẵn sàng.
- JSON lỗi validation chuẩn hóa về cùng envelope; frontend không parse chuỗi thông báo để xác định hành vi.
- OpenAPI là hợp đồng để sinh TypeScript. Thay đổi DTO phải cập nhật test hợp đồng trước khi merge.
- Endpoint liên quan hồ sơ, file, auth dùng `Cache-Control: no-store`.

## 5. Transaction và nhất quán

- Authorization theo `user_id` lấy từ phiên hợp lệ, không lấy `owner_id` từ body.
- Mọi truy vấn con (file, mask, job) join về ca/bệnh nhân và owner; không chỉ kiểm tra quyền ở màn hình.
- Database enforce unique patient code theo owner, một modality/ca, một job active/ca và sequence mask/ca.
- Filesystem và DB không cùng transaction: ghi staging, kiểm tra, atomic rename, sau đó commit resource; dọn orphan có kiểm soát.
- Tác vụ chậm như inference không chạy trong HTTP request hoặc `BackgroundTasks` của API.
- Không hard-code đường dẫn ổ D vào ứng dụng. Checkpoint, storage root và DB đều qua config.

## 6. Ranh giới phase

P0 chốt model contract; P1 dựng nền; P2 quyền; P3 dữ liệu; P4 phiên bản mask; P5 inference; P6 quản trị/kết quả; P7 release. P8 mới có GT scoring, chia sẻ ca, DICOM/PACS và chuyển cloud. Thử nghiệm nội bộ bằng nhãn chuẩn để kiểm tra AI không đồng nghĩa đưa tính năng GT scoring vào v1.
