"""API integration tests for health endpoints, error envelopes, and response headers."""

from __future__ import annotations

import uuid
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from app.core.config import Settings
from app.main import create_app


def _assert_error_envelope(payload: dict, expected_code: str, expected_request_id: str) -> None:
    assert set(payload.keys()) == {"error"}
    error = payload["error"]
    assert set(error.keys()) == {"code", "message", "details", "request_id"}
    assert error["code"] == expected_code
    assert isinstance(error["message"], str) and error["message"]
    assert error["request_id"] == expected_request_id


def test_health_live_returns_ok_with_headers(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/health/live")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store"
    request_id = response.headers.get("X-Request-ID")
    assert request_id is not None
    assert str(uuid.UUID(request_id)) == request_id.lower()

    data = response.json()
    assert data == {
        "status": "ok",
        "service": "brain-tumor-api",
        "environment": "test",
    }


def test_request_id_is_forwarded_when_valid_uuid_and_replaced_when_invalid(
    api_client: TestClient,
) -> None:
    valid_id = str(uuid.uuid4())
    res_valid = api_client.get("/api/v1/health/live", headers={"X-Request-ID": valid_id})
    assert res_valid.status_code == 200
    assert res_valid.headers.get("X-Request-ID") == valid_id

    res_invalid = api_client.get(
        "/api/v1/health/live",
        headers={"X-Request-ID": "invalid-request-id-!@#"},
    )
    assert res_invalid.status_code == 200
    generated_id = res_invalid.headers.get("X-Request-ID")
    assert generated_id is not None
    assert generated_id != "invalid-request-id-!@#"
    assert str(uuid.UUID(generated_id)) == generated_id.lower()


def test_health_ready_returns_200_when_db_and_storage_ok(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/health/ready")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store"
    assert response.json() == {
        "status": "ready",
        "checks": {
            "database": "ok",
            "storage": "ok",
        },
    }


def test_health_ready_returns_503_when_database_unreachable(
    isolated_storage_root: Path,
) -> None:
    bad_db_url = "postgresql+psycopg://bts_user:super_secret_pw@127.0.0.1:59999/bts_dev"
    settings = Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL=bad_db_url,
        STORAGE_ROOT=isolated_storage_root,
    )
    app = create_app(settings=settings)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/v1/health/ready")

    assert response.status_code == 503
    assert response.headers.get("Cache-Control") == "no-store"
    req_id = response.headers.get("X-Request-ID")
    assert req_id is not None

    body = response.json()
    _assert_error_envelope(body, "service_unavailable", req_id)
    assert body["error"]["details"] == {"database": "error", "storage": "ok"}
    assert "super_secret_pw" not in response.text
    assert "postgresql://" not in response.text


def test_health_ready_returns_503_when_storage_unwritable(
    ensure_postgres_ready: str,
    tmp_path: Path,
) -> None:
    not_a_dir = tmp_path / "regular_file_not_dir"
    not_a_dir.write_text("blocking-directory-creation", encoding="utf-8")

    settings = Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL=ensure_postgres_ready,
        STORAGE_ROOT=not_a_dir,
    )
    app = create_app(settings=settings)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/v1/health/ready")

    assert response.status_code == 503
    assert response.headers.get("Cache-Control") == "no-store"
    req_id = response.headers.get("X-Request-ID")
    assert req_id is not None

    body = response.json()
    _assert_error_envelope(body, "service_unavailable", req_id)
    assert body["error"]["details"] == {"database": "ok", "storage": "error"}
    assert str(not_a_dir) not in response.text


def test_unknown_route_returns_404_error_envelope(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.headers.get("Cache-Control") == "no-store"
    req_id = response.headers.get("X-Request-ID")
    assert req_id is not None

    body = response.json()
    _assert_error_envelope(body, "not_found", req_id)


def test_validation_error_returns_422_envelope_without_sensitive_input(
    test_settings: Settings,
) -> None:
    app = create_app(settings=test_settings)

    class _SecretInput(BaseModel):
        password: str = Field(min_length=12)

    @app.post("/api/v1/_test/validate")
    def _validate_endpoint(payload: _SecretInput) -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/api/v1/_test/validate", json={"password": "short_pw_secret"})

    assert response.status_code == 422
    assert response.headers.get("Cache-Control") == "no-store"
    req_id = response.headers.get("X-Request-ID")
    assert req_id is not None

    body = response.json()
    _assert_error_envelope(body, "validation_error", req_id)
    details = body["error"]["details"]
    assert isinstance(details, list) and len(details) >= 1
    for item in details:
        assert set(item.keys()) == {"field", "reason", "type"}
    assert "short_pw_secret" not in response.text


def test_unhandled_exception_returns_500_envelope_without_traceback(
    test_settings: Settings,
) -> None:
    app = create_app(settings=test_settings)

    @app.get("/api/v1/_test/boom")
    def _boom_endpoint() -> dict[str, bool]:
        raise RuntimeError(
            "sensitive failure C:\\secret\\path postgresql://user:pass@localhost/db"
        )

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/v1/_test/boom")

    assert response.status_code == 500
    assert response.headers.get("Cache-Control") == "no-store"
    req_id = response.headers.get("X-Request-ID")
    assert req_id is not None

    body = response.json()
    _assert_error_envelope(body, "internal_error", req_id)
    assert body["error"]["details"] is None
    assert "RuntimeError" not in response.text
    assert "Traceback" not in response.text
    assert "C:\\secret" not in response.text
    assert "postgresql://" not in response.text
