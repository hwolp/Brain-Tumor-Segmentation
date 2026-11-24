"""JWKS public key endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.errors import AppError
from app.dependencies import JwtKeysDep
from app.schemas.auth import JwkItem, JwksResponse
from app.schemas.error import ErrorResponse

router = APIRouter(
    tags=["auth"],
    responses={
        500: {"model": ErrorResponse, "description": "Internal server error"},
        503: {"model": ErrorResponse, "description": "Signing keys are not configured"},
    },
)


@router.get("/.well-known/jwks.json")
def get_jwks(key_material: JwtKeysDep) -> JwksResponse:
    """Publish active RS256 public verification keys in JWKS format."""
    if key_material is None:
        raise AppError(
            status_code=503,
            code="service_unavailable",
            message="Hệ thống chưa cấu hình khóa công khai JWT RS256.",
        )
    return JwksResponse(keys=[JwkItem(**key_material.public_jwk)])
