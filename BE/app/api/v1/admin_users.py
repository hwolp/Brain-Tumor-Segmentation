"""Admin doctor account management endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response, status

from app.dependencies import (
    AdminUserDep,
    ClientIpDep,
    DbSessionDep,
    RequestIdDep,
    require_admin,
)
from app.schemas.admin_user import (
    AdminCreateDoctorRequest,
    AdminDoctorUserOut,
    AdminUpdateDoctorRequest,
    TemporaryPasswordResponse,
)
from app.schemas.common import PaginatedResponse
from app.schemas.error import ErrorResponse
from app.services.user_service import UserService

router = APIRouter(
    prefix="/api/v1/admin/users",
    tags=["admin-users"],
    dependencies=[Depends(require_admin)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Forbidden or password change required"},
        422: {"model": ErrorResponse, "description": "Validation error"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)


@router.get("")
def list_doctors(
    db: DbSessionDep,
    q: Annotated[str | None, Query(max_length=100)] = None,
    status_filter: Annotated[
        Literal["active", "locked"] | None,
        Query(alias="status"),
    ] = None,
    is_active: Annotated[bool | None, Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[AdminDoctorUserOut]:
    """List doctor accounts with optional search, active status filter, and pagination."""
    return UserService(db).list_doctors(
        q=q,
        status=status_filter,
        is_active=is_active,
        page=page,
        page_size=page_size,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": ErrorResponse, "description": "Username conflict"}},
)
def create_doctor(
    payload: AdminCreateDoctorRequest,
    admin: AdminUserDep,
    db: DbSessionDep,
    ip_address: ClientIpDep,
    request_id: RequestIdDep,
) -> AdminDoctorUserOut:
    """Create a new doctor account requiring a password change on first login."""
    return UserService(db).create_doctor(
        admin=admin,
        payload=payload,
        ip_address=ip_address,
        request_id=request_id,
    )


@router.patch(
    "/{user_id}",
    responses={404: {"model": ErrorResponse, "description": "Doctor account not found"}},
)
def update_doctor(
    user_id: uuid.UUID,
    payload: AdminUpdateDoctorRequest,
    admin: AdminUserDep,
    db: DbSessionDep,
    ip_address: ClientIpDep,
    request_id: RequestIdDep,
) -> AdminDoctorUserOut:
    """Update a doctor's display_name or active status (locking revokes all sessions)."""
    return UserService(db).update_doctor(
        admin=admin,
        target_user_id=user_id,
        payload=payload,
        ip_address=ip_address,
        request_id=request_id,
    )


@router.post(
    "/{user_id}/reset-password",
    responses={404: {"model": ErrorResponse, "description": "Doctor account not found"}},
)
def reset_doctor_password(
    user_id: uuid.UUID,
    response: Response,
    admin: AdminUserDep,
    db: DbSessionDep,
    ip_address: ClientIpDep,
    request_id: RequestIdDep,
) -> TemporaryPasswordResponse:
    """Generate a one-time temporary password for a doctor and revoke all active sessions."""
    response.headers["Cache-Control"] = "no-store"
    return UserService(db).reset_doctor_password(
        admin=admin,
        target_user_id=user_id,
        ip_address=ip_address,
        request_id=request_id,
    )
