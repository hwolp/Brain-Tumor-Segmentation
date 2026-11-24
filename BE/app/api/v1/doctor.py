"""Doctor-scoped profile endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.dependencies import DoctorUserDep, require_doctor
from app.schemas.auth import UserOut
from app.schemas.error import ErrorResponse

router = APIRouter(
    prefix="/api/v1/doctor",
    tags=["doctor"],
    dependencies=[Depends(require_doctor)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Forbidden or password change required"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)


@router.get("/profile")
def get_doctor_profile(doctor: DoctorUserDep) -> UserOut:
    """Return profile metadata for the currently authenticated active doctor."""
    return UserOut.model_validate(doctor)
