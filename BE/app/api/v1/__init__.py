"""Version 1 API routers."""

from app.api.v1.admin_benchmarks import router as admin_benchmarks_router
from app.api.v1.admin_operations import router as admin_operations_router
from app.api.v1.admin_users import router as admin_users_router
from app.api.v1.auth import router as auth_router
from app.api.v1.cases import router as cases_router
from app.api.v1.doctor import router as doctor_router
from app.api.v1.files import router as files_router
from app.api.v1.health import router as health_router
from app.api.v1.internal_worker import router as internal_worker_router
from app.api.v1.jobs import router as jobs_router
from app.api.v1.jwks import router as jwks_router
from app.api.v1.mask_versions import router as mask_versions_router
from app.api.v1.patients import router as patients_router

__all__ = [
    "admin_benchmarks_router",
    "admin_users_router",
    "admin_operations_router",
    "auth_router",
    "cases_router",
    "doctor_router",
    "files_router",
    "health_router",
    "jwks_router",
    "internal_worker_router",
    "jobs_router",
    "mask_versions_router",
    "patients_router",
]
