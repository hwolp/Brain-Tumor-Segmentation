# FE-04 — Viewer và chỉnh sửa mask theo từng lát

## Mục tiêu P4

Xem khối MRI, đối chiếu ảnh gốc với mask, chuyển nhanh giữa các lát, tô/xóa axial và lưu phiên bản. Module hoạt động với fixture hợp lệ trước khi worker AI thật sẵn sàng. Không có tính năng so sánh ground truth ở phase này.

## Dữ liệu và hợp đồng

- Nhận metadata ca, volume, danh sách mask versions và quyền từ API. Download byte bằng request có Authorization; tạo object URL trong bộ nhớ, thu hồi khi đổi ca/logout/unmount.
- Shape, affine, spacing và thứ tự dữ liệu được giữ trong adapter. Index voxel không được đồng nhất máy móc với tọa độ màn hình.
- Mã nhãn raw: 0 nền, 1 NCR/NET, 2 phù nề, 4 vùng tăng quang. Tên và mã lấy từ model metadata đã xác minh; không đổi 4 thành 3 trong file xuất.
- Mask mới thủ công có cùng lưới ảnh tham chiếu, khởi tạo 0. Nếu chưa có mask, dùng `base_version_id: null`; chỉ được tạo initial version nếu backend xác nhận chưa có version hiện hành.
- Lưu qua `POST /cases/{id}/mask-versions`, multipart `mask` toàn khối, `base_version_id`, `reference_volume_id`, `note` và khóa idempotency. Export qua `/mask-versions/{id}/export`.
- API trả immutable ID/version number, tác giả, thời điểm, loại nguồn AI/manual, reference volume và thống kê. Không tự gán version number ở client.

## Bố cục và chế độ

### A. Đối chiếu — mặc định

Hai khung cùng kích thước: MRI gốc bên trái, MRI+mask bên phải. Đồng bộ lát, modality, zoom, pan, vị trí crosshair và window/level. Chỉ khung overlay nhận brush; click khung gốc khi đang tô không được sửa mask.

### B. Lát lân cận

Ba khung `k-1 / k / k+1`. Khung giữa sửa được, hai bên chỉ xem; khi đổi k các khung cập nhật. Ở đầu/cuối volume, khung ngoài phạm vi hiển thị “Không có lát”, không lặp lát biên để giả đủ ba khung. Chế độ này dùng cùng modality và opacity.

### C. Ba mặt phẳng

Axial/coronal/sagittal có crosshair đồng bộ. Tô/xóa chỉ được bật ở axial; hai mặt phẳng còn lại cập nhật theo mask nhưng chỉ đọc. Adapter hiển thị nhãn hướng theo affine; không tự coi chiều thứ ba luôn là axial khi chưa quy đổi hướng.

Chỉ bật editor khi mapping display-space về original voxel grid là chính xác và không cần resample. Với volume oblique, bản đầu chỉ cho xem và giải thích vì sao không chỉnh được; không nội suy nhãn rồi lưu với affine cũ.

Chuyển chế độ không mất lịch sử hoặc thay đổi chưa lưu. Từ màn hình dưới 1024 px, editor tắt, vẫn xem được một khung và điều khiển lát; dữ liệu đang sửa trên desktop không bị tự commit khi thu nhỏ cửa sổ.

## Điều khiển lát và hiển thị

- UI đánh số 1…N, dữ liệu nội bộ 0…N-1; hiển thị cả tổng số lát. Không hardcode 155 vào component.
- Thanh trượt, nút trước/sau, nhập số lát, phím mũi tên trái/phải khi viewer có focus.
- Wheel chuyển lát ở chế độ xem; Ctrl+wheel zoom. Khi brush hoạt động wheel không vô tình chuyển lát giữa stroke; chỉ chuyển khi không pointer-down.
- Phím tắt bỏ qua khi focus ở input, textarea, combobox hoặc dialog.
- Nút “Lát có mask trước/sau” dựa trên mask hiện tại; khi không có vùng khác thì disable. Không nhầm “không có mask” với kết luận y khoa không có u.
- Thanh điều hướng đánh dấu lát chứa mask và lát có thay đổi chưa lưu bằng ký hiệu riêng, có chú giải.
- Modality FLAIR/T1ce chỉ chuyển texture nền, giữ vị trí không gian, mask và lịch sử sửa.
- Opacity mặc định 40%, phạm vi 0–100%; bật/tắt từng nhãn là thao tác hiển thị, không sửa dữ liệu.
- Màu gợi ý: nhãn 1 `#F59E0B`, nhãn 2 `#22C55E`, nhãn 4 `#A855F7`. Chú giải luôn hiện mã/tên, không dựa vào màu đơn thuần.

## Brush, erase và undo/redo

- Công cụ: xem, tô, xóa. Chỉ một công cụ active tại một thời điểm; nhãn được chọn độc lập với công cụ.
- Cọ tròn trong mặt phẳng voxel axial; bán kính mặc định 3 voxel, giới hạn 1–20, bước 1. Hiển thị đơn vị voxel; không giả định 1 voxel = 1 mm.
- Stroke tạo một command với danh sách index và giá trị cũ/mới; nội suy đường đi con trỏ để không đứt nét. Pointer capture giữ stroke khi con trỏ rời canvas; kết thúc/cancel đúng khi mất focus.
- Tô ghi nhãn đã chọn; xóa đặt 0 cho các voxel chạm tới trên lát hiện tại, kể cả vùng thuộc nhãn khác. Tooltip phải giải thích hành vi xóa.
- Không sửa các lát lân cận; không tự copy/interpolate mask, không lấp lỗ tự động trong bản đầu.
- Undo/redo theo lát hiện tại. Command mới xóa redo của lát đó. Mặc định tối đa 100 stroke/lát và 64 MiB lịch sử toàn phiên; loại command cũ nhất khi vượt ngưỡng, hiển thị thông báo giới hạn lịch sử.
- Bộ nhớ mask gốc và working mask tách biệt; không sửa trực tiếp buffer AI gốc. Dirty được xác định theo dữ liệu khác bản nền, không chỉ dựa vào số thao tác.
- Undo về đúng bản nền phải bỏ dirty. Lát đã sửa rồi chuyển qua lát khác vẫn giữ dữ liệu trong working mask.

## Lưu, xung đột và phiên bản

1. Người dùng bấm Lưu; yêu cầu ghi chú tùy chọn, khóa editor ngắn trong lúc lấy snapshot.
2. Serialize snapshot thành NIfTI giữ shape/affine/spacing; có tiến độ hoặc trạng thái lưu, không cho bấm lưu lặp.
3. Khi server chấp nhận, cập nhật base version; working mask và snapshot khớp thì clear dirty.
4. Nếu cho phép sửa tiếp trong lúc truyền file, phải giữ dirty phần phát sinh sau snapshot. Bản đầu chọn khóa thao tác sửa trong lúc lưu để đơn giản và tránh mất thay đổi.
5. HTTP 409 base cũ: giữ working mask, thông báo đã có phiên bản mới; cho tải bản nháp về máy hoặc bỏ bản nháp để mở phiên bản mới. Không ghi đè/merge tự động, không tự đổi base rồi gửi lại.
6. Nếu gửi bị timeout, giữ nguyên payload đã gửi và cho người dùng thử lại với cùng khóa. Server trả đúng phiên bản đã tạo nếu lần trước đã lưu. Các chỉnh sửa sau lần gửi vẫn là bản nháp chưa lưu.
7. Chọn phiên bản khác/ca khác khi dirty: chọn “Ở lại”, “Lưu rồi chuyển”, “Bỏ thay đổi”. Việc chuyển chỉ diễn ra sau khi save thành công.

Mỗi save tạo immutable manual version. Phiên bản AI có nhãn “AI gốc”; phiên bản thủ công có tác giả/giờ. Export mặc định tải phiên bản đã lưu đang chọn; nếu dirty, phải chọn lưu trước hoặc xuất bản nháp có tên rõ, không âm thầm gắn bản nháp thành phiên bản đã lưu.

## Thống kê và coverage

- Thể tích theo nhãn dùng số voxel × `abs(det(affine[:3,:3]))` với affine đơn vị mm, chia 1000 để hiển thị mL. Kết quả chính thức lấy từ server sau lưu.
- Nếu hiện ước tính ngay khi sửa, gắn nhãn “Chưa lưu” và không thay số server của bản cũ.
- Model crop patch phải có thông tin coverage; cảnh báo phần ngoài crop chưa được AI đánh giá, không diễn giải nhãn 0 ngoài coverage thành xác nhận âm tính.
- Hiển thị model version và nguồn mask; chưa có điểm confidence hoặc “độ chính xác ca” không được kiểm chứng.

## Bộ nhớ, hiệu năng và lỗi

- Không giữ nhiều object URL/version cũ vô hạn. Hủy download khi đổi ca và dispose tài nguyên NiiVue/WebGL khi unmount.
- Không đưa buffer volume lớn vào React state hoặc render lại toàn cây theo mỗi mousemove. Tính index mask, histogram hoặc serialize nặng dùng Web Worker khi cần.
- WebGL không khả dụng/context lost: báo lỗi rõ, giữ bản sửa trong bộ nhớ nếu còn, cho thử tải lại viewer có xác nhận thay đổi chưa lưu.
- Download bị từ chối/metadata khác lưới: không overlay gần đúng, hiển thị lỗi và khóa chỉnh.
- Browser reload/tab close dùng beforeunload khi dirty; thông báo có thể bị trình duyệt giới hạn. Không hứa auto-recovery vì bản đầu không lưu nháp bền vững ở browser.

## Nghiệm thu trọng yếu

- Fixture bất đối xứng có landmark kiểm tra trái/phải, affine không identity, voxel spacing không đều.
- Tô tại một tọa độ xác định sau zoom/pan chỉ đổi voxel dự kiến và đúng lát; mask gốc bất biến.
- Chế độ hai khung/lân cận/ba mặt phẳng giữ cùng vị trí và buffer dữ liệu.
- Lát đầu/cuối, nhập số vượt phạm vi và nhảy tới lát có mask được xử lý đúng.
- Undo/redo, đổi modality, đổi layout, đổi lát và save round-trip không thay nhãn ngoài thao tác.
- File export mở lại bằng NiBabel kiểm tra số voxel từng nhãn, affine, shape, spacing và vùng coverage liên quan.
- Test save stale version và timeout bảo đảm không mất bản nháp, không ghi đè hoặc nhân đôi version.
