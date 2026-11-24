# FE-07 — Kế hoạch kiểm thử và nghiệm thu

## Vai trò và công cụ

Agent QA độc lập sở hữu các kịch bản kiểm thử chéo; frontend agent sửa lỗi và bổ sung unit tests liên quan. Không có giả định một skill “agent testing” đã được cài. Công cụ: Vitest, React Testing Library, MSW cho API fixture và Playwright cho E2E/browser.

Không dùng screenshot snapshot làm bằng chứng duy nhất cho mask đúng. So sánh buffer voxel và export bằng backend/NiBabel là bắt buộc với hình học.

## Tầng kiểm thử

| Tầng | Nội dung | Chạy |
|---|---|---|
| Unit | Validation form, error mapping, auth coordination, index transform, stroke/undo/redo, dirty state | Mỗi PR |
| Component/integration | Query/loading/error, form submit, upload state, route guard, save conflict | Mỗi PR |
| Browser E2E | Luồng bác sĩ/admin, JWT expiry, upload/job/editor/export, back/refresh | CI và trước release |
| WebGL thật | NiiVue đồng bộ viewport, click-to-voxel, orientation, context loss | Máy nghiệm thu trước release |
| AI thật | Một ca hai xung qua worker đến mask tải xuống | P5/P7, không thay bằng fixture |

CI E2E sử dụng worker giả có dữ liệu đầu ra xác định và metadata fixture riêng; không cần GPU. Báo cáo phải phân biệt kết quả fake-worker và real-model.

## Fixtures

- Hai doctor A/B, một admin, một doctor bị khóa, một tài khoản buộc đổi mật khẩu.
- Hồ sơ giả, không dùng danh tính thật.
- Volume tổng hợp nhỏ có landmark bất đối xứng, affine không identity, spacing không đều, nhãn raw 0/1/2/4.
- Volume 240×240×155 và cặp FLAIR/T1ce của một ca BraTS đã được cho phép dùng để kiểm thử.
- File hỏng, file extension sai, affine mismatch, file quá giới hạn và mask khác shape.
- Job cho từng state, worker offline, timeout response sau commit và stale mask version.

## Ma trận theo phase

### P1 — Nền tảng

- Deep link và refresh mọi route, URL filter/back/forward.
- Keyboard focus, dialog focus trap/return, accessible labels, color contrast.
- Layout 375×812, 768×1024, 1280×800, 1440×900; editor chỉ bật ở độ rộng hỗ trợ.
- Loading/empty/403/404/5xx và request cancellation không gây toast sai.

### P2 — Auth

- Login đúng/sai, cookie bootstrap, must-change-password.
- Access expiry khi nhiều request đồng thời: một refresh/tab, mỗi read replay tối đa một lần.
- Hai tab refresh không kích hoạt reuse nhầm trong luồng được hỗ trợ.
- Logout/account lock làm clear dữ liệu cache, blob URLs, editor state.
- Chuyển user không thấy một frame dữ liệu người trước.
- Token không lưu localStorage, URL hoặc log; unsafe mutation không replay âm thầm.

### P3 — Patient/upload

- CRUD dữ liệu thuộc owner, field errors, mã trùng, ngày/năm không hợp lệ.
- Hai upload đúng; một file vẫn xem được nhưng AI khóa; thiếu/nhầm modality giải thích rõ.
- Hủy upload, mất mạng, hết phiên, lỗi parse và oversized file.
- Thay ID patient/case/file của doctor khác bị từ chối; không leak cache.
- Xóa ca có active job bị chặn; sau xóa không còn link hoạt động tới file.

### P4 — Editor

- Đối chiếu hai khung đồng bộ lát/zoom/pan; chuyển modality không đổi tọa độ mask.
- Axial/coronal/sagittal đúng orientation; dùng landmark thay vì đoán từ ảnh não đối xứng.
- Brush sửa đúng một lát, label đúng, erase về 0, voxel ngoài stroke không đổi.
- Undo/redo riêng mỗi lát; lịch sử giới hạn đúng; undo về nền clear dirty.
- Chuyển lát/layout/modal không mất edits; first/last slice không lặp giả ảnh ngoài biên.
- Save immutable version; AI buffer gốc không đổi; export round-trip bảo toàn geometry và histogram nhãn.
- 409 stale giữ bản nháp; timeout sau commit không tạo version đôi; dirty navigation có lựa chọn rõ.
- Mất phiên dọn dữ liệu; refresh access thành công giữ edits.

### P5–P6 — Jobs/admin/export

- Double click tạo một job; queued cancellation; running không có nút hủy.
- Mất mạng không đổi job thành failed; offline worker không giả tiến độ.
- Job hoàn tất khi đang edit không thay working mask.
- Link job cũ mở đúng version; PDF/browser print và download cùng version.
- Admin không thấy tên bệnh nhân/ảnh trong UI hoặc response, không truy cập API doctor.
- Khóa tài khoản, retry và cấu hình có trạng thái pending/refetch/audit đúng.

## Kịch bản E2E bắt buộc P7

1. Admin tạo doctor và cấp mật khẩu tạm.
2. Doctor đăng nhập, đổi mật khẩu, tạo bệnh nhân giả và ca.
3. Upload FLAIR/T1ce, chờ validation, chạy job.
4. Mở mask AI, đổi lát, tô/xóa một vùng xác định, undo/redo và lưu phiên bản.
5. Reload, mở đúng version, tải NIfTI và kiểm tra voxel/affine ngoài browser.
6. Doctor B và admin thử truy cập cùng patient/case/version/file và bị từ chối.
7. Admin khóa doctor A; tab doctor A mất phiên và dọn dữ liệu.
8. Restart dịch vụ/backend rồi đăng nhập lại tài khoản hợp lệ: dữ liệu đã lưu vẫn đúng.

## Bằng chứng nghiệm thu

- Báo cáo command, môi trường browser/OS, model/checkpoint hash cho smoke AI, kết quả pass/fail và lỗi còn lại.
- Playwright trace/video chỉ dùng dữ liệu giả; không upload tự động artefact có dữ liệu bệnh nhân thật.
- Performance đo trên máy ghi rõ CPU/GPU/RAM: thời gian load volume, chuyển lát, save và inference; chưa đặt SLA lâm sàng.
- Không còn lỗi phân quyền, sai hình học, mất edits hoặc ghi đè version trước khi bàn giao.
- Lỗi không chặn phải có mô tả, mức ảnh hưởng và cách tái hiện; không thay kiểm thử bằng checklist đánh dấu không có bằng chứng.
