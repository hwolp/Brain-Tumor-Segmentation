"""Unit tests for structured logging and sensitive-field redaction."""

from __future__ import annotations

import io
import json
import logging

from app.core.logging import RedactingFilter, StructuredJsonFormatter, request_id_var


def _make_captured_logger(name: str) -> tuple[logging.Logger, io.StringIO]:
    stream = io.StringIO()
    logger = logging.getLogger(name)
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.DEBUG)

    handler = logging.StreamHandler(stream)
    handler.setFormatter(StructuredJsonFormatter())
    handler.addFilter(RedactingFilter())
    logger.addHandler(handler)
    return logger, stream


def test_structured_log_includes_request_id_and_utc_timestamp() -> None:
    logger, stream = _make_captured_logger("test.logging.request_id")
    token = request_id_var.set("550e8400-e29b-41d4-a716-446655440000")
    try:
        logger.info("health check completed", extra={"status_code": 200})
    finally:
        request_id_var.reset(token)

    payload = json.loads(stream.getvalue().strip())
    assert payload["request_id"] == "550e8400-e29b-41d4-a716-446655440000"
    assert payload["timestamp"].endswith("Z")
    assert payload["level"] == "INFO"
    assert payload["message"] == "health check completed"
    assert payload["status_code"] == 200


def test_redacting_filter_scrubs_secrets_in_message_args_extra_and_exception() -> None:
    logger, stream = _make_captured_logger("test.logging.redaction")

    secret_values = [
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
        "refresh_cookie_secret_987",
        "my_super_password_123",
        "my_worker_token_456",
        "top_secret_value_789",
        "db_secret_pw_000",
    ]

    logger.warning(
        (
            "Headers Authorization: Bearer %s Cookie: session=abc; bts_refresh=%s "
            "password=%s token=%s secret=%s db=%s"
        ),
        secret_values[0],
        secret_values[1],
        secret_values[2],
        secret_values[3],
        secret_values[4],
        f"postgresql+psycopg://bts_user:{secret_values[5]}@127.0.0.1:5432/bts_dev",
        extra={
            "authorization": f"Bearer {secret_values[0]}",
            "cookie": f"bts_refresh={secret_values[1]}",
            "bts_refresh": secret_values[1],
            "password": secret_values[2],
            "token": secret_values[3],
            "secret": secret_values[4],
            "nested": {
                "dsn": f"postgresql://bts_user:{secret_values[5]}@localhost:5432/bts",
                "items": [{"worker_token": secret_values[3]}],
            },
        },
    )

    try:
        raise RuntimeError(f"failed connecting postgresql://admin:{secret_values[5]}@db/prod")
    except RuntimeError:
        logger.exception("db failure")

    output = stream.getvalue()
    for secret in secret_values:
        assert secret not in output
    assert "postgresql://" not in output
    assert "postgresql+psycopg://" not in output
    assert "[REDACTED]" in output


def test_redacting_filter_scrubs_quoted_secrets_containing_spaces() -> None:
    logger, stream = _make_captured_logger("test.logging.quoted_spaces")
    spaced_sq = "mat khau co cach 123"
    spaced_dq = "  secret phrase with spaces  "
    escaped_sq = r"pass\'with space"

    logger.error(
        "Login failed: password='%s' api_secret=\"%s\" temp_token='%s' user=dr.nguyen",
        spaced_sq,
        spaced_dq,
        escaped_sq,
    )

    output = stream.getvalue()
    assert spaced_sq not in output
    assert "khau co cach" not in output
    assert spaced_dq not in output
    assert "phrase with spaces" not in output
    assert "with space" not in output
    assert "user=dr.nguyen" in output
