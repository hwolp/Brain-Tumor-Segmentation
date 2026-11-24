#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$SCRIPT_DIR}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.azure.yml}"
STATE_FILE="${STATE_FILE:-$DEPLOY_DIR/.last_deployed_tag}"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-false}"

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy][ERROR] %s\n' "$*" >&2
  exit 1
}

read_env_var() {
  local key="$1"
  local file="$2"
  local line val
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 0
  fi
  val="${line#*=}"
  val="${val%$'\r'}"
  # Trim surrounding single or double quotes if matching
  if [[ "$val" == \"*\" && "$val" == *\" ]]; then
    val="${val:1:${#val}-2}"
  elif [[ "$val" == \'*\' && "$val" == *\' ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "$val"
}

upsert_env_key() {
  local file="$1"
  local key="$2"
  local val="$3"
  local tmp_file
  tmp_file="$(mktemp "${file}.tmp.XXXXXX")"
  KEY_NAME="$key" KEY_VAL="$val" awk '
    BEGIN {
      k = ENVIRON["KEY_NAME"]
      v = ENVIRON["KEY_VAL"]
      updated = 0
    }
    $0 ~ ("^[[:space:]]*" k "=") {
      print k "=" v
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print k "=" v
      }
    }
  ' "$file" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv "$tmp_file" "$file"
}

[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || fail "Environment file not found: $ENV_FILE (copy azure.env.example to $ENV_FILE first)"

if grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" | grep -q 'REPLACE_WITH_'; then
  fail "Unreplaced REPLACE_WITH_ placeholder found in $ENV_FILE. Fill real secrets and origin first."
fi

ENV_API_IMAGE="$(read_env_var "API_IMAGE" "$ENV_FILE")"
ENV_WEB_IMAGE="$(read_env_var "WEB_IMAGE" "$ENV_FILE")"
ENV_IMAGE_TAG="$(read_env_var "IMAGE_TAG" "$ENV_FILE")"
HTTP_PORT="$(read_env_var "HTTP_PORT" "$ENV_FILE")"
APP_ENV="$(read_env_var "APP_ENV" "$ENV_FILE")"
PUBLIC_ORIGIN="$(read_env_var "PUBLIC_ORIGIN" "$ENV_FILE")"

HTTP_PORT="${HTTP_PORT:-80}"
APP_ENV="${APP_ENV:-local}"

API_IMAGE="${API_IMAGE:-$ENV_API_IMAGE}"
WEB_IMAGE="${WEB_IMAGE:-$ENV_WEB_IMAGE}"
IMAGE_TAG="${IMAGE_TAG:-${ENV_IMAGE_TAG:-latest}}"

[[ -n "$API_IMAGE" ]] || fail "API_IMAGE is empty"
[[ -n "$WEB_IMAGE" ]] || fail "WEB_IMAGE is empty"
[[ -n "$IMAGE_TAG" ]] || fail "IMAGE_TAG is empty"

PREV_TAG=""
if [[ -f "$STATE_FILE" ]]; then
  PREV_TAG="$(tr -d '\r\n' < "$STATE_FILE" || true)"
fi
if [[ -z "$PREV_TAG" && -n "$ENV_IMAGE_TAG" && "$ENV_IMAGE_TAG" != "$IMAGE_TAG" ]]; then
  PREV_TAG="$ENV_IMAGE_TAG"
fi

export API_IMAGE WEB_IMAGE IMAGE_TAG

dc() {
  local compose_args=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ -f "$DEPLOY_DIR/docker-compose.override.yml" ]]; then
    compose_args+=(-f "$DEPLOY_DIR/docker-compose.override.yml")
  fi
  docker compose "${compose_args[@]}" "$@"
}

log "Deploying tag=${IMAGE_TAG} (API=${API_IMAGE}, WEB=${WEB_IMAGE}, APP_ENV=${APP_ENV})"

log "1/5 Pulling API and Web images..."
dc pull api web

log "2/5 Ensuring PostgreSQL is up and healthy..."
dc up -d --wait postgres

log "3/5 Running Alembic database migrations (and auto-initializing JWT keys if missing)..."
dc run --rm -T -e RUN_MIGRATIONS=false api python -m alembic -c /app/alembic.ini upgrade head

log "4/5 Starting updated API and Web containers..."
dc up -d --wait --remove-orphans api web

log "5/5 Running post-deploy smoke checks..."
smoke_ok=false
for attempt in $(seq 1 15); do
  if dc exec -T api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/ready', timeout=5)" >/dev/null 2>&1 \
    && curl -fsS --max-time 5 "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1; then
    if [[ "$APP_ENV" != "production" ]]; then
      if curl -fsS --max-time 5 "http://127.0.0.1:${HTTP_PORT}/api/v1/health/live" >/dev/null 2>&1 \
        && curl -fsS --max-time 5 "http://127.0.0.1:${HTTP_PORT}/api/v1/health/ready" >/dev/null 2>&1 \
        && curl -fsS --max-time 5 "http://127.0.0.1:${HTTP_PORT}/.well-known/jwks.json" >/dev/null 2>&1; then
        smoke_ok=true
        break
      fi
    else
      target_base="${HEALTHCHECK_BASE_URL:-$PUBLIC_ORIGIN}"
      if [[ -n "$target_base" ]]; then
        if curl -fsS --max-time 5 "${target_base%/}/api/v1/health/ready" >/dev/null 2>&1; then
          smoke_ok=true
          break
        fi
      else
        smoke_ok=true
        break
      fi
    fi
  fi
  sleep 2
done

if [[ "$smoke_ok" != "true" ]]; then
  log "Smoke check failed! Current service status:"
  dc ps || true
  log "Recent api/web logs:"
  dc logs --tail=80 api web || true
  if [[ "$AUTO_ROLLBACK" == "true" && -n "$PREV_TAG" && "$PREV_TAG" != "$IMAGE_TAG" ]]; then
    log "AUTO_ROLLBACK=true: rolling back to tag=${PREV_TAG}..."
    export IMAGE_TAG="$PREV_TAG"
    dc pull api web || true
    dc up -d --wait api web || true
  fi
  fail "Deployment failed smoke verification."
fi

upsert_env_key "$ENV_FILE" "API_IMAGE" "$API_IMAGE"
upsert_env_key "$ENV_FILE" "WEB_IMAGE" "$WEB_IMAGE"
upsert_env_key "$ENV_FILE" "IMAGE_TAG" "$IMAGE_TAG"
printf '%s\n' "$IMAGE_TAG" > "$STATE_FILE"

log "Cleaning up unused images older than 7 days..."
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true

log "Deployment succeeded for tag=${IMAGE_TAG}."
dc ps
