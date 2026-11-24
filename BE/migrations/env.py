"""Alembic migration environment reading DATABASE_URL from application Settings."""

from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

_BE_DIR = Path(__file__).resolve().parents[1]
if str(_BE_DIR) not in sys.path:
    sys.path.insert(0, str(_BE_DIR))

from app.core.config import Settings  # noqa: E402
from app.models import Base  # noqa: E402

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _resolve_database_url() -> str:
    configured = config.get_main_option("sqlalchemy.url")
    if configured and configured.strip():
        return configured.strip()

    settings = Settings()
    if settings.DATABASE_URL:
        return settings.DATABASE_URL
    raise RuntimeError("DATABASE_URL must be configured to run Alembic migrations.")


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = _resolve_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _resolve_database_url()

    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
