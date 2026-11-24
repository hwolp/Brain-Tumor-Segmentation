"""Application settings with strict production safety validation."""

from __future__ import annotations

from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_PLACEHOLDER_MARKERS = ("REPLACE_WITH", "bts_local_dev_pw")


def normalize_origin(origin: str) -> str:
    """Normalize an HTTP(S) origin string to scheme://netloc without trailing slash."""
    raw = origin.strip()
    if not raw or "*" in raw:
        raise ValueError("Origin must be an explicit non-wildcard URL")
    parsed = urlsplit(raw)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Origin must include valid http/https scheme and host")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Origin must not contain path, query, or fragment")
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


class Settings(BaseSettings):
    """Configuration settings loaded from environment variables or `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_ENV: Literal["local", "test", "production"] = "local"
    SERVICE_NAME: str = "brain-tumor-api"
    LOG_LEVEL: str = "INFO"

    DATABASE_URL: str | None = None
    DB_POOL_SIZE: int = Field(default=5, ge=1, le=100)
    DB_MAX_OVERFLOW: int = Field(default=10, ge=0, le=100)

    STORAGE_ROOT: Path | None = None
    STAGING_ORPHAN_MAX_AGE_SECONDS: int = Field(default=86400, ge=60)
    ORPHAN_CLEANUP_INTERVAL_SECONDS: int = Field(default=300, ge=10)
    MAX_UPLOAD_BYTES: int = Field(default=100 * 1024 * 1024, ge=1024)
    MAX_MULTIPART_OVERHEAD_BYTES: int = Field(default=1024 * 1024, ge=4096)
    MAX_DECOMPRESSED_BYTES: int = Field(default=256 * 1024 * 1024, ge=1024)
    DOCTOR_QUOTA_BYTES: int = Field(default=2 * 1024 * 1024 * 1024, ge=1024)
    SYSTEM_QUOTA_BYTES: int = Field(default=20 * 1024 * 1024 * 1024, ge=1024)

    PUBLIC_ORIGIN: str = "http://127.0.0.1:5173"
    ALLOWED_ORIGINS: list[str] = Field(default_factory=list)
    COOKIE_SECURE: bool = False

    JWT_PRIVATE_KEY_PATH: Path | None = None
    JWT_PUBLIC_KEY_PATH: Path | None = None
    JWT_KEY_ID: str | None = "local-dev-key"
    JWT_ISSUER: str = "brain-tumor-api"
    JWT_AUDIENCE: str = "brain-tumor-web"
    JWT_ACCESS_TTL_SECONDS: int = Field(default=900, ge=60, le=3600)
    REFRESH_SESSION_TTL_DAYS: int = Field(default=7, ge=1, le=30)
    JWT_CLOCK_SKEW_SECONDS: int = Field(default=30, ge=0, le=120)

    LOGIN_RATE_LIMIT_WINDOW_SECONDS: int = Field(default=900, ge=60, le=86400)
    LOGIN_RATE_LIMIT_PER_USER_IP: int = Field(default=5, ge=1, le=100)
    LOGIN_RATE_LIMIT_PER_IP: int = Field(default=30, ge=1, le=1000)

    MODEL_MANIFEST_PATH: Path | None = None
    MODEL_CHECKPOINT_PATH: Path | None = None

    WORKER_API_BASE_URL: str | None = "http://127.0.0.1:8000"
    WORKER_TOKEN: str | None = None
    WORKER_DEVICE: Literal["cpu", "cuda"] = "cpu"

    @field_validator(
        "STORAGE_ROOT",
        "JWT_PRIVATE_KEY_PATH",
        "JWT_PUBLIC_KEY_PATH",
        "MODEL_MANIFEST_PATH",
        "MODEL_CHECKPOINT_PATH",
        mode="before",
    )
    @classmethod
    def _reject_blank_paths(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise ValueError("Path configuration must not be empty or whitespace")
            return stripped
        return value

    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def _validate_database_url(cls, value: object) -> object:
        if value is None:
            return None
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return None
            if not (
                stripped.startswith("postgresql://")
                or stripped.startswith("postgresql+psycopg://")
            ):
                raise ValueError("DATABASE_URL must use a PostgreSQL scheme")
            return stripped
        raise ValueError("DATABASE_URL must be a string")

    @field_validator("LOG_LEVEL", mode="before")
    @classmethod
    def _normalize_log_level(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("LOG_LEVEL must be a string")
        normalized = value.strip().upper()
        if normalized not in _VALID_LOG_LEVELS:
            raise ValueError(f"LOG_LEVEL must be one of {sorted(_VALID_LOG_LEVELS)}")
        return normalized

    @model_validator(mode="after")
    def _validate_environment_constraints(self) -> Settings:
        if self.APP_ENV != "production":
            return self

        if not self.COOKIE_SECURE:
            raise ValueError("COOKIE_SECURE must be true when APP_ENV is 'production'")

        if not self.DATABASE_URL:
            raise ValueError("DATABASE_URL is required in production")
        if any(marker in self.DATABASE_URL for marker in _PLACEHOLDER_MARKERS):
            raise ValueError("DATABASE_URL must not use placeholder credentials in production")

        if self.STORAGE_ROOT is None:
            raise ValueError("STORAGE_ROOT is required in production")

        origin = (self.PUBLIC_ORIGIN or "").strip()
        if not origin or "*" in origin or not origin.startswith("https://"):
            raise ValueError("PUBLIC_ORIGIN must be an explicit https:// origin in production")

        required_text_fields = {
            "JWT_KEY_ID": self.JWT_KEY_ID,
            "JWT_ISSUER": self.JWT_ISSUER,
            "JWT_AUDIENCE": self.JWT_AUDIENCE,
            "WORKER_API_BASE_URL": self.WORKER_API_BASE_URL,
            "WORKER_TOKEN": self.WORKER_TOKEN,
        }
        for name, val in required_text_fields.items():
            if not val or not val.strip():
                raise ValueError(f"{name} is required in production")

        for name, path_val in (
            ("JWT_PRIVATE_KEY_PATH", self.JWT_PRIVATE_KEY_PATH),
            ("JWT_PUBLIC_KEY_PATH", self.JWT_PUBLIC_KEY_PATH),
            ("MODEL_MANIFEST_PATH", self.MODEL_MANIFEST_PATH),
            ("MODEL_CHECKPOINT_PATH", self.MODEL_CHECKPOINT_PATH),
        ):
            if path_val is None:
                raise ValueError(f"{name} is required in production")

        worker_token = (self.WORKER_TOKEN or "").strip()
        if any(marker in worker_token for marker in _PLACEHOLDER_MARKERS) or len(worker_token) < 16:
            raise ValueError(
                "WORKER_TOKEN must be a strong non-placeholder secret in production"
            )

        return self

    @field_validator("ALLOWED_ORIGINS", mode="before")
    @classmethod
    def _validate_allowed_origins(cls, value: object) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            raw_items = [part.strip() for part in value.split(",") if part.strip()]
        elif isinstance(value, (list, tuple, set)):
            raw_items = [str(item).strip() for item in value if str(item).strip()]
        else:
            raise ValueError("ALLOWED_ORIGINS must be a list of explicit origins")
        return [normalize_origin(item) for item in raw_items]

    @property
    def effective_allowed_origins(self) -> tuple[str, ...]:
        """Return deduplicated, explicit non-wildcard allowed origins."""
        origins: list[str] = []
        if self.PUBLIC_ORIGIN and self.PUBLIC_ORIGIN.strip():
            origins.append(normalize_origin(self.PUBLIC_ORIGIN))
        for item in self.ALLOWED_ORIGINS:
            norm = normalize_origin(item)
            if norm not in origins:
                origins.append(norm)
        return tuple(origins)

    @property
    def effective_storage_root(self) -> Path:
        """Return configured storage root or default local development path."""
        return self.STORAGE_ROOT if self.STORAGE_ROOT is not None else Path("./storage")
