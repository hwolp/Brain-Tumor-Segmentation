"""Contract tests verifying deterministic OpenAPI export and error schemas."""

from __future__ import annotations

import json
from pathlib import Path

from app.core.config import Settings
from app.main import create_app
from scripts.export_openapi import export_openapi_schema, render_openapi_json


def test_committed_openapi_matches_live_fastapi_schema() -> None:
    be_dir = Path(__file__).resolve().parents[2]
    openapi_path = be_dir / "openapi" / "openapi.json"
    assert openapi_path.is_file(), "BE/openapi/openapi.json must be exported and committed"

    committed_raw = openapi_path.read_text(encoding="utf-8")
    live_app = create_app(settings=Settings(_env_file=None, APP_ENV="test"))
    live_raw = render_openapi_json(live_app)

    assert json.loads(committed_raw) == json.loads(live_raw)
    assert committed_raw == live_raw


def test_openapi_documents_p1_and_p2_endpoints_and_schemas() -> None:
    be_dir = Path(__file__).resolve().parents[2]
    schema = json.loads((be_dir / "openapi" / "openapi.json").read_text(encoding="utf-8"))

    paths = schema["paths"]
    assert "/api/v1/health/live" in paths
    assert "/api/v1/health/ready" in paths
    assert "/.well-known/jwks.json" in paths
    assert "/api/v1/auth/login" in paths
    assert "/api/v1/auth/refresh" in paths
    assert "/api/v1/auth/logout" in paths
    assert "/api/v1/auth/me" in paths
    assert "/api/v1/auth/change-password" in paths
    assert "/api/v1/admin/users" in paths
    assert "/api/v1/admin/users/{user_id}" in paths
    assert "/api/v1/admin/users/{user_id}/reset-password" in paths
    assert "/api/v1/doctor/profile" in paths
    assert "/api/v1/patients" in paths
    assert "/api/v1/patients/{patient_id}" in paths
    assert "/api/v1/patients/{patient_id}/cases" in paths
    assert "/api/v1/cases" in paths
    assert "/api/v1/cases/{case_id}" in paths
    assert "/api/v1/cases/{case_id}/volumes" in paths
    assert "/api/v1/cases/{case_id}/volumes/{volume_id}" in paths
    assert "/api/v1/cases/{case_id}/mask-versions" in paths
    assert "/api/v1/mask-versions/{mask_version_id}" in paths
    assert "/api/v1/mask-versions/{mask_version_id}/export" in paths
    assert "/api/v1/mask-versions/{mask_version_id}/metadata" in paths
    assert "/api/v1/files/{file_id}/content" in paths
    # P5 doctor job & internal worker paths
    assert "/api/v1/system/availability" in paths
    assert "/api/v1/cases/{case_id}/jobs" in paths
    assert "/api/v1/jobs/{job_id}" in paths
    assert "/api/v1/jobs/{job_id}/cancel" in paths
    assert "/api/v1/internal/worker/heartbeat" in paths
    assert "/api/v1/internal/worker/claim" in paths
    assert "/api/v1/internal/files/{file_id}/content" in paths
    assert "/api/v1/internal/jobs/{job_id}/heartbeat" in paths
    assert "/api/v1/internal/jobs/{job_id}/complete" in paths
    assert "/api/v1/internal/jobs/{job_id}/fail" in paths
    # P6 admin operations paths
    assert "/api/v1/admin/overview" in paths
    assert "/api/v1/admin/jobs" in paths
    assert "/api/v1/admin/jobs/{job_id}" in paths
    assert "/api/v1/admin/jobs/{job_id}/retry" in paths
    assert "/api/v1/admin/workers" in paths
    assert "/api/v1/admin/models" in paths
    assert "/api/v1/admin/settings" in paths
    assert "/api/v1/admin/audit-events" in paths

    assert "200" in paths["/api/v1/health/live"]["get"]["responses"]
    ready_responses = paths["/api/v1/health/ready"]["get"]["responses"]
    assert "200" in ready_responses
    assert "503" in ready_responses
    assert "202" in paths["/api/v1/cases/{case_id}/jobs"]["post"]["responses"]
    assert "200" in paths["/api/v1/jobs/{job_id}/cancel"]["post"]["responses"]
    assert "204" in paths["/api/v1/internal/worker/heartbeat"]["post"]["responses"]
    assert "200" in paths["/api/v1/internal/worker/claim"]["post"]["responses"]
    assert "200" in paths["/api/v1/internal/jobs/{job_id}/complete"]["post"]["responses"]
    assert "202" in paths["/api/v1/admin/jobs/{job_id}/retry"]["post"]["responses"]

    components = schema["components"]["schemas"]
    assert {
        "ErrorResponse",
        "ErrorBody",
        "ErrorDetailItem",
        "AuthTokenResponse",
        "UserOut",
        "LoginRequest",
        "ChangePasswordRequest",
        "JwksResponse",
        "AdminDoctorUserOut",
        "AdminCreateDoctorRequest",
        "AdminUpdateDoctorRequest",
        "TemporaryPasswordResponse",
        "PaginatedResponse_AdminDoctorUserOut_",
        "PatientOut",
        "PatientCreateRequest",
        "PatientUpdateRequest",
        "CaseOut",
        "CaseCreateRequest",
        "CaseUpdateRequest",
        "VolumeOut",
        "MaskVersionOut",
        "MaskMetadataExportOut",
        "DeletionStatusOut",
        "PaginatedResponse_PatientOut_",
        "PaginatedResponse_CaseOut_",
        "PaginatedResponse_MaskVersionOut_",
        "InferenceJobOut",
        "JobCreateResponse",
        "SystemAvailabilityOut",
        "PaginatedResponse_InferenceJobOut_",
        "WorkerHeartbeatRequest",
        "WorkerClaimRequest",
        "WorkerClaimOut",
        "WorkerInputFile",
        "WorkerJobHeartbeatRequest",
        "WorkerCompleteResponse",
        "WorkerFailRequest",
        "WorkerActionResponse",
        "AdminOverviewOut",
        "AdminJobOut",
        "AdminJobAttemptOut",
        "AdminJobDetailOut",
        "AdminWorkerOut",
        "AdminModelOut",
        "AdminSettingsOut",
        "AdminSettingsUpdate",
        "AuditEventOut",
        "PaginatedResponse_AdminJobOut_",
        "PaginatedResponse_AuditEventOut_",
    } <= set(components.keys())

    # Verify non-PII & strict schema invariants on P6 admin schemas
    for schema_name in ("AdminJobOut", "AdminJobDetailOut", "AdminJobAttemptOut"):
        props = set(components[schema_name]["properties"].keys())
        assert props.isdisjoint({"full_name", "patient_code", "notes", "lease_token"})
    assert set(components["AdminModelOut"]["properties"].keys()).isdisjoint(
        {"manifest", "checkpoint_path"}
    )
    assert components["AdminSettingsUpdate"].get("additionalProperties") is False
    assert "updated_at" not in components["AdminSettingsUpdate"]["properties"]

    error_body_props = components["ErrorBody"]["properties"]
    assert {"code", "message", "details", "request_id"} <= set(error_body_props.keys())


def test_export_openapi_check_mode_passes(tmp_path: Path) -> None:
    be_dir = Path(__file__).resolve().parents[2]
    committed = be_dir / "openapi" / "openapi.json"
    assert export_openapi_schema(output_path=committed, check=True) is True

    out_copy = tmp_path / "openapi.json"
    assert export_openapi_schema(output_path=out_copy, check=False) is True
    assert out_copy.read_text(encoding="utf-8") == committed.read_text(encoding="utf-8")
