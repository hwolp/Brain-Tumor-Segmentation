# Triển khai tự động lên Azure Linux VM bằng GitHub CI/CD

Tài liệu này hướng dẫn cấu hình **GitHub Actions CI/CD** để tự động kiểm thử, build Docker image lên **GitHub Container Registry (GHCR)** và triển khai Web Stack (`postgres`, `api`, `web`) lên **Azure Virtual Machine (Ubuntu Linux)** qua SSH.

> **Phạm vi dịch vụ:** Azure VM chạy Web Stack (`PostgreSQL 16`, `FastAPI API`, `Nginx + React SPA`). **AI Worker (`BE/worker/service.py`)** vẫn chạy tách rời trên máy GPU/Colab/VM riêng thông qua `docker-compose.worker.yml` và giao tiếp với Backend qua `/api/v1/internal/*`.

---

## 1. Luồng CI/CD hoạt động như thế nào?

1. **Pull Request (`master` / `main`)** — chạy [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml):
   - **`backend`**: Khởi động `postgres:16-alpine` service container, kiểm tra `ruff`, `scripts.export_openapi --check`, `alembic upgrade head && alembic check`, và toàn bộ `BE/tests/{unit,integration,contract}`.
   - **`frontend`**: Chạy `npm ci`, `npm run typecheck`, `npm test -- --run`, và production build (`VITE_USE_FIXTURES=false npm run build`).
   - **`docker-and-deploy-check`**: Kiểm tra cú pháp `deploy/azure/deploy.sh`, xác thực `docker-compose.azure.yml` với `azure.env.example`, và build thử `BE/Dockerfile` + `FE/Dockerfile.prod`.
2. **Push lên `master` / `main` (hoặc chạy tay `workflow_dispatch`)** — chạy [`.github/workflows/deploy-azure.yml`](../../.github/workflows/deploy-azure.yml):
   - Chạy lại toàn bộ `ci` gate (`backend` + `frontend`).
   - Build & push 2 image lên GHCR với tag bất biến `sha-<7chars>` và `latest`:
     - `ghcr.io/<owner>/<repo>-api` (từ `BE/Dockerfile`)
     - `ghcr.io/<owner>/<repo>-web` (từ `FE/Dockerfile.prod` + `FE/nginx.conf`)
   - SSH vào Azure VM (thuộc GitHub Environment `production`):
     - Copy `docker-compose.azure.yml`, `deploy.sh`, `azure.env.example`, `nginx.https.conf.example` vào `AZURE_DEPLOY_DIR` (mặc định `/opt/bts`).
     - Đăng nhập GHCR trên VM bằng token ngắn hạn, chạy `deploy.sh`:
       1. Pull image mới (`api`, `web`).
       2. Đảm bảo `postgres` healthy.
       3. Chạy `alembic upgrade head` (và tự sinh cặp khóa JWT RSA-2048 trong volume `bts_secrets` ở lần triển khai đầu tiên nếu chưa có).
       4. Recreate `api` và `web`, đợi healthcheck + kiểm tra `/healthz`, `/api/v1/health/live`, `/api/v1/health/ready`, `/.well-known/jwks.json`.
       5. Chỉ cập nhật `IMAGE_TAG` vào `/opt/bts/.env` và `.last_deployed_tag` sau khi smoke check thành công.

---

## 2. Chuẩn bị Azure Linux VM (thực hiện 1 lần)

Khuyến nghị **Ubuntu Server 22.04 LTS / 24.04 LTS** (tối thiểu **2 vCPU / 4 GB RAM**, ổ đĩa **30 GB+** để lưu image Docker, PostgreSQL và file `.nii.gz`).

### 2.1. Mở cổng mạng trong Azure Network Security Group (NSG)

Trong Azure Portal → VM → **Networking / Network settings**, mở Inbound port rules:

| Port | Giao thức | Mục đích | Ghi chú |
|---|---|---|---|
| `22` | TCP | SSH cho quản trị & GitHub Actions | Nên giới hạn IP khi có thể |
| `80` | TCP | HTTP Web + API reverse proxy (Phase 1 & ACME) | Bắt buộc cho Phase 1 |
| `443` | TCP | HTTPS (Phase 2 khi có domain) | Mở sẵn hoặc mở khi nâng HTTPS |

> **Lưu ý bảo mật:** Không mở port `5432` (PostgreSQL) hay `8000` (Uvicorn) ra Internet. Nginx (`web`) là cổng vào duy nhất và chuyển tiếp `/api/v1` + `/.well-known/jwks.json` nội bộ sang `api:8000`.

### 2.2. Cài Docker Engine, Docker Compose v2 & `curl` trên Azure VM

SSH vào Azure VM và chạy:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Cài Docker Engine + Docker Compose plugin chính thức
curl -fsSL https://get.docker.com | sudo sh

# Tạo user deploy (hoặc dùng user VM hiện tại) và cấp quyền docker
sudo usermod -aG docker "$USER"
newgrp docker

# Kiểm tra phiên bản
docker --version
docker compose version
```

### 2.3. Tạo thư mục triển khai và tệp `/opt/bts/.env`

```bash
sudo mkdir -p /opt/bts
sudo chown -R "$USER":"$USER" /opt/bts
chmod 750 /opt/bts
```

Tạo tệp `/opt/bts/.env` dựa theo [`azure.env.example`](./azure.env.example) (hoặc chạy trước một lần sau khi push code; ở lần đầu tiên cần tạo `/opt/bts/.env` **trước** khi CD chạy):

```bash
# Sinh mật khẩu DB (hex không chứa ký tự đặc biệt làm vỡ URL) và WORKER_TOKEN mạnh
DB_PW="$(openssl rand -hex 24)"
WORKER_TOK="$(openssl rand -hex 32)"
AZURE_PUBLIC_IP="<DIEN_PUBLIC_IP_AZURE_VM>"

cat > /opt/bts/.env <<EOF
API_IMAGE=ghcr.io/hwolp/brain-tumor-segmentation-api
WEB_IMAGE=ghcr.io/hwolp/brain-tumor-segmentation-web
IMAGE_TAG=latest

HTTP_PORT=80

POSTGRES_DB=bts_prod
POSTGRES_USER=bts_user
POSTGRES_PASSWORD=${DB_PW}
DB_POOL_SIZE=5
DB_MAX_OVERFLOW=10

# Phase 1: Public IP qua HTTP (khi có domain + HTTPS mới đổi sang production)
APP_ENV=local
COOKIE_SECURE=false
PUBLIC_ORIGIN=http://${AZURE_PUBLIC_IP}
ALLOWED_ORIGINS=[]

SERVICE_NAME=brain-tumor-api
LOG_LEVEL=INFO

JWT_KEY_ID=azure-rs256-v1
JWT_ISSUER=brain-tumor-api
JWT_AUDIENCE=brain-tumor-web
AUTO_INIT_JWT_KEYS=true

WORKER_TOKEN=${WORKER_TOK}
WORKER_API_BASE_URL=http://api:8000
MODEL_CHECKPOINT_PATH=/models/best.pt
WORKER_DEVICE=cpu
EOF

chmod 600 /opt/bts/.env
```

> **Quan trọng về `APP_ENV` khi chỉ có Public IP (Phase 1):**
> - Backend (`BE/app/core/config.py`) bắt buộc `COOKIE_SECURE=true` và `PUBLIC_ORIGIN=https://...` nếu `APP_ENV=production`.
> - Vì vậy khi chạy tạm bằng **HTTP + Public IP** (`http://<AZURE_PUBLIC_IP>`), giữ `APP_ENV=local` và `COOKIE_SECURE=false` để trình duyệt vẫn gửi/nhận refresh cookie `bts_refresh` và kiểm tra CSRF Origin khớp với `http://<AZURE_PUBLIC_IP>`.
> - Nếu `POSTGRES_PASSWORD` được tự đặt thủ công, tránh ký tự `@`, `:`, `/`, `?`, `#`, `%` hoặc phải URL-encode vì nó được nhúng vào `DATABASE_URL`. Dùng `openssl rand -hex 24` là an toàn nhất.
> - `ALLOWED_ORIGINS` phải là mảng JSON hợp lệ (ví dụ `[]` hoặc `["http://1.2.3.4"]`), **không** dùng chuỗi phân tách bằng dấu phẩy.

---

## 3. Cấu hình SSH Key & GitHub Secrets / Environment

### 3.1. Tạo cặp khóa SSH riêng cho GitHub Actions

Trên máy cục bộ hoặc trên Azure VM:

```bash
ssh-keygen -t ed25519 -C "github-actions-azure-deploy" -f ~/.ssh/bts_azure_deploy -N ""
```

Thêm nội dung `~/.ssh/bts_azure_deploy.pub` vào `~/.ssh/authorized_keys` của user deploy trên Azure VM:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat bts_azure_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Lấy host fingerprint để ghim `AZURE_VM_KNOWN_HOSTS` (chống MITM):

```bash
ssh-keyscan -p 22 -H <AZURE_PUBLIC_IP>
```

### 3.2. Khai báo GitHub Secrets & Environment

Vào GitHub Repo → **Settings → Environments** → tạo environment tên **`production`** (có thể bật *Required reviewers* nếu muốn duyệt tay trước khi deploy).

Thêm các **Secrets** (ở Environment `production` hoặc Repository Secrets):

| Tên Secret | Bắt buộc | Giá trị |
|---|---|---|
| `AZURE_VM_HOST` | Có | Public IP hoặc DNS name của Azure VM (vd. `20.198.xxx.xxx`) |
| `AZURE_VM_USER` | Có | Tên Linux user SSH trên Azure VM (vd. `azureuser`) |
| `AZURE_VM_SSH_KEY` | Có | Toàn bộ nội dung private key `~/.ssh/bts_azure_deploy` |
| `AZURE_VM_KNOWN_HOSTS` | Khuyên dùng | Output của `ssh-keyscan -p 22 -H <AZURE_PUBLIC_IP>` |
| `AZURE_VM_PORT` | Tùy chọn | Cổng SSH (mặc định `22`) |
| `AZURE_DEPLOY_DIR` | Tùy chọn | Thư mục deploy trên VM (mặc định `/opt/bts`) |
| `GHCR_USERNAME` | Tùy chọn | Dùng khi repo private cần PAT riêng để VM pull image |
| `GHCR_TOKEN` | Tùy chọn | PAT có quyền `read:packages` (nếu repo private/org hạn chế `GITHUB_TOKEN`) |

> **Lưu ý nếu repository đặt chế độ Private:** Package trên GHCR mặc định là private. Trong bước `deploy`, workflow dùng `GITHUB_TOKEN` (hoặc `GHCR_TOKEN` nếu được cấu hình) để chạy `docker login ghcr.io` trên VM rồi `docker logout ghcr.io` ngay sau khi xong. Nếu tổ chức/repo giới hạn phạm vi `GITHUB_TOKEN` trong gói package, hãy tạo PAT `read:packages` và gán vào `GHCR_USERNAME` + `GHCR_TOKEN`.

---

## 4. Khởi tạo tài khoản Admin sau lần deploy đầu tiên

Sau khi workflow `CD - Deploy to Azure VM` chạy xanh lần đầu, SSH vào Azure VM để tạo tài khoản Admin đầu tiên (không có mật khẩu admin mặc định trong mã nguồn):

```bash
cd /opt/bts
docker compose --env-file .env -f docker-compose.azure.yml exec -it api \
  python -m scripts.bootstrap_admin --username adminops --display-name "Quản trị hệ thống"
```

Kiểm tra truy cập trình duyệt tại `http://<AZURE_PUBLIC_IP>` và đăng nhập `/login`.

---

## 5. Kết nối AI Worker tách riêng tới server Azure

Trên máy GPU / Google Colab / RunPod:

1. Đặt `WORKER_API_BASE_URL=http://<AZURE_PUBLIC_IP>` (Phase 1) hoặc `https://your-domain.example.com` (Phase 2).
2. Đặt `WORKER_TOKEN` trùng với giá trị `WORKER_TOKEN` trong `/opt/bts/.env` trên Azure VM.
3. Khởi chạy bằng [`docker-compose.worker.yml`](../../docker-compose.worker.yml) theo hướng dẫn tại [`docs/worker-cloud-deploy.md`](../../docs/worker-cloud-deploy.md) (lưu ý bật HTTPS ở Phase 2 trước khi chạy thực tế trên mạng công cộng để bảo vệ `X-Worker-Token` và dữ liệu ảnh NIfTI).

---

## 6. Rollback phiên bản cũ

Mỗi lần push build thành công, image được gắn tag bất biến `sha-<7-ký-tự-commit>`.

Để quay lại phiên bản cũ:
1. Vào GitHub → tab **Actions** → chọn **CD - Deploy to Azure VM** → bấm **Run workflow**.
2. Nhập `image_tag`, ví dụ `sha-cbfb132`.
3. (Tùy chọn) Tick `skip_ci` để deploy lại tag cũ ngay lập tức.

Trên server cũng có thể rollback trực tiếp bằng:

```bash
cd /opt/bts
IMAGE_TAG=sha-cbfb132 ./deploy.sh
```

---

## 7. Nâng cấp lên Domain + HTTPS (Phase 2)

Khi đã trỏ domain (`A record`) về `<AZURE_PUBLIC_IP>` và mở port `443` trên Azure NSG:

1. Cài Certbot trên Azure VM (chạy standalone tạm thời hoặc dùng webroot):
   ```bash
   cd /opt/bts
   # Tạm dừng container web vài giây nếu lấy chứng chỉ bằng --standalone
   docker compose --env-file .env -f docker-compose.azure.yml stop web
   sudo apt-get install -y certbot
   sudo certbot certonly --standalone -d your-domain.example.com
   sudo mkdir -p /var/www/certbot
   ```
2. Sao chép [`nginx.https.conf.example`](./nginx.https.conf.example) thành `/opt/bts/nginx.https.conf` và thay `YOUR_DOMAIN` bằng domain thật.
3. Tạo tệp `/opt/bts/docker-compose.override.yml` để mở cổng `443` và mount chứng chỉ TLS mà không bị `scp` từ CI/CD ghi đè ở các lần deploy sau (`deploy.sh` tự động nạp `docker-compose.override.yml` nếu tồn tại):
   ```yaml
   services:
     web:
       ports:
         - "${HTTPS_PORT:-443}:443"
       volumes:
         - ./nginx.https.conf:/etc/nginx/conf.d/default.conf:ro
         - /etc/letsencrypt:/etc/letsencrypt:ro
         - /var/www/certbot:/var/www/certbot:ro
   ```
4. Cập nhật `/opt/bts/.env`:
   ```dotenv
   APP_ENV=production
   COOKIE_SECURE=true
   PUBLIC_ORIGIN=https://your-domain.example.com
   ALLOWED_ORIGINS=[]
   ```
5. Khởi động lại stack (`./deploy.sh`).
6. Thiết lập gia hạn chứng chỉ tự động bằng `certbot renew` + reload nginx (`docker compose --env-file /opt/bts/.env -f /opt/bts/docker-compose.azure.yml -f /opt/bts/docker-compose.override.yml exec -T web nginx -s reload`).

---

## 8. Sao lưu (Backup) trên Azure VM

Dữ liệu bền vững nằm trong 3 Docker named volumes: `bts_pgdata` (PostgreSQL), `bts_storage` (ảnh NIfTI & mask), `bts_secrets` (khóa ký JWT RS256).

Có thể chạy `scripts.backup_restore` trực tiếp qua container `api` hoặc `postgres` trong `/opt/bts` theo quy trình bảo trì ở [`README.md`](../../README.md#8-sao-lưu-phục-hồi-cô-lập--khôi-phục-sự-cố-backup--restore--recovery-runbook).
