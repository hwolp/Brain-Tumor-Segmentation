# Báo cáo Xác minh P0-AI — TDA-SegUNet Adapter & Manifest

**Trạng thái:** ĐẠT (Verified trên CPU; không chạy CUDA do môi trường hiện tại dùng `torch 2.8.0+cpu`).  
**Ngày xác minh:** 2026-11-17  
**Phạm vi:** Xác minh checkpoint thật `best.pt`, đóng gói adapter inference sạch (`BE/worker/`), viết model manifest tái lập (`BE/worker/manifest.json`), kiểm thử tự động (`BE/tests/ai/test_p0_adapter.py`) và chạy benchmark toàn bộ 155 lát cắt trên dữ liệu BraTS không có `_seg` lúc suy luận (`BE/worker/verify_p0.py`).

---

## 1. Xác minh Checkpoint & Kiến trúc

| Thuộc tính | Giá trị xác minh thực tế |
|---|---|
| Checkpoint path | `D:\Nam4\Ky1\PBL6\Demo2\outputs\tda_seg_unet_cce_dice\best.pt` |
| SHA-256 | `6ec9edc3b0d75474d8d8d427e8d962b6f7fabff1d2aab08ad972b08775413d3f` |
| Cấu trúc checkpoint | Dict keys: `['epoch', 'model', 'optimizer', 'scaler', 'best', 'metrics']` (`weights_only=True` hợp lệ) |
| Epoch / Val WT Dice | `epoch = 136`, `best = 0.9185095033286583` (`tc = 0.8780185`, `et = 0.8627177`) |
| Lớp mô hình | `TDASegUNet(in_channels=6, num_classes=4, base=16)` |
| Tên tầng trong `state_dict` | `i`, `d1`, `d2`, `d3`, `d4`, `u1`, `u2`, `u3`, `u4`, `out` (118 tensors) |
| Tổng số tham số | `1,943,060` tham số khả huấn (`strict=True` khớp 100%) |
| Nguồn huấn luyện đối chiếu | `D:\Nam4\Ky1\PBL6\Demo2\TDA_CCE_DICE_LOSS.ipynb`, `D:\Nam4\Ky1\PBL6\tda_seg_unet\{preprocess,tda}.py` |

Lưu ý: Hàm `load_verified_model` trong [model.py](file:///D:/Nam4/Ky1/PBL6_WEB/Brain%20Tumor%20Segmentation/BE/worker/model.py) kiểm tra SHA-256 trước khi nạp và so sánh hằng thời gian bằng `hmac.compare_digest`; hỗ trợ cả checkpoint có key `'model'` lẫn `state_dict` chỉ chứa tensor thuần, đồng thời từ chối dict chứa metadata/giá trị không phải tensor mà thiếu key `'model'`, từ chối lệch key hoặc lệch shape/kiến trúc bằng `CheckpointVerificationError`, và không fallback sang CPU nếu `device="cuda"` được yêu cầu khi CUDA không khả dụng.

---

## 2. Đối chiếu Pipeline Huấn luyện & Suy luận

| Thành phần | Quy ước đã xác minh trong code gốc | Triển khai trong `BE/worker/` |
|---|---|---|
| Đầu vào bắt buộc | 2 xung `FLAIR` + `T1ce`, bỏ `_seg`, `t1`, `t2` khỏi inference | `run_case` chỉ nhận `flair_path`, `t1ce_path`; test tĩnh xác nhận không có `_seg`/`ground_truth`/`_t1.nii`/`_t2.nii` trong inference modules |
| Profile hình học | Scalar 3D `(240, 240, 155)`, spacing `(1.0, 1.0, 1.0)` mm | Kiểm tra `ndim == 3`, `np.isfinite`, quy đổi `xyzt_units` sang mm, `rtol=0, atol=1e-4` mm cho spacing & affine, `|det| > 1e-6`, `qform/sform` |
| Chuẩn hóa | Z-score theo từng 3D volume trên voxel `abs(v) > 1e-6`, nền giữ `0.0` (`float32`) | `zscore_volume` trong [preprocess.py](file:///D:/Nam4/Ky1/PBL6_WEB/Brain%20Tumor%20Segmentation/BE/worker/preprocess.py) |
| Tìm tâm & Crop | `automatic_flair_center` (Gaussian `sigma=1.0`, Sobel `0.15`, Yen / p90 fallback, opening `3x3`, closing `5x5`, fill holes, LCC `min_size=20`, fallback trọng tâm não/ảnh); crop `128x128` kẹp biên `[0, 112]` | `automatic_flair_center` + `crop_centered` + `restore_patches_to_volume` trong [preprocess.py](file:///D:/Nam4/Ky1/PBL6_WEB/Brain%20Tumor%20Segmentation/BE/worker/preprocess.py) |
| Kênh TDA (4 kênh) | `[FLAIR-H0, FLAIR-H1, T1ce-H0, T1ce-H1]`, `gudhi.CubicalComplex`, `tda_input_size=64`, `grid_size=32`, `output_size=128`, `bandwidth=0.30`, `min_persistence=0.05`, `birth_range=(-6, 6)`, `persistence_range=(0, 12)` | `make_tda_channels` trong [tda.py](file:///D:/Nam4/Ky1/PBL6_WEB/Brain%20Tumor%20Segmentation/BE/worker/tda.py); lát trống all-zero trả zeros sạch không NaN/Inf |
| Thứ tự 6 kênh đầu vào | `[FLAIR, T1ce, FLAIR-H0, FLAIR-H1, T1ce-H0, T1ce-H1]` | Khớp `Demo2Dataset` và `BraTSSliceDataset` |
| Mapping nhãn xuất | Contiguous `{0, 1, 2, 3}` → Raw BraTS `{0, 1, 2, 4}` (`uint8`) | `mask.nii.gz` lưu `uint8`, giữ nguyên `affine`, `zooms`, `qform`, `sform`, `xyzt_units` từ FLAIR tham chiếu |

Ghi chú kỹ thuật: Trong tập đánh giá offline của `Demo2` (`prepared_brats2d/cases/*.npz`), patch ảnh được lưu ở dạng `float16` để tiết kiệm dung lượng nên trên `BraTS20_Training_007` cho `40,864` voxel WT; khi chạy trực tiếp từ NIfTI ở `float32` qua adapter, kết quả dự đoán trên `BraTS20_Training_007` là `40,865` voxel WT (sai khác đúng 1 voxel biên trên 8.928.000 voxel volume, `WT Dice 0.906060` so với `0.906072`, `TC Dice 0.931594` và `ET Dice 0.882353` trùng khớp hoàn toàn).

---

## 3. Môi trường & Phần cứng Benchmark

- **OS:** Windows 11 (`Windows-11-10.0.26300-SP0`)
- **CPU / RAM:** `Intel64 Family 6 Model 154 Stepping 3, GenuineIntel` (16 logical cores), `15.68 GB` RAM
- **Python runtime:** `D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe` (`Python 3.13.5`)
- **CUDA:** `False` (`torch 2.8.0+cpu`, không có GPU CUDA trong env này)
- **Package versions đã khóa vào `manifest.json` (`dependencies`):**
  - `torch==2.8.0`, `numpy==2.2.6`, `scipy==1.16.1`, `nibabel==5.4.2`, `gudhi==3.13.0`, `scikit-image==0.26.0`, `pandas==2.3.1`, `psutil==7.0.0`
- **Gói chạy kiểm thử (không nằm trong `manifest.json`):** `pytest==9.0.3`
- **Ghi chú môi trường BE (`BE\.venv`):** Đã kiểm thử chéo bộ test AI trên `BE\.venv\Scripts\python.exe` (trong đó `nibabel==5.5.0`, các gói lõi khác cùng phiên bản), đạt 12/12 pass.

---

## 4. Kết quả Kiểm thử Tự động (`BE/tests/ai`)

**Các lệnh đã chạy sau lần sửa cuối:**
```powershell
BE\.venv\Scripts\python.exe -m pytest BE/tests/ai -v
D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe -m pytest BE/tests/ai -v
# Và chạy trực tiếp từ thư mục BE:
cd BE && .\.venv\Scripts\python.exe -m pytest tests/ai -v
```

**Kết quả:**
- `BE\.venv\Scripts\python.exe -m pytest BE/tests/ai -v`: **12 passed in 13.37s** (100% pass).
- `D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe -m pytest BE/tests/ai -v`: **12 passed in 12.84s** (100% pass).
- `cd BE && .\.venv\Scripts\python.exe -m pytest tests/ai -v`: **12 passed in 12.76s** (100% pass).

Các nhóm kiểm thử đã xác minh trong [test_p0_adapter.py](file:///D:/Nam4/Ky1/PBL6_WEB/Brain%20Tumor%20Segmentation/BE/tests/ai/test_p0_adapter.py):
- `test_load_verified_model_real_checkpoint`: nạp checkpoint `best.pt` thật, kiểm tra SHA-256, 1.943.060 tham số, forward `(1, 6, 128, 128)`.
- `test_load_verified_model_rejects_bad_sha256`: từ chối sai SHA-256 bằng `CheckpointVerificationError`.
- `test_load_verified_model_rejects_missing_model_key_and_shape_mismatch`: từ chối dict chứa metadata không phải tensor thiếu key `'model'` hoặc lệch shape tensor.
- `test_rejects_unverified_manifest_and_unavailable_cuda`: từ chối manifest chưa `verified` và không fallback CPU khi `device="cuda"` không sẵn sàng.
- `test_static_worker_inference_has_no_seg_or_ground_truth_references`: kiểm tra tĩnh các module inference và manifest không tham chiếu `_seg`, `ground_truth`, `_t1.nii`, `_t2.nii`.
- `test_qa_ai_01_inference_without_seg_t1_t2`: chạy adapter trên thư mục tạm cô lập chỉ có FLAIR + T1ce của `BraTS20_Training_001`, xác nhận callback tiến độ `loading -> preprocessing -> inference -> reconstructing -> saving -> done`.
- `test_qa_ai_02_crop_clamping_all_four_edges_and_restore`: kiểm tra kẹp biên 4 phía/góc `(0,0)`, `(112,0)`, `(0,112)`, `(112,112)` và từ chối tọa độ ngoài biên (chống negative wrapping).
- `test_qa_ai_02_empty_slice_tda_and_corner_hotspot_adapter`: kiểm tra TDA all-zero không NaN/Inf, lát trống trên affine phi đơn vị (`[-1, -1, 1]`), và hotspot sát góc trên-trái / dưới-phải.
- `test_qa_ai_03_labels_dtype_nifti_roundtrip_and_coverage`: kiểm tra `mask.nii.gz` round-trip qua `nib.load` (`shape == (240, 240, 155)`, `dtype == uint8`, nhãn `{0, 1, 2, 4}`, bảo toàn `affine`/`zooms`/`qform`/`sform`/`xyzt_units`), `coverage.json` (`unevaluated_outside_crop: true`, 155 entries), `metadata.json` (`WT`/`TC`/`ET` không cộng gộp).
- `test_unit_conversion_meter_vs_mm_accepted`: kiểm tra quy đổi đơn vị `meter` (`0.001`) sang `mm` (`1.0`).
- `test_rejects_geometry_and_input_mismatches`: từ chối sai shape `(128,128,155)`, ảnh 4D, voxel `NaN`, lệch spacing `(1.05 vs 1.0)`, lệch affine cùng shape/spacing, affine suy biến (`det == 0`), và thiếu `qform/sform`.
- `test_run_case_with_preloaded_model_skips_checkpoint_resolution`: regression test xác nhận `run_case(..., preloaded_model=...)` chạy thành công khi `default_checkpoint_path` không tồn tại và `MODEL_CHECKPOINT_PATH` không được đặt, đồng thời không gọi `resolve_checkpoint_path`.

---

## 5. Kết quả Chạy Thực tế 155 Lát (`verify_p0.py`)

**Lệnh chạy chính (không có `_seg`, `_t1`, `_t2` trong thư mục đầu vào lúc suy luận):**
```powershell
D:\Nam4\Ky1\PBL6\.venv\Scripts\python.exe BE/worker/verify_p0.py
```

### 5.1. Ca tham chiếu `BraTS20_Training_001` (155 lát đầy đủ, CPU)

| Chỉ số đo | Giá trị thực tế |
|---|---|
| Input cô lập | `BraTS20_Training_001_flair.nii`, `BraTS20_Training_001_t1ce.nii` |
| Output NIfTI | `shape=(240, 240, 155)`, `dtype=uint8`, `labels=[0, 1, 2, 4]`, `84,577` bytes (`.nii.gz`) |
| Bảo toàn hình học | `affine_match=True`, `zooms_match=True`, `qform_match=True`, `sform_match=True`, `xyzt_units=['mm', 'unknown']` |
| Coverage | `total_slices=155`, `evaluated_slices=155`, `empty_slices=20` (`[0..3, 139..154]`), `unevaluated_outside_crop=True` |
| Label voxel counts | `0`: `8,738,764` · `1`: `16,862` · `2`: `144,227` · `4`: `28,147` |
| Group volumes (`mm³`) | `WT`: `189,236.0` · `TC`: `45,009.0` · `ET`: `28,147.0` |
| `stage_timings_ms` | `load`: `397.119` · `preprocess`: `1402.792` · `tda`: `13531.432` · `inference`: `1936.230` · `reconstruct`: `80.732` · `save`: `80.233` |
| Tổng thời gian / Peak RAM | `17,428.538 ms` (~`17.43 s`), Peak RAM `681.824 MB` |

**Đối chiếu định lượng nội bộ sau suy luận với `BraTS20_Training_001_seg.nii`:**
- `WT`: Dice = `0.928734`, IoU = `0.866950` (`gt=211,979`, `pred=189,236`, `tp=186,311`)
- `TC`: Dice = `0.948545`, IoU = `0.902127` (`gt=43,185`, `pred=45,009`, `tp=41,828`)
- `ET`: Dice = `0.895811`, IoU = `0.811285` (`gt=27,742`, `pred=28,147`, `tp=25,033`)
- Tỷ lệ bao phủ u thật trong vùng crop `128x128` tự động: `211,953 / 211,979` (`99.9877%`)

### 5.2. Kiểm tra chéo trên ca tập Test độc lập `BraTS20_Training_007` (155 lát, CPU)

Vì `BraTS20_Training_001` thuộc split `train` trong dữ liệu chia gốc, `verify_p0.py` được chạy thêm trên ca tập `test` độc lập `BraTS20_Training_007` (từ thư mục cô lập chỉ có FLAIR + T1ce):
- Tổng thời gian: `18,059.302 ms` (`load=376.549`, `preprocess=1327.526`, `tda=14289.917`, `inference=1915.497`, `reconstruct=82.098`, `save=67.715`), Peak RAM `682.195 MB`, `empty_slices=17` (`[138..154]`).
- Đối chiếu nội bộ sau suy luận với `BraTS20_Training_007_seg.nii`:
  - `WT`: Dice = `0.906060`, IoU = `0.828255` (`gt=39,772`, `pred=40,865`)
  - `TC`: Dice = `0.931594`, IoU = `0.871948` (`gt=9,557`, `pred=9,301`)
  - `ET`: Dice = `0.882353`, IoU = `0.789474` (`gt=6,159`, `pred=5,945`)
  - Tỷ lệ bao phủ u thật trong vùng crop `128x128` tự động: `39,772 / 39,772` (`100.0%`)

---

## 6. Giới hạn Đã Ghi nhận & Khuyến nghị cho P3 / P5

1. **Profile đầu vào cố định:** Adapter chỉ nhận volume 3D scalar `(240, 240, 155)` với spacing `1.0 mm` (sau quy đổi `xyzt_units`). File ngoài profile bị từ chối với `InputGeometryError`, không tự resample/crop âm thầm.
2. **Vùng ngoài crop `128x128`:** Vùng ngoài cửa sổ crop mỗi lát được điền nhãn nền `0` để tạo thành volume đầy đủ `(240, 240, 155)` nhưng được đánh dấu `unevaluated_outside_crop: true` trong `coverage.json`; backend/UI ở P4–P6 không được diễn giải vùng ngoài crop là vùng đã đánh giá bởi mô hình.
3. **Nút thắt hiệu năng CPU:** Giai đoạn tính Persistence Image TDA chiếm `~77–79%` tổng thời gian CPU (`~13.5–14.3 s` / `17.4–18.1 s`). Ở P5, worker nên nạp model một lần lúc khởi động bằng `load_model_from_manifest` rồi tái sử dụng qua `preloaded_model`, và nếu triển khai GPU cần cài PyTorch CUDA build và benchmark lại thực tế.
4. **Cấu hình đường dẫn checkpoint:** Logic runtime ưu tiên tham số `checkpoint_path` → biến môi trường `MODEL_CHECKPOINT_PATH` → `default_checkpoint_path` trong `manifest.json`; không hardcode đường dẫn trong các module `.py`.
