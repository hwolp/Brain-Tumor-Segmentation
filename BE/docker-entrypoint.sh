#!/usr/bin/env sh
set -eu

mkdir -p "${STORAGE_ROOT:-/app/storage}" /app/secrets

if [ "${AUTO_INIT_JWT_KEYS:-true}" = "true" ] \
  && [ -n "${JWT_PRIVATE_KEY_PATH:-}" ] \
  && [ -n "${JWT_PUBLIC_KEY_PATH:-}" ] \
  && [ ! -f "${JWT_PRIVATE_KEY_PATH}" ] \
  && [ ! -f "${JWT_PUBLIC_KEY_PATH}" ]; then
  python -m scripts.bootstrap_admin --init-jwt-keys
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  python -m alembic -c /app/alembic.ini upgrade head
fi

exec "$@"
