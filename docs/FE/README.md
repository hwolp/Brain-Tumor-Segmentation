# Frontend Specification — Brain Tumor Segmentation

Trạng thái: **v1 (P0–P7) đã được triển khai và nghiệm thu đầy đủ** theo bộ đặc tả này (xem [IMPLEMENTATION-CHECKLIST.md](../IMPLEMENTATION-CHECKLIST.md) và các báo cáo trong `docs/reports/`, tổng hợp tại [P7-QA-acceptance.md](../reports/P7-QA-acceptance.md)). Ngôn ngữ sản phẩm: tiếng Việt. Bản đầu chạy cục bộ và dùng hồ sơ giả/dữ liệu BraTS để nghiệm thu.

## 1. Mục tiêu và phạm vi

Frontend phục vụ bác sĩ quản lý bệnh nhân, tạo ca MRI, chạy TDA-SegUNet, xem và chỉnh mask theo lát cắt, lưu phiên bản và xuất kết quả. Admin quản lý hệ thống; không có màn hình hoặc lối tắt truy cập hồ sơ/ảnh bệnh nhân.

- Giữ hai đầu vào FLAIR và T1ce khi chạy AI; không yêu cầu `_seg.nii`.
- Xem MRI và tạo mask thủ công có thể bắt đầu khi một volume đã hợp lệ. Nút AI chỉ mở khi đủ hai volume tương thích và ca sẵn sàng.
- Bản đầu nhận NIfTI `.nii`/`.nii.gz`; ảnh PNG/JPG độc lập, DICOM/PACS, hội chẩn và tính Dice/IoU nằm ngoài phạm vi.
- Mỗi bác sĩ có dữ liệu riêng. Backend mới là nguồn quyết định quyền truy cập; frontend chỉ hỗ trợ UX.

## 2. Danh mục module

| Tài liệu | Nội dung | Phase |
|---|---|---|
| [01-foundation-design.md](01-foundation-design.md) | Nền tảng, route, theme, state, component | P1 |
| [02-auth-navigation.md](02-auth-navigation.md) | Phiên, JWT, đăng nhập, điều hướng theo vai trò | P2 |
| [03-patients-cases-upload.md](03-patients-cases-upload.md) | Hồ sơ, ca, upload và validation | P3 |
| [04-viewer-mask-editor.md](04-viewer-mask-editor.md) | Viewer, chuyển lát, tô/xóa, phiên bản | P4 |
| [05-jobs-results.md](05-jobs-results.md) | Inference, trạng thái, kết quả và export | P5–P6 |
| [06-admin.md](06-admin.md) | Tài khoản, tác vụ và vận hành | P2, P6 |
| [07-testing.md](07-testing.md) | Test theo module và nghiệm thu E2E | P1–P7 |

## 3. Công nghệ và quy ước chung

- React + Vite + TypeScript strict; Tailwind CSS + shadcn/ui + Lucide.
- TanStack Query quản lý server state; Zustand quản lý trạng thái viewer/editor. Không sao chép toàn bộ dữ liệu backend vào Zustand.
- NiiVue được bọc bằng adapter để React không phụ thuộc trực tiếp mọi chi tiết thư viện. Adapter chịu trách nhiệm đổi hệ tọa độ, thao tác brush, đồng bộ các viewport và export.
- Client API có base `/api/v1`, gọi cùng origin qua reverse proxy/Vite proxy; các URL trong tài liệu module đều tương đối với base này.
- Type API sinh từ OpenAPI của backend (`BE/openapi/openapi.json` → `FE/src/shared/api/schema.d.ts`); không duy trì hai định nghĩa schema thủ công.
- Mọi thời điểm API dùng ISO-8601 UTC; giao diện hiển thị theo Asia/Ho_Chi_Minh, định dạng ngày `dd/MM/yyyy`. Ngày chụp là date-only, không đổi qua múi giờ.
- [Hợp đồng dùng chung](../CONTRACTS.md) là nguồn chuẩn cho API, enum và tham số; module FE mô tả hành vi giao diện. Dữ liệu khác owner trả 404; sai vai trò trả 403.
- Danh sách mặc định 20 dòng/trang; tìm kiếm debounce 300 ms; query tìm kiếm/lọc/trang thể hiện trên URL để Back/Forward hoạt động đúng.
- Không lưu ảnh, hồ sơ, JWT hoặc mask vào localStorage/IndexedDB trong bản đầu. Bộ nhớ phiên được xóa khi logout/chuyển tài khoản.

## 4. Thứ tự bàn giao

1. P1: layout, component nền và API client với fixture xác định.
2. P2: xác thực và ranh giới route theo vai trò; admin quản lý tài khoản tối thiểu.
3. P3: bác sĩ tạo bệnh nhân/ca, upload hai modality, xem validation.
4. P4: viewer/editor hoạt động với fixture NIfTI; không cần đợi model thật.
5. P5: nối job và phiên bản AI thật từ backend.
6. P6: quản trị vận hành, lịch sử phiên bản, tải mask và trang in.
7. P7: kiểm thử E2E, kiểm tra WebGL/hình học, tài liệu vận hành.

Không dùng fixture làm fallback âm thầm khi API thật lỗi. Chế độ fixture chỉ tồn tại trong phát triển/test, có cờ riêng và nhãn rõ ràng.

## 5. Agent/skill

- Agent frontend chịu trách nhiệm mã UI và adapter viewer; agent backend sở hữu hợp đồng và kiểm tra quyền; agent QA kiểm thử độc lập các đường lỗi và đầu-cuối.
- Dùng `ui-ux-pro-max` cho bố cục, khả năng tiếp cận và tương tác; đọc `ui-styling` hoặc `shadcn-ui` khi triển khai component cụ thể.
- Auth frontend tuân thủ quyết định của skill `jwt-handler`; không tự thay chính sách token trong lúc làm UI.
- Mỗi module hoàn tất phải có trạng thái loading/empty/error, test thích hợp và bằng chứng các tiêu chí nghiệm thu. Không đánh dấu hoàn tất chỉ vì render được màn hình.
