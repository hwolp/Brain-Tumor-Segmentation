# SPEC tổng thể — Ứng dụng phân đoạn u não

## 1. Mục tiêu và phạm vi

Xây dựng ứng dụng theo quy trình làm việc của bác sĩ tại bệnh viện: quản lý hồ sơ tối thiểu → tạo ca chụp → tải MRI → chạy TDA-SegUNet → xem/sửa mask theo lát → lưu phiên bản → xuất kết quả. Bản đầu chạy cục bộ, thiết kế để chuyển server sau. Phát triển bằng dữ liệu BraTS và danh tính giả; chưa coi đây là phần mềm đã thẩm định sử dụng lâm sàng.

### Những quyết định đã chốt với người dùng

| Chủ đề | Quyết định |
|---|---|
| Người sử dụng chính | Bác sĩ |
| Admin | Owner quản trị hệ thống, không có quyền ứng dụng xem hồ sơ/MRI |
| Hồ sơ bệnh nhân | Mã bệnh nhân, họ tên, năm sinh, giới tính; nhiều ca chụp |
| Phân quyền dữ liệu | Mỗi bác sĩ sở hữu hồ sơ/ca của mình; chưa chia sẻ liên bác sĩ |
| Mô hình | TDA-SegUNet, xác minh checkpoint trước khi tích hợp |
| Đầu vào AI | Hai xung FLAIR + T1ce cùng ca, cùng không gian |
| Định dạng | NIfTI `.nii`, `.nii.gz`; không nhận JPEG/PNG làm input AI v1 |
| Nhãn chuẩn | Không yêu cầu `_seg.nii` để inference; giao diện so sánh GT để P8 |
| Chỉnh mask | Theo từng lát axial, chuyển lát giữ chỉnh sửa; đối chiếu ảnh gốc và mask |
| Ưu tiên | Sửa mask và quản trị nằm trong bản đầu |
| Triển khai | Local trước; chưa tích hợp Render/Vercel/Colab/Kaggle |

### Phạm vi chức năng

- Xác thực, đổi mật khẩu, quản lý phiên, khóa tài khoản.
- Quản lý bệnh nhân và các lần chụp; tìm kiếm, phân trang.
- Lưu MRI riêng tư, kiểm tra file và hình học.
- Viewer hai khung đồng bộ; chế độ ba mặt phẳng và lát lân cận.
- Mask AI bất biến; phiên bản chỉnh tay mới khi lưu.
- Quản lý job có trạng thái, heartbeat, retry có giới hạn.
- Thể tích vùng phân đoạn, tải mask, metadata, trang in tóm tắt.
- Admin quản lý tài khoản, tác vụ, cấu hình giới hạn, model và vận hành.

### Ngoài bản đầu

Đăng ký công khai, tài khoản bệnh nhân, mạng xã hội/cộng đồng, chia sẻ ca, hội chẩn, DICOM/PACS, bệnh án đầy đủ, chẩn đoán tự động, training qua web, arbitrary model upload, brush 3D, nội suy mask, upload ảnh 2D độc lập, email/SMS, thanh toán, cloud deployment và SLA lâm sàng.

## 2. Vai trò và quyền sở hữu

| Hành động | Bác sĩ sở hữu | Bác sĩ khác | Admin |
|---|---:|---:|---:|
| Tạo hồ sơ/ca của mình | Có | Không áp dụng | Không |
| Xem/sửa/xóa hồ sơ và MRI | Có | Không | Không |
| Chạy AI, sửa mask, xuất kết quả | Có | Không | Không |
| Xem trạng thái job kỹ thuật toàn hệ thống | Không | Không | Có |
| Tạo/khóa tài khoản bác sĩ | Không | Không | Có |
| Retry job lỗi qua thao tác quản trị có audit | Không áp dụng | Không | Có |
| Đọc tên bệnh nhân, MRI hoặc nhận xét qua API admin | Không áp dụng | Không áp dụng | Không |

- Backend kiểm tra quyền trên mọi thao tác, gồm file download, version, job và aggregate. Không chỉ ẩn nút phía FE.
- Đối với dữ liệu không thuộc bác sĩ: trả 404 để không xác nhận tài nguyên có tồn tại. Sai vai trò endpoint: 403.
- `owner_id` lấy từ phiên xác thực; không tin trường owner do client gửi.
- Admin vận hành không có màn hình giả danh bác sĩ. Hạ tầng owner có thể đọc ổ đĩa/database bên dưới; quyền ứng dụng không thay thế kiểm soát máy chủ.
- Không xóa tài khoản bác sĩ đang sở hữu dữ liệu; dùng khóa tài khoản. Chuyển giao quyền sở hữu là nâng cấp sau.

## 3. Kiến trúc

| Lớp | Lựa chọn |
|---|---|
| FE | React + Vite + TypeScript; Tailwind + shadcn/ui + Lucide |
| Trạng thái FE | TanStack Query cho server state; Zustand cho viewer/editor; dữ liệu voxel không đưa vào cache query đại trà |
| Viewer | NiiVue qua adapter riêng để cô lập phụ thuộc thư viện |
| BE | FastAPI + Pydantic + SQLAlchemy + Alembic |
| Database | PostgreSQL |
| Auth | PyJWT RS256, Argon2id, refresh token opaque |
| AI | PyTorch và pipeline TDA hiện có; NiBabel/NumPy/SciPy/GUDHI theo môi trường được xác minh |
| Job | PostgreSQL queue + worker HTTP client; chưa cần Redis/Celery |
| File | Private local volume, UUID storage keys, adapter storage |
| Kiểm thử | pytest; Vitest/Testing Library; Playwright |
| Local | Docker Compose cho frontend/API/database; worker Python ngoài container để dùng GPU Windows hiện có |

FE gọi `/api/v1` qua cùng origin reverse proxy; development dùng Vite proxy. Worker nhận job qua internal API, không nhận credential bác sĩ và không truy cập trực tiếp database. Docker service phải bind localhost cho bản local, không mặc định công khai trên LAN.

File không đặt dưới public/static frontend. Client tải file qua endpoint có Authorization. Không nhúng token vào URL. Chỉ cache dữ liệu bệnh nhân trong RAM phiên hiện tại; không dùng service worker cache riêng tư.

## 4. Đầu vào và pipeline AI

- Một ca chứa một FLAIR và một T1ce hợp lệ để đủ điều kiện inference. Có thể upload từng file và xem file đã hợp lệ trong lúc chờ file còn lại.
- Đổi tên file không biến FLAIR thành T1ce; modality do bác sĩ khai báo và hiển thị để họ kiểm tra. Không tuyên bố tự nhận biết chắc chắn modality từ NIfTI.
- V1 hỗ trợ profile BraTS đã tiền xử lý: baseline dự kiến `(240,240,155)` với spacing 1 mm. P0 phải xác minh profile thật với pipeline/checkpoint và ghi model manifest. Không tự biến đổi dữ liệu ngoài profile rồi chạy âm thầm.
- File khác profile có thể xem nếu phù hợp giới hạn viewer, nhưng nút AI bị chặn với lỗi cụ thể.
- Hai volume phải khớp shape, affine và spacing trong dung sai hợp đồng. Không có chức năng registration tự động trong v1.
- Không dùng ground truth để crop hoặc tạo đặc trưng trong inference.
- Từng lát được xử lý theo đúng preprocessing huấn luyện; lưu crop coordinates, slice index, label mapping và coverage. Các pixel ngoài vùng crop là không được mô hình đánh giá, dù mask xuất cần điền nền.
- Shape cùng nhau chưa đủ để khẳng định đúng tọa độ; kiểm tra affine và các hướng giải phẫu.
- Giữ thông tin header gốc phù hợp, affine, qform/sform, voxel spacing khi xuất mask.
- Model registry chứa tên, version, checkpoint hash, đầu vào yêu cầu, preprocessing version, nhãn và trạng thái active. Không cho kích hoạt model chưa xác minh.

## 5. Trải nghiệm bác sĩ

1. Đăng nhập; đổi mật khẩu tạm nếu cần.
2. Tạo hoặc tìm bệnh nhân thuộc mình.
3. Tạo lần chụp, nhập ngày chụp và ghi chú.
4. Upload FLAIR/T1ce, xem lỗi hoặc trạng thái hợp lệ.
5. Mở viewer để kiểm tra; chạy AI khi đủ điều kiện.
6. Theo dõi job, mở mask AI khi hoàn tất.
7. Chọn lát, xem gốc/overlay đồng bộ; tô/xóa đúng lớp nhãn.
8. Lưu phiên bản mới, xem thể tích, tải mask và bản tóm tắt.

Chỉnh tay được phép từ mask trống khi ca chưa có AI, với reference volume được cố định. AI chạy sau không ghi đè phiên bản thủ công. Bản đang xem, bản chỉnh sửa và kết quả AI mới được phân biệt rõ.

## 6. Giới hạn và quy tắc v1

| Tham số | Mặc định |
|---|---|
| Upload | 100 MiB/file; chỉ `.nii`/`.nii.gz` |
| Quota lưu trữ cục bộ | 20 GiB toàn hệ thống, 2 GiB mỗi bác sĩ. Admin có thể điều chỉnh. |
| Nội dung sau giải nén | 256 MiB/file, có kiểm tra trước khi cấp phát mảng |
| Modality mỗi ca | Tối đa 2: FLAIR, T1ce |
| Job active mỗi ca | 1 (`queued` hoặc `running`) |
| Worker concurrency | 1 |
| Heartbeat / lease | 15 giây / 90 giây |
| Retry tự động | Tối đa 1 lần sau lỗi phục hồi được hoặc hết lease |
| Polling FE | 3 giây khi còn job active; dừng khi terminal hoặc trang ẩn |
| Access / refresh token | 15 phút / tối đa 7 ngày cho một session family |
| Editor | Desktop ≥1024 px; nhỏ hơn chỉ xem, không sửa |
| Pagination | 20 mặc định, tối đa 100 |

Không thay volume sau khi có job hoặc mask version; tạo ca mới cho đầu vào mới để giữ provenance. Chỉ được thay file khi ca chưa có job và chưa có mask version.

## 7. Thành công của bản đầu

Toàn bộ luồng từ bác sĩ đăng nhập đến tải lại mask đã sửa chạy được với AI thật. Kiểm tra âm tính phân quyền, vòng đời JWT, sai hình học, xung đột lưu, phục hồi worker và restore backup phải đạt. Ghi cấu hình máy và benchmark; không đưa cam kết thời gian inference hoặc độ chính xác lâm sàng trước khi đo và đánh giá.
