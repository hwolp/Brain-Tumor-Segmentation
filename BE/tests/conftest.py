"""Shared pytest fixtures.

Keep top-level imports side-effect free so unrelated test suites (such as
``BE/tests/ai``) are never affected when pytest collects tests.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit, urlunsplit

import pytest

_BE_ROOT = str(Path(__file__).resolve().parents[1])
if _BE_ROOT not in sys.path:
    sys.path.insert(0, _BE_ROOT)

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session

    from app.core.config import Settings

DEFAULT_TEST_DATABASE_URL = (
    "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_test"
)


@pytest.fixture(scope="session")
def postgres_url() -> str:
    """Return the PostgreSQL connection URL for isolated integration tests."""
    return os.environ.get("TEST_DATABASE_URL") or DEFAULT_TEST_DATABASE_URL


def _create_database_if_missing(dsn: str) -> None:
    import psycopg
    from psycopg import errors, sql

    parsed = urlsplit(dsn)
    db_name = parsed.path.lstrip("/")
    if not db_name:
        raise ValueError("Database name missing from PostgreSQL URL")

    last_exc: Exception | None = None
    for admin_db in ("postgres", "bts_dev"):
        if admin_db == db_name:
            continue
        admin_dsn = urlunsplit(
            (parsed.scheme, parsed.netloc, f"/{admin_db}", parsed.query, parsed.fragment)
        )
        try:
            with psycopg.connect(admin_dsn, connect_timeout=3, autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db_name))
                    )
            return
        except errors.DuplicateDatabase:
            return
        except psycopg.Error as exc:
            last_exc = exc
            continue
    raise RuntimeError(f"Could not create test database '{db_name}': {last_exc}")


@pytest.fixture(scope="session")
def ensure_postgres_ready(postgres_url: str) -> str:
    """Verify PostgreSQL test database is reachable (creating it if absent)."""
    import psycopg
    from psycopg import errors

    dsn = postgres_url.replace("postgresql+psycopg://", "postgresql://", 1)
    try:
        try:
            with psycopg.connect(dsn, connect_timeout=3) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                    cur.fetchone()
        except (errors.InvalidCatalogName, psycopg.OperationalError) as exc:
            if isinstance(exc, psycopg.OperationalError) and "does not exist" not in str(exc):
                raise
            _create_database_if_missing(dsn)
            with psycopg.connect(dsn, connect_timeout=3) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                    cur.fetchone()
    except Exception as exc:  # pragma: no cover - diagnostic failure path
        pytest.fail(f"PostgreSQL integration database is not reachable: {exc}")
    return postgres_url


@pytest.fixture(scope="session")
def migrated_postgres(ensure_postgres_ready: str) -> str:
    """Ensure the test database schema is migrated to Alembic head."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(_BE_ROOT) / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", ensure_postgres_ready)
    command.upgrade(cfg, "head")
    return ensure_postgres_ready


@pytest.fixture(scope="session")
def jwt_test_keypair(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """Generate a temporary RSA 2048-bit keypair in pytest tmp_path_factory."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key_dir = tmp_path_factory.mktemp("jwt_keys")
    priv_path = key_dir / "jwt-private.pem"
    pub_path = key_dir / "jwt-public.pem"

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    priv_path.write_bytes(priv_pem)
    pub_path.write_bytes(pub_pem)
    return priv_path, pub_path


@pytest.fixture()
def isolated_storage_root(tmp_path: Path) -> Path:
    """Provide an isolated writable storage directory per test."""
    root = tmp_path / "storage"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture()
def test_settings(
    migrated_postgres: str,
    isolated_storage_root: Path,
    jwt_test_keypair: tuple[Path, Path],
) -> Settings:
    """Build test Settings wired to isolated storage, RSA keys, and PostgreSQL."""
    from app.core.config import Settings

    priv_path, pub_path = jwt_test_keypair
    return Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL=migrated_postgres,
        STORAGE_ROOT=isolated_storage_root,
        PUBLIC_ORIGIN="http://127.0.0.1:5173",
        COOKIE_SECURE=False,
        JWT_PRIVATE_KEY_PATH=priv_path,
        JWT_PUBLIC_KEY_PATH=pub_path,
        JWT_KEY_ID="test-rs256-v1",
        JWT_ISSUER="brain-tumor-api",
        JWT_AUDIENCE="brain-tumor-web",
    )


@pytest.fixture()
def clean_auth_db(migrated_postgres: str) -> Iterator[None]:
    """Truncate P2 auth/audit tables before each auth/admin integration test."""
    from sqlalchemy import create_engine, text

    engine = create_engine(migrated_postgres)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "TRUNCATE TABLE audit_events, login_attempts, refresh_tokens, sessions, users "
                    "RESTART IDENTITY CASCADE"
                )
            )
        yield
    finally:
        engine.dispose()


@pytest.fixture()
def db_session(clean_auth_db: None, migrated_postgres: str) -> Iterator[Session]:
    """Provide a SQLAlchemy Session against the clean migrated test database."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(migrated_postgres)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with SessionLocal() as session:
            yield session
    finally:
        engine.dispose()


@pytest.fixture()
def api_client(test_settings: Settings) -> Iterator[TestClient]:
    """Provide a FastAPI TestClient wired to test Settings."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    application = create_app(settings=test_settings)
    with TestClient(application, raise_server_exceptions=False) as client:
        yield client
