# Kế hoạch chi tiết theo phase

Trạng thái hiện tại: **v1 (P0–P7) đã được triển khai và nghiệm thu đầy đủ**; chỉ **P8** giữ ở trạng thái backlog sau v1 (xem [IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md) và các báo cáo nghiệm thu trong `docs/reports/` từ [P0-AI-verification.md](reports/P0-AI-verification.md) đến [P7-QA-acceptance.md](reports/P7-QA-acceptance.md)). Mỗi phase có mốc FE, BE, AI và QA; không chạy phase phụ thuộc bằng dữ liệu giả rồi đánh dấu đạt AI thật.

## Bản đồ phụ thuộc

```text
P0 AI/protocol ───────────────────────→ P5 AI integration
P1 foundation → P2 auth → P3 records/upload → P4 viewer/editor
                                         └─────────────→ P5
P2 → admin accounts; P5 → P6 admin operations/export
P4 + P5 + P6 → P7 full acceptance/local release → P8 extensions
```

P0 và P1 có thể chạy song song. Phần admin tài khoản xây tại P2, không chờ P6. QA bắt đầu từ từng module. P4 có thể dùng fixture hoặc mask trống nhưng phải phân biệt fixture với AI thật.

## Skill theo phase

| Phase | Skill và thời điểm áp dụng |
|---|---|
| P0 | Xác minh mô hình theo tiêu chí P0 bên dưới. |
| P1 | `api-design-principles` trước hợp đồng và OpenAPI. `fastapi` và `api-tdd` khi dựng endpoint đầu tiên. `supabase-postgres-best-practices` trước migration đầu tiên. `ui-ux-pro-max` và `shadcn` khi dựng giao diện nền. |
| P2 | `jwt-handler` trước thiết kế phiên và xoay token. `api-tdd` cho xác thực và phân quyền, skill PostgreSQL trước schema hoặc giao dịch. |
| P3 | `fastapi` cho upload và stream file. `api-tdd` cho quyền, kiểm tra file và gửi lại lệnh tạo ca. Skill PostgreSQL trước schema và index. `ui-ux-pro-max` và `shadcn` cho biểu mẫu. |
| P4 | `ui-ux-pro-max` và `shadcn` cho điều khiển viewer. `api-tdd` cho lưu mask và skill PostgreSQL trước giao dịch lưu phiên bản. |
| P5 | `fastapi` và `api-tdd` cho API job/worker. Skill PostgreSQL trước index, khóa nhận job và giao dịch công bố kết quả. |
| P6 | `fastapi` và `api-tdd` cho API quản trị và xuất kết quả. `ui-ux-pro-max` và `shadcn` cho dashboard và hộp thoại. |
| P7 | QA tổng hợp bằng chứng. Đọc skill PostgreSQL trước phục hồi DB và `jwt-handler` nếu triển khai đổi cách quản lý khóa hoặc phiên. |
| P8 | Chọn skill theo phạm vi từng phần mở rộng. |

Dùng `api-design-principles` khi đổi hợp đồng ở bất kỳ phase nào. Xem [hướng dẫn skill và QA](AGENTS-AND-QA.md) để biết phạm vi áp dụng.

## P0 — Xác minh AI và dữ liệu

### Đầu vào

- Mã AI tham khảo tại `D:/Nam4/Ky1/PBL6` (ngoài web repo).
- Nhiều checkpoint tồn tại; ưu tiên đối chiếu `Demo2/outputs/tda_seg_unet_cce_dice/best.pt`, chưa coi nó chắc chắn đúng.
- Một ca BraTS gồm FLAIR/T1ce, và nhãn chỉ dùng đối chiếu nội bộ nếu cần.

### Công việc

1. Ghi kiến trúc checkpoint, tensor shape, input channels, package versions, SHA-256 và nguồn train config.
2. Đối chiếu implementation training thực tế, không chỉ README: chuẩn hóa theo volume hay slice, thứ tự kênh, cách crop, TDA parameters.
3. Loại đường đọc dataset buộc `_seg`, T1 và T2 khỏi adapter inference. Không sửa pipeline nghiên cứu gốc để che khác biệt.
4. Viết hợp đồng `run_case(flair,t1ce,model_manifest,progress) -> mask + metadata`, nội bộ có thể dùng đường dẫn riêng.
5. Xử lý đủ lát, ghi crop coords, coverage và khôi phục vào lưới gốc.
6. Xác minh nhãn contiguous→raw; kiểm tra affine, spacing, hướng và dtype export.
7. Đo riêng load/preprocess/TDA/inference/save; CPU bắt buộc chạy thử nếu tương thích, GPU khi có thiết bị.
8. Lập model manifest và báo cáo xác minh. Nếu thiếu training config/checkpoint phù hợp, ghi blocker cụ thể, không đoán để triển khai AI thật.

### Bàn giao và nghiệm thu

- Manifest model có thể tái lập và báo cáo benchmark cấu hình máy.
- Một inference thật không có `_seg`; shape/geometry chính xác; mask round-trip đạt.
- Test crop sát biên, lát trống, label mapping và coverage; không có truy cập GT trong inference.
- Nếu profile chỉ hỗ trợ BraTS240×240×155 thì API thông báo đúng giới hạn.

## P1 — Foundation và môi trường

### BE

- Khung FastAPI, settings tách dev/test/prod, error envelope, request ID và logging lọc.
- SQLAlchemy/Alembic và PostgreSQL Compose; storage adapter local; health/liveness và readiness riêng.
- Cấu hình secrets mẫu không chứa giá trị thật; CLI bootstrap admin sẽ được hoàn thành P2.
- OpenAPI artifact và quy trình sinh FE client/types; pin dependencies khi bắt đầu triển khai.

### FE

- React/Vite/TS, routing, Query provider, token theme và layout shell.
- Vietnamese labels, danh sách/table/form states; sidebar theo role.
- Viewer adapter interface riêng; lazy-load thư viện ảnh khi mở viewer.
- Proxy `/api/v1`, không hardcode port server trong component.

### QA / bàn giao

- CI chạy typecheck/lint/build và test scaffold; chưa coi chưa có test là đạt module.
- Docker database restart vẫn giữ dữ liệu.
- Empty/error/loading/forbidden có màn hình và component dùng chung.
- Hướng dẫn chạy local tái lập từ checkout sạch.

## P2 — Authentication, authorization và tài khoản admin

### BE

- User/session/refresh family/audit migrations; bootstrap admin không mật khẩu mặc định.
- Login, me, refresh, logout, đổi mật khẩu; Argon2id và RS256.
- Rotation transaction, revoke family khi reuse; account/session status gate.
- Admin tạo/khóa/mở bác sĩ/reset mật khẩu tạm. Không public signup, không delete bác sĩ sở hữu dữ liệu.
- Origin/CSRF checks, rate-limit login, no token in logs; public key endpoint và kid.

### FE

- Login form, forced password change, protected routes, route role guards.
- Access token memory; restore session qua refresh; single-flight cùng tab và coordination đa tab.
- Khi mất session đang có draft: khóa thao tác, cho xác thực lại cùng người; đổi account/logout phải bỏ dữ liệu cũ.
- Admin users list, create/edit/lock/unlock/reset form và xác nhận thao tác.

### Nghiệm thu

- JWT expired/invalid/alg sai/aud sai bị từ chối; refresh đã dùng không cấp successor lần hai.
- Requests đồng thời trong cùng FE không tạo nhiều refresh; race đa tab được xử lý an toàn.
- Khóa user và đổi mật khẩu thu hồi phiên; UI không còn dữ liệu tài khoản cũ.
- Bác sĩ gọi API admin403. Admin không có đường vào API dữ liệu bệnh nhân.

## P3 — Patient, case, upload và file authorization

### BE

- Patient/case/volume tables, indexes theo owner, constraints mã bệnh nhân và modality.
- CRUD/list/search/pagination; owner từ session và mọi truy vấn có scope.
- Stream upload staging, kiểm file thật, giải nén có giới hạn, header/shape/affine/finite validation.
- Storage UUID/checksum, download owner-gated, cleanup invalid/orphan.
- Readiness theo hai modality và manifest; không tự registration khi mismatch.
- Quy tắc khóa input sau job/version; xóa có kiểm active jobs và cleanup bền vững.

### FE

- Danh sách bệnh nhân, form hồ sơ, chi tiết và timeline lần chụp.
- Create case wizard: thông tin → chọn FLAIR/T1ce → upload/validation → kiểm tra trước chạy.
- Thể hiện từng file, modality, dung lượng, geometry, lỗi và thiếu input.
- Có thể mở MRI valid trước khi đủ hai xung; AI disabled với lý do.

### Nghiệm thu

- Gửi lại lệnh tạo ca cùng khóa và nội dung trả cùng ID, kể cả khi mất phản hồi. Cùng khóa với nội dung khác trả 409.
- Hai bác sĩ có thể trùng patient_code nhưng không đọc dữ liệu nhau.
- Sai ID/resource nested/file URL không bypass owner.
- Corrupt NIfTI, fake extension, truncated file, gzip bomb,4D, nonfinite, incompatible geometry đều thất bại có thông báo.
- File invalid không xuất hiện là ready và không để rác vô hạn.

## P4 — Viewer và editor theo lát

### FE

- Main: MRI gốc + MRI overlay, synchronized slice/zoom/pan/crosshair.
- Modality switch giữ world position; axial/coronal/sagittal views; annotation trái/phải đúng affine.
- Slider, prev/next, nhập số lát, keyboard; chế độ xem cho wheel chuyển lát, khi brush bật wheel đổi slice chỉ theo hành vi rõ trong spec FE.
- Neighbor layout k-1/k/k+1, chỉ center editable; ở biên không wrap.
- Hiện mask slices và dirty slices; next/previous mask slice lấy occupancy cache được cập nhật sau edit.
- Brush/erase axial, label0/1/2/4, radius1–20 voxel, per-slice undo/redo; không copy/interpolate.
- Dirty edits tồn tại khi đổi lát/modality/layout; exit warning và save conflict UI.

### BE

- MaskVersion immutable; empty-mask initial save, manual save, list/export/metadata.
- Full-volume binary save có base_version_id; lock transaction,409 stale.
- Validate shape/affine/labels; tính counts và physical volume phía server.
- Không nhận client overwrite AI version. Publish result atomic.

### Nghiệm thu

- Synthetic asymmetric volume chứng minh đúng display→voxel và left/right.
- Brush không sửa lát khác hoặc voxel ngoài stroke; undo/redo round-trip.
- NIfTI reimport giống voxel data, geometry và labels; chỉ sửa giữa các buffer đồng bộ.
- Hai tab lưu cùng base: một thành công, một409 giữ draft.
- Oblique không được sửa nếu mapping native chưa hỗ trợ; UI giải thích.

## P5 — AI jobs và worker integration

### BE / AI

- Job/attempt/model registry migrations, unique active job/case và Idempotency-Key.
- Worker service identity, claim nguyên tử, lease15s heartbeat/90s expiry, idle heartbeat.
- Đóng gói adapter P0; persistent model loaded once; metadata model pinned khi create job.
- Progress loading/preprocessing/inference/reconstruction/saving; sanitize errors.
- Reaper xử lý dead attempts, tối đa1 automatic retry; reject stale completion.
- Complete mask publish transaction; late/manual mask concurrency không overwrite.
- queued cancellation only; server accepting_jobs maintenance switch.

### FE

- Run confirmation hiển thị model và đầu vào; double-click không tạo job trùng.
- Queue/running stages, worker offline, lỗi và retry theo quyền.
- Poll3s khi visible/active, terminal dừng; refetch khi trở lại.
- AI xong thông báo có version mới, không thay draft hiện tại.

### Nghiệm thu

- Full inference thật từ upload tới export; 155 lát nếu input BraTS chuẩn.
- Worker kill/restart, lease hết hạn, stale completion, duplicate click và DB transient failure không làm kết quả mồ côi/hỏng.
- Progress hợp lý; không hiện100% trước khi mask durable và job succeeded.

## P6 — Admin vận hành và bản xuất

### BE

- Aggregate không lộ PII; admin job list kỹ thuật, retry, workers, settings allowlist, models readonly, audit.
- Retry không bypass account disabled/input invalid; actor và original job đều được ghi audit.
- Metadata export gồm provenance/version/geometry/coverage/counts; không absolute path.

### FE

- Admin dashboard, jobs filter, retry dialog, worker/disk, settings, audit.
- Bác sĩ xem version history, note, chọn AI/manual, thể tích theo bản chọn.
- Print-friendly summary và browser print-to-PDF; không cần PDF engine server v1.
- Download filename dùng technical IDs; hiển thị rõ saved version và edits chưa lưu chưa có trong bản xuất.

### Nghiệm thu

- Không có tên bệnh nhân/file MRI/notes trong response admin hoặc operational log.
- Các nhóm WT/TC/ET không được cộng thành total do chồng lấp.
- Print/metadata/mask cùng version; admin không tải file qua direct URL.

## P7 — Local release và QA tổng thể

### Kiểm thử bắt buộc

- E2E bác sĩ: login → password change → patient → case → inputs → AI → viewer → edit → save → export → reload.
- E2E admin: create doctor → inspect job kỹ thuật → retry failed → lock doctor → verify revoked session.
- Negative ownership, refresh reuse, expired access giữa save, conflicting save và orphan cleanup.
- Test data loss: service restart, worker crash, storage failure; không đánh dấu succeeded khi artifact thiếu.
- Backup/restore database cùng volumes; kiểm checksum và tải lại phiên bản sau restore.
- UI layout1024/1440/1920 và narrow read-only; keyboard/focus/contrast; browser Chromium desktop là acceptance target đầu.
- Benchmark real case, instrument TDA và inference riêng; lưu hardware và elapsed/RAM/VRAM khi đo được.

### Bàn giao

- README runbook, migration/seed, mẫu env không secrets, bootstrap admin, worker launch.
- Test report: command, exit status, environment, fixture IDs, limitations, lỗi còn mở.
- Release checklist không còn lỗi chặn auth, geometry, save, inference, backup.
- Không có model/dataset nặng hoặc credential bị commit vào source.

## P8 — Mở rộng sau bản đầu

Tách thành đề xuất riêng trước khi triển khai: GT upload và Dice/IoU; so sánh model; sharing/hội chẩn; DICOM/PACS; single-modality model; 3D editing; cloud CPU/GPU/object storage. Hạ tầng cloud quyết định sau benchmark, không phụ thuộc Colab/Kaggle luôn online. Những mục này không chặn nghiệm thu v1.

## Cách theo dõi tiến độ

Mỗi ticket cần: ID phase/module, acceptance IDs, files/subsystem được phép sửa, dependency, test command, bằng chứng và blocker. Không ước lượng thời gian cố định trước P0; chia ticket đủ nhỏ để review một hành vi cụ thể. QA có quyền đánh dấu gate chưa đạt khi chỉ có mock hoặc thiếu kiểm geometry/security.
