# Checklist triển khai

Đã hoàn thành có bằng chứng kiểm thử cho bản phát hành cục bộ **v1** từ **P0–P7**: **P0 — AI** ([báo cáo P0-AI](reports/P0-AI-verification.md)), **P1 — Nền tảng** ([báo cáo P0-QA & P1-QA](reports/P1-QA-acceptance.md)), **P2 — Auth & tài khoản** ([báo cáo P2-QA](reports/P2-QA-acceptance.md)), **P3 — Bệnh nhân, ca chụp, upload MRI & phân quyền file** ([báo cáo P3-QA](reports/P3-QA-acceptance.md)), **P4 — Viewer, chỉnh sửa mask axial & phiên bản mask bất biến** ([báo cáo P4-QA](reports/P4-QA-acceptance.md)), **P5 — AI integration, Job Queue & Worker Leases** ([báo cáo P5-QA](reports/P5-QA-acceptance.md)), **P6 — Admin Operations, Audit & In Báo cáo Mask** ([báo cáo P6-QA](reports/P6-QA-acceptance.md)) và **P7 — Bàn giao & QA Tổng thể v1** ([báo cáo P7-QA](reports/P7-QA-acceptance.md)). Chỉ **P8 — Backlog chưa thuộc v1** vẫn giữ chưa triển khai. Chỉ đánh dấu checkbox khi có bằng chứng nghiệm thu thực tế.

## P0 — AI

- [x] Kiểm checkpoint/architecture/config/hash.
- [x] Xác minh normalization, channel order, TDA settings.
- [x] Inference không cần `_seg`/T1/T2.
- [x] Crop→restore, affine và raw labels đúng.
- [x] Coverage metadata và model manifest.
- [x] Inference thật/benchmark/báo cáo gate.

## P1 — Nền tảng

- [x] FE shell/theme/routing và API proxy.
- [x] BE app/settings/error/logging/storage adapter.
- [x] PostgreSQL/Alembic/Compose và persistent volumes.
- [x] OpenAPI/type generation/CI scripts.
- [x] Local runbook khởi động từ môi trường sạch.

## P2 — Auth và tài khoản

- [x] Bootstrap admin, doctor account management.
- [x] RS256 access, hashed rotating refresh, revocation.
- [x] Password change/reset/forced change.
- [x] Frontend session bootstrap/single-flight/multi-tab coordination.
- [x] Role guards cả FE/BE, account lock tức thời.
- [x] Auth/ACL gate có QA evidence.

## P3 — Hồ sơ và upload

- [x] Patient CRUD/search/pagination ownership.
- [x] Case CRUD và readiness.
- [x] FLAIR/T1ce upload, byte/geometry checks.
- [x] Private download và cleanup.
- [x] Input immutability và delete active-job rules.
- [x] File/ownership negative tests.

## P4 — Viewer và manual mask

- [x] Original/overlay synchronization.
- [x] Three-plane/adjacent-slice layouts.
- [x] Slice navigation/dirty markers/occupancy jump.
- [x] Axial brush/erase/per-slice undo redo.
- [x] Full-mask save/version conflict/dirty exit.
- [x] Label counts/physical volumes/export geometry.
- [x] Synthetic landmark and round-trip tests.

## P5 — AI integration

- [x] Model registry và verified adapter.
- [x] Job idempotency/unique active/claim/lease.
- [x] Worker credentials/heartbeat/progress.
- [x] Reaper/retry budget/stale result rejection.
- [x] Atomic artifact completion.
- [x] FE status/offline/error/new-result handling.
- [x] Real AI smoke và worker crash tests.

## P6 — Admin và kết quả

- [x] Admin operational overview/jobs/workers.
- [x] Settings allowlist/audit/models readonly.
- [x] No patient data in admin APIs/logs.
- [x] Version history/notes/metadata export.
- [x] Print summary đúng phiên bản.

## P7 — Bàn giao

- [x] Full doctor/admin E2E.
- [x] Security, geometry, concurrency regression.
- [x] Desktop/editor và narrow read-only checks.
- [x] Migration fresh DB và backup/restore.
- [x] Dependency lock, secrets hygiene, dataset/model ignored.
- [x] Benchmark/report/known limitations.
- [x] Runbook/worker start/recovery guide.

## P8 — Backlog chưa thuộc v1

- [ ] Ground truth upload và Dice/IoU.
- [ ] Sharing/hội chẩn.
- [ ] DICOM/PACS và dữ liệu lâm sàng.
- [ ] Single-modality/alternative model.
- [ ] 3D tools/interpolation.
- [ ] Cloud deployment sau benchmark.
