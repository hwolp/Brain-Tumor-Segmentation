# BE-01 — Xác thực, JWT và phân quyền

## 1. Phạm vi và phụ thuộc

Phase P2, cần PostgreSQL/migrations/config từ P1. Skill đã đọc: [`jwt-handler`](../../.codex/skills/jwt-handler/SKILL.md) tại `../../.codex/skills/jwt-handler/SKILL.md`. Không có đăng ký công khai, OAuth, gửi email reset mật khẩu trong v1.

## 2. Mô hình dữ liệu

| Bảng | Trường chính và ràng buộc |
|---|---|
| `users` | `id`, `username` unique chuẩn hóa chữ thường, `display_name`, `password_hash`, `role` (`admin`,`doctor`), `is_active`, `must_change_password`, `password_changed_at`, timestamps |
| `sessions` | `id`, `user_id`, `family_id` unique, `created_at`, `expires_at`, `revoked_at`, `revoke_reason` |
| `refresh_tokens` | `id`, `session_id`, `token_hash` unique, `created_at`, `expires_at`, `used_at`, `revoked_at`, `replaced_by_id` |

Mật khẩu hash bằng Argon2id; minimum 12, maximum 128 ký tự; cho phép khoảng trắng, không trim mật khẩu. Username 3–64 ký tự `[a-z0-9._-]`. Khóa tài khoản không xóa hồ sơ thuộc tài khoản.

## 3. Access token và refresh token

- Access JWT ký RS256 bằng RSA tối thiểu 2048 bit, TTL 900 giây; allowlist chỉ RS256.
- Claims `sub`, `sid`, `role`, `iat`, `exp`, `iss`, `aud`; không đưa tên bệnh nhân, tên người dùng hoặc thông tin hồ sơ vào token.
- `iss=brain-tumor-api`, `aud=brain-tumor-web`; clock skew tối đa 30 giây. Header có `kid`.
- Private key qua secret/file riêng, không commit. Endpoint `/.well-known/jwks.json` chỉ công bố public keys.
- Refresh token opaque dùng tối thiểu 32 byte ngẫu nhiên; chỉ lưu SHA-256 hash trong DB.
- Session/refresh hết hạn tuyệt đối sau 7 ngày từ login; rotation không kéo dài session vô hạn.
- Frontend chỉ lưu access token trong memory, không localStorage/sessionStorage.
- Cookie `bts_refresh`: `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`, `Max-Age` theo thời gian session còn lại. `Secure=true` khi HTTPS; chỉ local development trên localhost được false. Không đặt Domain để dùng host-only cookie.
- Local frontend sử dụng Vite proxy `/api` để browser thấy cùng origin; release dùng reverse proxy cùng origin. Không phụ thuộc third-party cookies.

## 4. API

| Method/path | Input | Output/hành vi |
|---|---|---|
| `POST /auth/login` | `{username,password}` | 200 `{access_token,token_type:"bearer",expires_in:900,user}` và Set-Cookie refresh |
| `POST /auth/refresh` | Cookie, body rỗng | 200 cùng access envelope như login, refresh cookie mới |
| `POST /auth/logout` | Cookie và/hoặc access | 204; revoke session, clear cookie; idempotent |
| `GET /auth/me` | Bearer | User gồm id, username, display_name, role, is_active, must_change_password |
| `POST /auth/change-password` | `{current_password,new_password}` | 204; đổi hash, revoke mọi session, clear cookie; yêu cầu đăng nhập lại |

Mật khẩu tạm: user `must_change_password=true` chỉ gọi `me`, `change-password`, `logout`; API nghiệp vụ trả `403 PASSWORD_CHANGE_REQUIRED`.

Login sai username/password/tài khoản khóa trả cùng `401 LOGIN_FAILED` để không dò tài khoản. Mặc định tối đa 5 lần login thất bại / username+IP / 15 phút, 30 lần / IP / 15 phút; trả 429 kèm `Retry-After`. Bộ đếm dùng PostgreSQL ở local để reset process không xóa giới hạn.

## 5. Rotation và race conditions

1. Hash cookie, khóa row refresh token bằng `SELECT ... FOR UPDATE`.
2. Kiểm tra session còn hạn, chưa revoke; user active.
3. Token đã dùng/revoke: revoke toàn family và trả `401 REFRESH_REUSED`.
4. Token hợp lệ: đánh dấu used, tạo successor và access mới trong transaction.
5. Commit rồi mới trả cookie; không có hai successor hợp lệ từ cùng refresh token.

Client dùng single-flight trong một tab và khóa refresh liên tab (Web Locks với BroadcastChannel thông báo trạng thái) khi được hỗ trợ. Browser không có cơ chế coordination mà xảy ra reuse thì yêu cầu đăng nhập lại; không nới kiểm tra reuse. Kiểm thử chéo tab bắt buộc trước release. Nếu refresh đã thành công phía server nhưng mất response, yêu cầu đăng nhập lại; không lưu plaintext refresh token chỉ để replay.

## 6. Xác thực request và quyền

Mỗi request nghiệp vụ kiểm tra signature/claims, truy vấn session và user hiện tại. Vai trò và active state trong DB là quyết định cuối cùng; token cũ không giữ quyền sau khi khóa tài khoản. Revoke phiên khi admin reset password hoặc disable user.

| Resource | Doctor | Admin |
|---|---|---|
| Hồ sơ cá nhân | Xem/đổi mật khẩu mình | Xem/đổi mật khẩu mình |
| Patients/cases/volumes/masks/jobs public | Chỉ resource mình sở hữu | 403 |
| Admin users/settings/audit | 403 | Cho phép |
| Admin job status | 403 | Metadata kỹ thuật, không file/PII |
| Worker internal APIs | 403 | 403; cần service credential |

Không cho chuyển owner hoặc role qua PATCH profile. Tài khoản admin không tự cấp cho mình quyền bác sĩ để bỏ qua ranh giới; nếu người vận hành cũng làm bác sĩ phải có tài khoản bác sĩ riêng.

## 7. CSRF, CORS và audit

- Login/refresh/logout kiểm tra Origin khớp allowlist và Fetch Metadata khi có. Local non-browser CLI được cấu hình/test riêng, không mở wildcard.
- Bearer API không dùng cookie làm authorization. CORS chỉ explicit origins, tuyệt đối không wildcard cùng credentials.
- Audit login success/failure, logout, reset/disable, reuse; lưu technical user/session IDs, IP theo cấu hình, request ID. Không log Authorization, Cookie, password hoặc token body.

## 8. Kiểm thử và nghiệm thu

- Token thiếu, sai chữ ký, sai thuật toán, sai issuer/audience, expired, kid lạ đều bị từ chối với code phân biệt.
- Rotation tạo đúng một successor; replay token cũ revoke family; session khác của user không tự bị revoke bởi reuse một family.
- Refresh đồng thời trong cùng tab và khác tab không gây request dư khi client hoạt động đúng.
- Logout, password change, admin disable/reset làm access token cũ hết quyền ngay.
- 403 admin đọc bệnh nhân; 404 doctor A truy cập ID của B; không rò rỉ qua search/list/count.
- Cookie flags kiểm tra bằng browser thực, CSRF từ origin khác bị từ chối.
- Không tìm thấy token trong localStorage, logs hoặc response không liên quan.
