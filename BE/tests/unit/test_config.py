"""Unit tests for Settings configuration and environment validation."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings


def _valid_prod_kwargs(tmp_path: Path) -> dict[str, object]:
    return {
        "_env_file": None,
        "APP_ENV": "production",
        "DATABASE_URL": "postgresql+psycopg://app_prod:StrongRandomPass99@db.internal:5432/bts_prod",
        "STORAGE_ROOT": tmp_path / "storage",
        "PUBLIC_ORIGIN": "https://bts.hospital.example",
        "COOKIE_SECURE": True,
        "JWT_PRIVATE_KEY_PATH": tmp_path / "jwt-private.pem",
        "JWT_PUBLIC_KEY_PATH": tmp_path / "jwt-public.pem",
        "JWT_KEY_ID": "prod-rs256-2026",
        "JWT_ISSUER": "brain-tumor-api",
        "JWT_AUDIENCE": "brain-tumor-web",
        "MODEL_MANIFEST_PATH": tmp_path / "manifest.json",
        "MODEL_CHECKPOINT_PATH": tmp_path / "best.pt",
        "WORKER_API_BASE_URL": "http://127.0.0.1:8000",
        "WORKER_TOKEN": "prod-worker-service-token-64chars-long-enough",
        "WORKER_DEVICE": "cuda",
    }


def test_local_and_test_settings_load_safe_defaults() -> None:
    local_cfg = Settings(_env_file=None, APP_ENV="local")
    assert local_cfg.APP_ENV == "local"
    assert local_cfg.COOKIE_SECURE is False
    assert local_cfg.PUBLIC_ORIGIN == "http://127.0.0.1:5173"
    assert local_cfg.effective_storage_root == Path("./storage")
    assert local_cfg.WORKER_DEVICE == "cpu"

    test_cfg = Settings(_env_file=None, APP_ENV="test")
    assert test_cfg.APP_ENV == "test"
    assert test_cfg.SERVICE_NAME == "brain-tumor-api"


def test_production_settings_accept_complete_secure_config(tmp_path: Path) -> None:
    cfg = Settings(**_valid_prod_kwargs(tmp_path))
    assert cfg.APP_ENV == "production"
    assert cfg.COOKIE_SECURE is True
    assert cfg.WORKER_DEVICE == "cuda"
    assert cfg.effective_storage_root == (tmp_path / "storage")


def test_production_rejects_insecure_cookie_and_missing_configs(tmp_path: Path) -> None:
    base = _valid_prod_kwargs(tmp_path)

    with pytest.raises(ValidationError):
        Settings(**{**base, "COOKIE_SECURE": False})

    for required_field in (
        "DATABASE_URL",
        "STORAGE_ROOT",
        "JWT_PRIVATE_KEY_PATH",
        "JWT_PUBLIC_KEY_PATH",
        "JWT_KEY_ID",
        "MODEL_MANIFEST_PATH",
        "MODEL_CHECKPOINT_PATH",
        "WORKER_API_BASE_URL",
        "WORKER_TOKEN",
    ):
        with pytest.raises(ValidationError):
            Settings(**{**base, required_field: None})

    with pytest.raises(ValidationError):
        Settings(**{**base, "PUBLIC_ORIGIN": "http://bts.hospital.example"})

    with pytest.raises(ValidationError):
        Settings(**{**base, "PUBLIC_ORIGIN": "*"})

    with pytest.raises(ValidationError):
        Settings(
            **{
                **base,
                "DATABASE_URL": "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev",
            }
        )

    with pytest.raises(ValidationError):
        Settings(**{**base, "WORKER_TOKEN": "REPLACE_WITH_WORKER_SERVICE_TOKEN"})


def test_rejects_empty_storage_root_and_invalid_worker_device() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, APP_ENV="local", STORAGE_ROOT="   ")

    with pytest.raises(ValidationError):
        Settings(_env_file=None, APP_ENV="local", WORKER_DEVICE="tpu")

    with pytest.raises(ValidationError):
        Settings(_env_file=None, APP_ENV="local", ALLOWED_ORIGINS=["*"])

    cfg = Settings(
        _env_file=None,
        APP_ENV="local",
        PUBLIC_ORIGIN="http://127.0.0.1:5173/",
        ALLOWED_ORIGINS="http://localhost:5173/",
    )
    assert cfg.effective_allowed_origins == (
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    )


def test_env_example_has_all_required_keys_and_no_hardcoded_secrets() -> None:
    be_dir = Path(__file__).resolve().parents[2]
    env_example = be_dir / ".env.example"
    assert env_example.is_file()
    content = env_example.read_text(encoding="utf-8")

    expected_keys = [
        "APP_ENV=",
        "DATABASE_URL=",
        "STORAGE_ROOT=",
        "PUBLIC_ORIGIN=",
        "COOKIE_SECURE=",
        "PUBLIC_ORIGIN=http://127.0.0.1:5173",
        "JWT_PRIVATE_KEY_PATH=",
        "JWT_PUBLIC_KEY_PATH=",
        "JWT_KEY_ID=",
        "JWT_ISSUER=",
        "JWT_AUDIENCE=",
        "MODEL_MANIFEST_PATH=",
        "MODEL_CHECKPOINT_PATH=",
        "WORKER_API_BASE_URL=",
        "WORKER_TOKEN=",
        "WORKER_DEVICE=",
    ]
    for key in expected_keys:
        assert key in content

    assert "D:\\" not in content
    assert "D:/" not in content
    assert "bts_local_dev_pw" not in content
