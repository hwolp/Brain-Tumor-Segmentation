# Báo cáo Nghiệm thu QA — P4-QA (Viewer, Brush/Erase Mask Editor & Phiên bản mask bất biến)

- **Ngày thực hiện:** 2026-11-17
- **Phạm vi:** Migration `0004_p4_mask_versions` (`mask_versions`, `mask_save_idempotency_keys`), API `GET/POST /api/v1/cases/{case_id}/mask-versions`, `GET /api/v1/mask-versions/{mask_version_id}`, `GET /api/v1/mask-versions/{mask_version_id}/export`, `GET /api/v1/mask-versions/{mask_version_id}/metadata`; FE viewer 3 bố cục, brush/erase trục axial, undo/redo theo lát, lưu phiên bản có `Idempotency-Key`, xử lý `409 mask_version_conflict`.
- **Môi trường:** Windows, Python `3.13.5` (`BE/.venv`), Node `v22.23.2`, PostgreSQL `postgres:16-alpine` (`127.0.0.1:5432`).

## 1. Migration, OpenAPI & đồng bộ BE ↔ FE

| Kiểm tra | Lệnh | Kết quả quan sát |
|---|---|---|
| Alembic upgrade (`bts_dev`) | `$env:DATABASE_URL="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"; BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini upgrade head` | `0003_p3_patients_cases_volumes -> 0004_p4_mask_versions` |
| Alembic drift | `$env:DATABASE_URL="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev"; BE\.venv\Scripts\python.exe -m alembic -c BE/alembic.ini check` | `No new upgrade operations detected.` |
| OpenAPI export | `$env:PYTHONPATH="BE"; BE\.venv\Scripts\python.exe -m scripts.export_openapi` | thành công, `BE/openapi/openapi.json` cập nhật |
| FE typegen | `Push-Location FE; npm run generate:types; Pop-Location` | `schema.d.ts` sinh lại (`182.4ms`) |

Điều chỉnh khi tích hợp: `FE/src/shared/api/types.ts` (`MaskVersionDto`, `MaskMetadataExportOut`...) dẫn xuất từ `schema.d.ts`; `FE/src/shared/api/maskVersions.ts` dùng `MaskMetadataExportOut` và phân trang `fetchAllMaskVersions`; `fetchCaseDetail` gọi trực tiếp `/cases/{case_id}/mask-versions` (chỉ `/jobs` còn fallback `404` chờ P5); panel viewer đọc `coverage.note` và `composite_volumes_mm3` từ server.

## 2. Test suite, lint & build (kết quả quan sát sau chỉnh sửa cuối)

| Hạng mục | Kết quả |
|---|---|
| `ruff check` (BE) | `All checks passed!` |
| `export_openapi --check` | exit `0` |
| BE unit | `35 passed, 1 warning in 3.73s` |
| BE integration (PostgreSQL `bts_test`) | `52 passed in 62.20s (0:01:02)` |
| BE contract | `3 passed in 2.31s` |
| **Tổng BE** | **`90 passed`** |
| FE `tsc -b --noEmit` | exit `0` |
| FE vitest | `8 passed (8)` files, `66 passed (66)` tests, `15.55s` (`viewerMaskEditor`: `14`) |
| FE `vite build` | thành công (`10.09s`) |

## 3. Đối chiếu ca kiểm thử & tổng kết review 4 góc (`gpt-6-luna` `xhigh`)

| Mã ca | Bằng chứng | Kết quả |
|---|---|---|
| `QA-MASK-01` | BE `test_qa_mask_01_single_t1ce_locks_reference_and_asymmetric_roundtrip`; FE `QA-MASK-01` ánh xạ display→voxel qua affine lật/hoán vị, kiểm tra export voxel sau zoom/pan và bất biến khung MRI gốc | ĐẠT |
| `QA-MASK-02` | BE `test_qa_mask_02_rejects_invalid_labels_geometry_and_headers`; FE `QA-MASK-02` chỉ pane axial editable được vẽ, kiểm tra cô lập lát `k` / `k+1` ở cấp voxel trong file `.nii.gz` xuất ra | ĐẠT |
| `QA-MASK-03` | BE `test_qa_mask_03_concurrent_save_conflict_and_idempotency_replay_after_head_moves` (`Barrier(2)`: 1×201 + 1×409, replay sau khi head đổi); FE edit → undo → redo → export/reload `.nii.gz` giữ đúng nhãn `{0, 1, 2, 4}`, shape, affine, spacing | ĐẠT |
| `QA-MASK-04/05` | BE `test_qa_mask_04_owner_scoping_admin_403_and_case_deletion_cleanup`, `test_p4_multipart_ingress_limit_on_mask_versions`, `test_p4_ambiguous_commit_preserves_mask_object_and_allows_retry_export`, `test_p4_idempotency_replay_after_concurrent_case_soft_delete_returns_404`; FE `QA-MASK-04/05` (`409` & `503` giữ nguyên voxel bản nháp, retry cùng `Idempotency-Key`, lưu từ phiên bản cũ gửi đúng `base_version_id`, `<1024px` 1 khung chỉ đọc, hủy export khi đổi/đăng xuất phiên, phân trang >20 phiên bản) | ĐẠT |

- **Review 4 góc (`code-reviewer`, `security-reviewer`, `pr-test-analyzer`, `doc-reviewer` trên `gpt-6-luna` `xhigh`):** Tất cả phát hiện độ tin cậy `>= 80%` ở BE, FE, test và tài liệu đã được xử lý và xác minh lại xanh 100% (`90/90` BE tests, `66/66` FE tests).
