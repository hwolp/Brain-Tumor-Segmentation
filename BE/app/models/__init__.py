"""ORM models registry."""

from app.models.audit_event import AuditEvent
from app.models.base import POSTGRES_NAMING_CONVENTION, Base
from app.models.case import Case, CaseCreateIdempotencyKey
from app.models.inference_job import (
    InferenceJob,
    JobAttempt,
    JobCreateIdempotencyKey,
    ModelVersion,
    WorkerInstance,
)
from app.models.mask_version import MaskSaveIdempotencyKey, MaskVersion
from app.models.patient import Patient
from app.models.session import LoginAttempt, RefreshToken, Session
from app.models.stored_file import StoredFile
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.models.volume import Volume

__all__ = [
    "AuditEvent",
    "Base",
    "Case",
    "CaseCreateIdempotencyKey",
    "InferenceJob",
    "JobAttempt",
    "JobCreateIdempotencyKey",
    "LoginAttempt",
    "MaskSaveIdempotencyKey",
    "MaskVersion",
    "ModelVersion",
    "POSTGRES_NAMING_CONVENTION",
    "Patient",
    "RefreshToken",
    "Session",
    "StoredFile",
    "SystemSetting",
    "User",
    "Volume",
    "WorkerInstance",
]
