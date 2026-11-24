# FE-05 — Tác vụ AI, kết quả và xuất dữ liệu

## Phạm vi P5–P6

Nối ca hợp lệ với worker TDA-SegUNet, theo dõi job, mở mask kết quả và xuất đúng phiên bản. Model một xung hoặc lựa chọn nhiều mô hình không thuộc bản đầu.

## Chạy AI

- Nút “Chạy phân đoạn” chỉ bật khi backend xác nhận đủ FLAIR/T1ce tương thích, tài khoản có quyền và không có job queued/running của ca.
- Worker offline vẫn có thể gửi job vào hàng đợi nếu hệ thống đang nhận job; dialog thông báo job sẽ chờ worker. Không giả báo đã chạy.
- Gửi `POST /cases/{id}/jobs` với header `Idempotency-Key`; nhận 202 `{job}`. Khi người dùng bấm lại/double click, giữ cùng một pending request.
- Nếu backend báo đã có active job, mở job đó thay vì tạo toast chung hoặc job mới.
- Không gửi segmentation ground truth cùng request chạy AI.

## Trạng thái và polling

| State API | Nhãn UI | Hành động |
|---|---|---|
| `queued` | Đang chờ | Xem trạng thái, hủy job |
| `running` | Đang xử lý | Xem giai đoạn/tiến độ, chưa cho hủy |
| `succeeded` | Hoàn tất | Mở đúng mask version do job tạo |
| `failed` | Thất bại | Xem lỗi phù hợp người dùng, thử lại có chủ ý |
| `cancelled` | Đã hủy | Tạo job mới khi đủ điều kiện |

- `GET /jobs/{id}` mỗi 3 giây khi queued/running và tab hiển thị. Khi tab ẩn tạm dừng polling; refetch khi quay lại.
- `GET /system/availability` cung cấp `accepting_jobs` và `worker_online`; khi maintenance không cho gửi job, không suy ra khả năng nhận job chỉ từ trạng thái worker.
- Worker heartbeat quá 90 giây được xem là offline theo backend; phân biệt “mất kết nối API” và “worker offline”.
- Mất mạng không đổi job sang failed; hiện thông báo chưa cập nhật trạng thái và refetch sau phục hồi.
- Giai đoạn hiển thị: đọc/kiểm tra ảnh, preprocessing/TDA, inference theo lát, dựng mask, lưu kết quả.
- Phần trăm chỉ lấy từ server nếu có đại lượng xác định; ghi `x/N lát` cho bước theo lát. Không giả tiến độ tăng theo timer.
- Không mặc định một ca có 155 lát; lấy tổng từ metadata. Không hứa thời gian hoàn tất trước benchmark.
- Thành công invalidate case/version queries; nếu bác sĩ đang chỉnh mask không tự thay bản đang xem, chỉ báo “Có kết quả AI mới”.

## Retry và lỗi

- `POST /jobs/{id}/cancel` chỉ cho queued; nếu đã chuyển running, refetch và giải thích không hủy được.
- Retry lỗi qua tạo job mới hoặc action retry được OpenAPI quy định; mỗi ý định retry mới có idempotency key mới.
- Thông báo lỗi thân thiện: thiếu ảnh, hình học không hỗ trợ, worker mất kết nối, tài nguyên không đủ, lỗi model. Log kỹ thuật không hiển thị đường dẫn hoặc dữ liệu nhạy cảm.
- UI hiển thị số lần thử khi API cung cấp, phân biệt retry tự động và người dùng gửi lại.

## Kết quả và lịch sử phiên bản

- Danh sách phiên bản có nguồn AI/manual, ngày tạo, tác giả, model version và ghi chú; mặc định chọn bản mới nhất khi mới mở ca.
- Mỗi job thành công liên kết đúng output version ID. Không chọn theo quy tắc filename hay “version mới nhất” khi mở kết quả một job cũ.
- Bản AI gốc chỉ đọc; nút sửa tạo working copy và lưu phiên bản mới.
- Thống kê thể tích (số voxel, `mm³` và `mL = mm³ / 1000`) áp dụng cho phiên bản đang chọn, hiển thị đầy đủ cả 3 lớp gốc rời nhau (`1` NCR/NET, `2` Edema, `4` Enhancing Tumor), tổng vùng phân đoạn không chồng lấp (tổng các nhãn khác `0`, tức `{1, 2, 4}`), và 3 nhóm lâm sàng BraTS `WT = {1, 2, 4}` (Whole Tumor), `TC = {1, 4}` (Tumor Core), `ET = {4}` (Enhancing Tumor).
- Cảnh báo rõ trên giao diện và bản tóm tắt rằng `WT`, `TC`, `ET` là các nhóm chồng lấp/lồng nhau nên không được cộng gộp `WT + TC + ET` thành tổng thể tích phân đoạn.
- Nếu có coverage cảnh báo, giữ thông báo trong viewer và trang tóm tắt; không chỉ ghi trong log.

## Export và bản in

- Tải mask `.nii.gz` và JSON metadata từ server, thông qua request có quyền. Tên file dùng mã ca và phiên bản, không bắt buộc họ tên bệnh nhân.
- JSON gồm case/model/version IDs, thời gian, label mapping, geometry và coverage; không chứa đường dẫn storage hay secrets.
- Trang in dùng kết quả đã lưu: mã bệnh nhân/mã ca, ngày chụp, model, nguồn phiên bản, thể tích, ghi chú và thời điểm xuất. Không tự thêm kết luận chẩn đoán.
- Nút “In / Lưu PDF” dùng trình duyệt, không tuyên bố đã tạo PDF server. Print CSS bỏ navigation/toolbars, giữ nhãn và thông tin nguồn.
- Nếu editor dirty, export yêu cầu lưu hoặc chọn rõ bản đã lưu; không trộn thống kê đã sửa với mask cũ.

## Nghiệm thu

- Job chạy thật tạo mask và mở đúng phiên bản; polling dừng ở trạng thái kết thúc.
- Double click không tạo hai job; worker ngắt rồi phục hồi hiển thị đúng trạng thái.
- Mất API không bị trình bày thành inference thất bại.
- AI hoàn tất khi đang sửa không ghi đè working mask.
- File tải xuống khớp phiên bản đang chọn; trang in không có thông tin của phiên bản khác.
