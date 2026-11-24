"""Structured JSON logging and sensitive-field redaction filter."""

from __future__ import annotations

import json
import logging
import re
import uuid
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
_UUID_DASHED_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def resolve_request_id(raw_value: str | None) -> str:
    """Validate incoming dashed UUID request ID or generate a fresh UUID4."""
    if raw_value is not None:
        candidate = raw_value.strip()
        if _UUID_DASHED_RE.fullmatch(candidate):
            return str(uuid.UUID(candidate))
    return str(uuid.uuid4())

_STANDARD_RECORD_ATTRS = frozenset(
    {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "message",
        "asctime",
        "request_id",
        "taskName",
    }
)

_SENSITIVE_KEY_TOKENS = (
    "authorization",
    "cookie",
    "set-cookie",
    "bts_refresh",
    "password",
    "token",
    "secret",
    "private_key",
    "database_url",
    "dsn",
)

_DB_URL_RE = re.compile(
    r"postgres(?:ql)?(?:\+[a-zA-Z0-9_.-]+)?://[^\s'\",;)}\]]+",
    re.IGNORECASE,
)
_AUTH_HEADER_RE = re.compile(
    r"(?i)(authorization\s*[:=]\s*['\"]?)(?:bearer\s+|basic\s+)?[^\s,;'\")}\]]+"
)
_BEARER_RE = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*")
_COOKIE_HEADER_RE = re.compile(
    r"(?i)\b(set-cookie|cookie)\s*[:=]\s*[^\s,;\"'\r\n]+(?:\s*;\s*[a-z0-9_.-]+\s*=\s*[^\s;,\"'\r\n]+)*"
)
_JSON_DQ_SECRET_RE = re.compile(
    r'(?i)"([a-z0-9_.-]*(?:password|token|secret|cookie|authorization|bts_refresh)[a-z0-9_.-]*)"\s*:\s*"[^"]*"'
)
_JSON_SQ_SECRET_RE = re.compile(
    r"(?i)'([a-z0-9_.-]*(?:password|token|secret|cookie|authorization|bts_refresh)[a-z0-9_.-]*)'\s*:\s*'[^']*'"
)
_KV_SECRET_RE = re.compile(
    r"(?i)\b([a-z0-9_.-]*(?:password|token|secret|bts_refresh)[a-z0-9_.-]*)\s*[:=]\s*"
    r"(?:\"(?:\\.|[^\"\r\n])*\"|'(?:\\.|[^'\r\n])*'|['\"]?[^\s,;'\")}\]]+['\"]?)"
)


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(token in lowered for token in _SENSITIVE_KEY_TOKENS)


def scrub_text(text: str) -> str:
    """Redact credentials, tokens, cookies, and PostgreSQL URLs from text."""
    scrubbed = _DB_URL_RE.sub("[REDACTED_DATABASE_URL]", text)
    scrubbed = _JSON_DQ_SECRET_RE.sub(r'"\1": "[REDACTED]"', scrubbed)
    scrubbed = _JSON_SQ_SECRET_RE.sub(r"'\1': '[REDACTED]'", scrubbed)
    scrubbed = _AUTH_HEADER_RE.sub(r"\1[REDACTED]", scrubbed)
    scrubbed = _BEARER_RE.sub(r"\1 [REDACTED]", scrubbed)
    scrubbed = _COOKIE_HEADER_RE.sub(r"\1: [REDACTED]", scrubbed)
    scrubbed = _KV_SECRET_RE.sub(r"\1=[REDACTED]", scrubbed)
    return scrubbed


def scrub_value(value: Any) -> Any:
    """Recursively redact sensitive strings inside dicts, lists, and tuples."""
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, dict):
        return {
            k: ("[REDACTED]" if isinstance(k, str) and _is_sensitive_key(k) else scrub_value(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [scrub_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(scrub_value(item) for item in value)
    return value


class RedactingFilter(logging.Filter):
    """Logging filter that injects request_id and scrubs sensitive values."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not getattr(record, "request_id", None):
            record.request_id = request_id_var.get()

        try:
            rendered = record.getMessage()
        except Exception:
            rendered = str(record.msg)
        record.msg = scrub_text(rendered)
        record.args = None

        if record.exc_text:
            record.exc_text = scrub_text(record.exc_text)

        for key in list(record.__dict__.keys()):
            if key in _STANDARD_RECORD_ATTRS:
                continue
            if _is_sensitive_key(key):
                record.__dict__[key] = "[REDACTED]"
            else:
                record.__dict__[key] = scrub_value(record.__dict__[key])

        return True


class StructuredJsonFormatter(logging.Formatter):
    """Single-line JSON log formatter with UTC Z timestamps and redaction."""

    def formatException(self, ei: Any) -> str:
        return scrub_text(super().formatException(ei))

    def format(self, record: logging.LogRecord) -> str:
        timestamp = (
            datetime.fromtimestamp(record.created, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        payload: dict[str, Any] = {
            "timestamp": timestamp,
            "level": record.levelname,
            "logger": record.name,
            "request_id": getattr(record, "request_id", None) or request_id_var.get(),
            "message": scrub_text(record.getMessage()),
        }

        for key, value in record.__dict__.items():
            if key in _STANDARD_RECORD_ATTRS or key.startswith("_"):
                continue
            payload[key] = scrub_value(value)

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str, ensure_ascii=False)


def configure_logging(log_level: str = "INFO") -> None:
    """Configure root and application loggers with JSON output and redaction."""
    level = getattr(logging, log_level.upper(), logging.INFO)
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    for existing in list(root_logger.handlers):
        root_logger.removeHandler(existing)

    handler = logging.StreamHandler()
    handler.setLevel(level)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(StructuredJsonFormatter())
    root_logger.addHandler(handler)

    for uvicorn_logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(uvicorn_logger_name)
        uv_logger.handlers.clear()
        uv_logger.propagate = True
