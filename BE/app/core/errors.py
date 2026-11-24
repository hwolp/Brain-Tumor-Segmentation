"""Standardized error envelope, application exceptions, and FastAPI handlers."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import request_id_var, resolve_request_id
from app.schemas.error import ErrorBody, ErrorDetailItem, ErrorResponse

__all__ = [
    "AppError",
    "ErrorBody",
    "ErrorDetailItem",
    "ErrorResponse",
    "register_exception_handlers",
]

logger = logging.getLogger(__name__)

_STATUS_CODE_MAP: dict[int, tuple[str, str]] = {
    400: ("bad_request", "Yêu cầu không hợp lệ."),
    401: ("unauthorized", "Chưa xác thực hoặc phiên đăng nhập không hợp lệ."),
    403: ("forbidden", "Bạn không có quyền thực hiện thao tác này."),
    404: ("not_found", "Không tìm thấy tài nguyên yêu cầu."),
    405: ("method_not_allowed", "Phương thức HTTP không được hỗ trợ."),
    409: ("conflict", "Xung đột trạng thái tài nguyên."),
    413: ("payload_too_large", "Dữ liệu tải lên vượt quá giới hạn cho phép."),
    422: ("validation_error", "Dữ liệu yêu cầu không hợp lệ."),
    429: ("rate_limited", "Quá nhiều yêu cầu, vui lòng thử lại sau."),
    503: ("service_unavailable", "Hệ thống tạm thời chưa sẵn sàng phục vụ."),
}


class AppError(Exception):
    """Domain or infrastructure error mapped to the standard HTTP error envelope."""

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: list[dict[str, Any]] | dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def _extract_request_id(request: Request) -> str:
    state_id = getattr(request.state, "request_id", None)
    if isinstance(state_id, str) and state_id:
        return state_id
    ctx_id = request_id_var.get()
    if ctx_id and ctx_id != "-":
        return ctx_id
    return resolve_request_id(request.headers.get("x-request-id"))


def _error_json_response(
    *,
    status_code: int,
    code: str,
    message: str,
    request_id: str,
    details: list[dict[str, Any]] | dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    content = {
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "request_id": request_id,
        }
    }
    return JSONResponse(status_code=status_code, content=content, headers=headers)


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    """Serialize AppError into the standard error envelope."""
    return _error_json_response(
        status_code=exc.status_code,
        code=exc.code,
        message=exc.message,
        details=exc.details,
        request_id=_extract_request_id(request),
        headers=exc.headers,
    )


async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """Normalize Starlette/FastAPI HTTPException into the standard error envelope."""
    status_code = exc.status_code
    code, default_message = _STATUS_CODE_MAP.get(
        status_code,
        (f"http_{status_code}", "Yêu cầu không thể xử lý."),
    )
    if status_code >= 500:
        message = "Đã xảy ra lỗi hệ thống nội bộ. Vui lòng thử lại sau."
        code = "internal_error" if status_code == 500 else code
    elif isinstance(exc.detail, str) and exc.detail and exc.detail not in {
        "Not Found",
        "Method Not Allowed",
    }:
        message = exc.detail
    else:
        message = default_message

    return _error_json_response(
        status_code=status_code,
        code=code,
        message=message,
        details=None,
        request_id=_extract_request_id(request),
        headers=dict(exc.headers) if exc.headers else None,
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Return HTTP 422 validation_error with safe field/reason/type items only."""
    safe_details: list[dict[str, Any]] = []
    for err in exc.errors():
        loc = err.get("loc", ())
        field_name = ".".join(str(part) for part in loc) if loc else "request"
        safe_details.append(
            {
                "field": field_name,
                "reason": str(err.get("msg", "Invalid value")),
                "type": str(err.get("type", "validation_error")),
            }
        )

    return _error_json_response(
        status_code=422,
        code="validation_error",
        message="Dữ liệu yêu cầu không hợp lệ.",
        details=safe_details,
        request_id=_extract_request_id(request),
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch unexpected server exceptions without leaking internals or stack traces."""
    req_id = _extract_request_id(request)
    token = request_id_var.set(req_id)
    try:
        if isinstance(exc, SQLAlchemyError):
            logger.error(
                "Unhandled database exception",
                extra={
                    "error_class": type(exc).__name__,
                    "sqlstate": getattr(getattr(exc, "orig", None), "sqlstate", None),
                },
            )
        else:
            logger.exception(
                "Unhandled server exception",
                extra={"error_class": type(exc).__name__},
            )
    finally:
        request_id_var.reset(token)

    headers: dict[str, str] = {"X-Request-ID": req_id}
    path = request.url.path
    if path == "/api/v1" or path.startswith("/api/v1/"):
        headers["Cache-Control"] = "no-store"

    return _error_json_response(
        status_code=500,
        code="internal_error",
        message="Đã xảy ra lỗi hệ thống nội bộ. Vui lòng thử lại sau.",
        details=None,
        request_id=req_id,
        headers=headers,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Register all standard exception handlers on the FastAPI app."""
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
