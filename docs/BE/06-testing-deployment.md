# BE-06 — Kiểm thử, triển khai local và bàn giao

## 1. Chiến lược kiểm thử theo phase

Dùng [skill API TDD](../../.codex/skills/api-tdd/SKILL.md) ở từng phase có thay đổi hành vi API. Viết bài kiểm thử pytest qua HTTP, xác nhận thất bại đúng lý do, triển khai để test đạt rồi chạy lại sau khi chỉnh mã. Agent QA rà soát độc lập bằng chứng Red/Green và các lỗi còn mở.

| Phase | Test bắt buộc trước khi qua mốc |
|---|---|
| P0 | Checkpoint compatibility, inference không `_seg`, crop restoration, label mapping, benchmark |
| P1 | Config validation, migrations fresh DB, health, build, secret exclusion |
| P2 | JWT, rotation/reuse, disable/logout, CSRF, role/owner negative tests |
| P3 | NIfTI validation, quota, geometry, upload interruption, protected download, gửi lại lệnh tạo ca (QA-CASE-01) |
| P4 | Immutable versions, concurrent save, stats, NIfTI round-trip |
| P5 | Worker claims/leases, stale attempt, retries, complete atomicity |
| P6 | Admin redaction, settings concurrency, export đúng version |
| P7 | Real AI smoke, end-to-end, restore, restart, documented setup |

## 2. Test layers và fixtures

- Unit: validation, claim calculations, label mapping, statistics, authorization predicates. Không viết test chỉ copy implementation.
- Integration: PostgreSQL thật trong container; không thay SQLite cho transaction/row lock/partial unique index tests.
- API contract: OpenAPI DTO, lỗi chuẩn, pagination, content download; FE types generated và compile được.
- Worker tests: deterministic fake adapter có thể điều khiển delay/error; dùng để gây race/restart, không phụ thuộc GPU trong CI.
- Real-model smoke: checkpoint đã xác minh + một ca tham chiếu; artifact ghi model hash, pipeline version, input hash, output checksum, thời gian và cấu hình máy.
- Browser E2E: Playwright do FE/QA sở hữu; backend cung cấp seed/reset fixture chỉ trong môi trường test, không có production HTTP reset endpoint.

Fixtures gồm 2 doctors, 1 admin, bệnh nhân giả, ca từng doctor, MRI synthetic với mốc bất đối xứng, mask nhỏ có count biết trước, valid BraTS sample trong local external data. Không commit MRI bệnh nhân hoặc checkpoint vào Git; test fixture nhỏ synthetic được commit.

## 3. Ma trận lỗi bắt buộc

| Tình huống | Kết quả mong đợi |
|---|---|
| Doctor A dùng ID file/mask/job/patient của B | 404, không side effect |
| Admin gọi patient/file endpoint | 403 |
| Invalid JWT/refresh reuse | 401, family revoked nếu reuse |
| Disable user đang đăng nhập | Request kế tiếp bị chặn |
| Hai save cùng base | Một new version, một 409 |
| Hai workers claim một job | Chỉ một attempt hợp lệ |
| Kill worker và đợi lease | Queue lại một lần, rồi failed nếu tiếp tục mất |
| Complete từ worker cũ | 409, không ghi đè result |
| Ghi output bị đầy disk | Job không succeeded, file dở không đọc được |
| Upload vượt compressed/decompressed cap | 413, staging được cleanup |
| NIfTI sai geometry/corrupt | 422 có code, không inference-ready |
| API/database restart | Metadata và file committed vẫn nguyên |
| Backup restore | Tất cả referenced files tồn tại và checksum đúng |

Test geometry phải có affine không đồng nhất identity, vị trí landmark trái/phải và slice đầu/cuối; không chỉ assert shape. Test mask export kiểm tra physical coordinates, labels và voxels không thay đổi ngoài vùng sửa.

## 4. Local runtime

Docker Compose chạy PostgreSQL, API và frontend/reverse proxy. Worker khởi động bằng Python environment riêng để tái sử dụng PyTorch/CUDA; sau P0 khóa dependency set đã xác minh. Backend/worker giao tiếp HTTP qua loopback trong bản local, không mở worker ra Internet.

Environment bắt buộc:

| Config | Ý nghĩa |
|---|---|
| `DATABASE_URL` | PostgreSQL connection; không log |
| `STORAGE_ROOT` | Persistent directory/volume ngoài code |
| `JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEY_PATH`, `JWT_KEY_ID` | Khóa RSA và kid |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Giá trị ở BE-01 |
| `APP_ENV`, `PUBLIC_ORIGIN` | local/test/production và origin allowlist |
| `COOKIE_SECURE` | false local localhost; true HTTPS |
| `MODEL_MANIFEST_PATH`, `MODEL_CHECKPOINT_PATH` | Artifact AI ngoài repository |
| `WORKER_API_BASE_URL`, `WORKER_TOKEN` | Service credential riêng |
| `WORKER_DEVICE` | cpu/cuda; explicit, không âm thầm fallback khi CUDA lỗi |

Secrets thực chỉ trong file local gitignored/secret mount. `.env.example` chứa placeholders. Migrations chạy bước riêng trước start serving; không để nhiều replicas cùng tự migrate.

## 5. Trình tự bàn giao

1. Cài Docker và Python environment đã ghi phiên bản; kiểm tra CPU/CUDA.
2. Copy mẫu config và tạo secrets/keys.
3. Start PostgreSQL; chạy Alembic migration.
4. Bootstrap admin bằng CLI tương tác.
5. Start API/frontend, kiểm tra health.
6. Đặt model artifact/manifest đã verified, cấp worker token và start worker.
7. Admin tạo doctor; chạy walkthrough từ upload hai modality đến save/export mask.
8. Lưu báo cáo nghiệm thu, benchmark, known limitations và cách recovery.

## 6. Backup/restore nhất quán

Backup ở local dùng cửa sổ maintenance: tạm chặn ghi mới và tạo job; đợi running jobs kết thúc; ngừng worker và ngừng các thao tác ghi API; dump PostgreSQL cùng snapshot storage sau khi file commits đã hoàn tất. Lưu manifest checksum và thời điểm backup. Không chỉ copy database bỏ quên MRI/mask.

Restore vào môi trường riêng: restore DB, storage và keys/config tương ứng; xác minh checksum/file references; revoke sessions trong bản restore thử để tránh dùng phiên thật; chạy read-only integrity check rồi smoke viewer. Không ghi đè môi trường gốc khi thử restore. Tần suất local mặc định backup trước thay đổi migration/model và khi kết thúc buổi demo có dữ liệu cần giữ.

## 7. CI và definition of done

CI chạy Python lint/type checks theo cấu hình dự án, pytest unit/integration, OpenAPI export contract check, frontend typecheck/build và E2E với worker giả. Real AI smoke là gate local có report riêng vì model/GPU không ở CI.

Một phase hoàn tất khi code, migration, API schema, tests và docs đồng bộ; QA không còn lỗi chặn liên quan quyền, mất dữ liệu, sai hình học hoặc kết quả giả. Không gọi test fake là xác nhận chất lượng mô hình.

## 8. P8: chuyển server

Giữ nguyên service boundaries. Đóng gói worker CPU/GPU sau benchmark; HTTPS cùng-origin trước khi đổi cookie/domain; secrets ngoài image; persistent volume hoặc object storage adapter; monitoring/backup tự động. Không chốt Render/Vercel/Colab ở bản local. Không dùng notebook free làm lời hứa inference 24/7. Mỗi provider cần rà lại quota/điều khoản tại thời điểm triển khai.

Ngoài v1: GT scoring, registration/skull stripping cho dữ liệu bệnh viện, DICOM/PACS, sharing/consultation, clinical validation. Các phần này cần spec riêng và không được vô tình bật bằng cách chấp nhận file bất kỳ.
