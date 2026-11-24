# Hướng dẫn skill, agent và kiểm thử

Tài liệu này hướng dẫn quá trình triển khai bộ spec; không khẳng định các skill hoặc thư viện đã được cài vào repository. Agent là vai trò làm việc, không phải tính năng chatbot của sản phẩm.

## 1. Nạp skill đúng phạm vi

| Skill | Lúc dùng | Kết quả cần áp dụng |
|---|---|---|
| `api-design-principles` | P1 và khi thiết kế hoặc đổi API | Quy ước REST, mã HTTP, lỗi, phân trang và OpenAPI |
| `fastapi` | P1–P6 khi xây API | Router, dependency, schema phản hồi và stream file |
| `supabase-postgres-best-practices` | Trước khi thiết kế hoặc sửa schema, migration, index, truy vấn hoặc khóa | Dùng hướng dẫn PostgreSQL thuần. Bỏ qua phần riêng của Supabase |
| `api-tdd` | P1–P6 khi thêm hoặc đổi hành vi API | Red → Green → Refactor bằng pytest qua HTTP. Dùng PostgreSQL thật, cô lập cho test giao dịch và khóa |
| `jwt-handler` | P2 và review auth khi đổi deployment | Access expiry, verify algorithm/claims, refresh hash/rotation/family/revocation, key rotation, tránh localStorage |
| `ui-ux-pro-max` | P1, P3–P4, P6 và review giao diện | Information architecture, keyboard, focus, feedback, contrast, responsive |
| `ui-styling` | Xây theme/components FE | Tailwind tokens, reusable accessible controls |
| `shadcn` | P1–P6 khi xây thành phần giao diện | Token giao diện, nhãn biểu mẫu và hộp thoại hỗ trợ bàn phím |
| `pnpm` | Chỉ khi chọn pnpm thay công cụ mặc định | Đọc skill trước lệnh pnpm/workspace configuration |
| `computer-use:computer-use` | Nếu phải kiểm UI qua công cụ máy tính | Đọc trước khi điều khiển native app; không thay Playwright regression suite |

`jwt-handler` và `ui-ux-pro-max` đã được đọc khi lập kế hoạch. Kết quả tìm design system có phần landing page không phù hợp workstation; không đưa hero/banner/trust badge vào UI chuyên môn chỉ vì skill gợi ý. Các skill còn lại chỉ nạp khi bắt đầu công việc phù hợp.

Các skill cục bộ nằm trong `.codex/skills/`. `api-tdd` hướng dẫn người triển khai viết kiểm thử API. Agent QA rà soát độc lập kịch bản và bằng chứng kiểm thử.

## 2. Vai trò và phạm vi agent

| Vai trò | Trách nhiệm | Không tự quyết |
|---|---|---|
| Lead/integration | Giữ SPEC/CONTRACTS, tách ticket, integration, migrations/API review | Không bỏ gate vì mock chạy |
| Backend/auth | Auth, owner checks, patient/case/file API, jobs, admin | Không cấp admin quyền xem patient |
| Frontend/viewer | UI, query state, viewer/editor, routes, forms | Không thay label mapping/geometry |
| AI adapter | Checkpoint, preprocessing, inference, crop restore, coverage | Không huấn luyện lại/đổi model để che incompatibility |
| QA độc lập | Test negative/acceptance, reproduce failure, evidence | Không chỉ dùng test do implementer tự xác nhận |

Tối đa ba agent con hoạt động đồng thời cùng lead. Không cần tất cả vai trò chạy cùng lúc. QA vào sau khi một vertical slice có thể kiểm thử, rồi quay lại ở các gate.

### Trình tự giao việc đề xuất

1. P0 AI agent và P1 foundation agent có thể độc lập; lead giữ hợp đồng.
2. P2 backend auth + FE auth; QA review authorization/token trước P3.
3. P3 backend records/files + FE forms; QA negative access và upload limits.
4. P4 FE viewer + BE version storage; QA dùng volume mốc bất đối xứng.
5. P5 AI worker + BE jobs + FE progress; QA crash/retry và stale result.
6. P6 hoàn thiện admin/export; QA kiểm dữ liệu bị lộ và version consistency.
7. P7 QA tổng thể; lead giải quyết blocker và kiểm runbook từ môi trường sạch.

### Mẫu giao việc

```text
Ticket: P4-FE-EDITOR-SAVE
Đọc: docs/SPEC.md, docs/CONTRACTS.md, docs/FE/04-viewer-mask-editor.md
Mục tiêu: save full mask với base_version_id, xử lý409 giữ draft.
Phạm vi sửa: FE editor API/state và tests; không đổi API BE.
Phụ thuộc: endpoint manual version và fixture geometry đã có.
Nghiệm thu: QA-MASK-04, QA-MASK-05.
Bàn giao: files đổi, test commands/results, known limitations.
Nếu hợp đồng không đủ: báo lead bằng đề xuất cụ thể trước khi đổi wire shape.
```

Các agent không chỉnh chung file migration/contract mà không phân công. Migration ID do lead điều phối. Trước merge kiểm trạng thái worktree và diff để không ghi đè công việc agent khác.

## 3. Chiến lược kiểm thử

### Unit

- Backend: token claims, validation helpers, geometry, volume counts, retry classification.
- Frontend: slice indexing0↔1, editor history, brush bounds, label palette/legend, route state.
- AI: crop/uncrop, label mapping, feature ordering; không mock chính phép biến đổi đang cần kiểm.

### Integration

- Dùng PostgreSQL thật trong test container cho transaction/row lock/constraints; SQLite không đại diện đủ cho job claim và refresh rotation.
- File storage tạm biệt lập; kiểm cleanup sau failure, không dùng thư mục dataset gốc để test xóa.
- API ownership trên resource trực tiếp và quan hệ lồng nhau.
- Concurrent save và concurrent job claim phải test bằng request thật đồng thời.

### Browser/E2E

- Playwright Chromium desktop là môi trường nghiệm thu đầu; không mặc định cross-browser đã đạt.
- Fake worker xác định được kết quả dùng cho CI và failure scenarios, hiển thị rõ test mode.
- Ít nhất một smoke case chạy checkpoint thật trước nghiệm thu P5/P7.
- Test NiiVue/WebGL trong browser thật với buffer dữ liệu; screenshot chỉ bổ trợ, không chứng minh voxel đúng.
- UI form/navigation kiểm accessibility tự động ở mức phù hợp, cộng kiểm keyboard thủ công cho viewer tools.

## 4. Ma trận ca kiểm thử bắt buộc

| ID | Tình huống | Kỳ vọng | Phase |
|---|---|---|---|
| QA-AUTH-01 | JWT expired/sai signature/alg/aud/iss |401 đúng code, không side effect |P2|
| QA-AUTH-02 | Dùng lại refresh đã rotate | Thu hồi family, không cấp successor thứ hai |P2|
| QA-AUTH-03 | Nhiều GET hết access đồng thời | FE refresh một lần, retry đọc tối đa một lần |P2|
| QA-AUTH-04 | Admin khóa bác sĩ đang mở viewer | API chặn ngay, dữ liệu không tiếp tục tải |P2/P7|
| QA-AUTH-05 | Đổi account khi request cũ chưa xong | Cache/buffer cũ bị xóa, response muộn không repopulate |P2/P7|
| QA-ACL-01 | DoctorA thay patient/case/job/version/file ID củaB |404, không rò dữ liệu |P3–P7|
| QA-ACL-02 | Admin gọi content/export/patient APIs |403, log/response admin không PII |P3/P6|
| QA-FILE-01 | Extension giả/corrupt/truncated NIfTI |422, không ready, staging cleanup |P3|
| QA-FILE-02 | Quá compressed/decompressed limit |413, không cấp phát mảng quá hạn |P3|
| QA-FILE-03 | Hai volume same shape nhưng affine khác | Không chạy AI; giải thích mismatch |P3|
| QA-CASE-01 | Mất phản hồi hoặc gửi đồng thời cùng khóa khi tạo ca | Chỉ tạo một ca. Gửi lại cùng nội dung trả cùng ID, khác nội dung trả 409 |P3|
| QA-FILE-04 | Tên file chứa traversal/control chars | Không thoát storage root, tên an toàn |P3|
| QA-AI-01 | Inference không có `_seg` và không có T1/T2 | Chạy bằng FLAIR/T1ce hợp lệ |P0/P5|
| QA-AI-02 | Crop sát biên và lát trống | Restore chính xác, không negative wrapping |P0|
| QA-AI-03 | Raw labels và coverage | Chỉ0/1/2/4, ngoài crop không diễn giải thành đã đánh giá |P0/P5|
| QA-MASK-01 | Volume landmark bất đối xứng | Đúng trái/phải và click-to-voxel |P4|
| QA-MASK-02 | Edit látk, chuyểnk+1 rồi quay lại | Edits còn, látk+1 không bị sửa |P4|
| QA-MASK-03 | Stroke→undo→redo→export→reload | Voxel và geometry đúng |P4|
| QA-MASK-04 | Hai tab save cùng base | Một201, một409; không silent overwrite |P4|
| QA-MASK-05 | Save lỗi mạng hoặc hết phiên | Không tự báo saved; draft được xử lý rõ, không retry mù |P4|
| QA-MASK-06 | AI hoàn tất khi có draft thủ công | Version mới không ghi đè draft/old version |P5|
| QA-JOB-01 | Double-click/cùng idempotency key | Một job |P5|
| QA-JOB-02 | Hai workers claim cùng lúc | Một attempt có quyền chạy job |P5|
| QA-JOB-03 | Worker chết và gửi complete muộn | Lease recovery; complete cũ409 |P5|
| QA-JOB-04 | Storage write fail lúc complete | Không succeeded/file nửa vời |P5|
| QA-JOB-05 | Retry quá budget hoặc lỗi input | failed rõ ràng, không loop |P5|
| QA-OPS-01 | Xóa ca có job active |409, không mất input đang dùng |P3/P5|
| QA-OPS-02 | Backup DB+files, restore vào môi trường sạch | Đọc được ca/version, checksums khớp |P7|
| QA-OPS-03 | In summary ở version khác latest | Số liệu và nhãn đúng bản chọn |P6|

## 5. Test fixtures và dữ liệu

- Synthetic small volumes có điểm mốc để test hình học; shape ngoài profile AI chỉ dùng unit/viewer.
- Fixture BraTS nhỏ được cấp quyền sử dụng cho inference thật, không commit toàn dataset/checkpoint vào git.
- Hồ sơ tên giả; account role-specific; doctorA/B riêng; admin không tái sử dụng account bác sĩ.
- Random seed cố định cho fixtures; so sánh voxel exact với mask save/reload, tolerance khai báo cho số float.
- Ground truth có thể dùng kiểm nghiên cứu nội bộ; không mở API GT chỉ để phục vụ test.

## 6. Bằng chứng và Definition of Done

Mỗi ticket: mô tả hành vi, test pass/fail, lệnh đã chạy, môi trường và giới hạn. Không ghi “đã kiểm thử” nếu chỉ đọc mã. Không ghi “đã chạy AI” nếu fixture giả.

Không cần test snapshot cho mọi nhãn/text hoặc thay đổi bố cục nhỏ. Ưu tiên test thay đổi dữ liệu, quyền, trạng thái bất đồng bộ và hình học. Khi check cần thiết đã pass, không lặp lại toàn bộ suite nếu không có thay đổi/rủi ro mới.

Gate release chặn nếu còn lỗi authorization, JWT lifecycle, voxel alignment, data corruption, immutable version, worker recovery hoặc restore backup. Vấn đề polish không chặn phải có ghi chú và ticket riêng.
