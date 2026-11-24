"""Authentication and session Pydantic schemas."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.common import UTCDatetime


class LoginRequest(BaseModel):
    """Credentials payload for POST /api/v1/auth/login."""

    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def _normalize_username(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("Tên đăng nhập phải là chuỗi ký tự.")
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("Tên đăng nhập không được để trống.")
        return normalized


class UserOut(BaseModel):
    """Public user profile returned to authenticated users."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    display_name: str
    role: Literal["admin", "doctor"]
    is_active: bool
    must_change_password: bool
    created_at: UTCDatetime


class AuthTokenResponse(BaseModel):
    """Access token envelope returned on login and refresh."""

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = 900
    user: UserOut


class ChangePasswordRequest(BaseModel):
    """Password change payload (preserves leading/trailing spaces)."""

    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)

    @model_validator(mode="after")
    def _ensure_distinct_password(self) -> ChangePasswordRequest:
        if self.new_password == self.current_password:
            raise ValueError("Mật khẩu mới phải khác mật khẩu hiện tại.")
        return self


class JwkItem(BaseModel):
    """Single RSA public JWK entry."""

    kty: Literal["RSA"] = "RSA"
    use: Literal["sig"] = "sig"
    alg: Literal["RS256"] = "RS256"
    kid: str
    n: str
    e: str


class JwksResponse(BaseModel):
    """JWKS document served at /.well-known/jwks.json."""

    keys: list[JwkItem]
