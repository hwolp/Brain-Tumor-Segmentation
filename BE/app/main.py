"""FastAPI application factory, request-context middleware, and lifespan management."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.v1 import (
    admin_operations_router,
    admin_users_router,
    auth_router,
    cases_router,
    doctor_router,
    files_router,
    health_router,
    internal_worker_router,
    jobs_router,
    jwks_router,
    mask_versions_router,
    patients_router,
)
from app.core.config import Settings
from app.core.db import create_db_engine, create_session_factory
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging, request_id_var, resolve_request_id
from app.core.security import load_jwt_key_material
from app.core.storage import LocalStorageAdapter
from app.services.inference_job_service import reap_expired_attempts
from app.services.stored_file_service import StoredFileService

logger = logging.getLogger(__name__)
_MULTIPART_UPLOAD_PATH_RE = re.compile(
    r"^/api/v1/(?:cases/[^/]+/(?:volumes|mask-versions)|internal/jobs/[^/]+/complete)$"
)


class _IngressPayloadTooLarge(BaseException):
    """Internal signal raised when streamed multipart ingress exceeds max_bytes."""


class MultipartIngressLimitMiddleware:
    """Reject oversized multipart upload requests before FastAPI spools request.form()."""

    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def _send_413(self, scope: Scope, send: Send) -> None:
        state = scope.get("state", {})
        request_id = state.get("request_id") or _resolve_header_request_id(scope.get("headers", []))
        body = json.dumps(
            {
                "error": {
                    "code": "payload_too_large",
                    "message": "Dung lượng yêu cầu tải lên vượt quá giới hạn cho phép.",
                    "details": None,
                    "request_id": request_id,
                }
            },
            ensure_ascii=False,
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or not _MULTIPART_UPLOAD_PATH_RE.fullmatch(scope.get("path", ""))
        ):
            await self.app(scope, receive, send)
            return

        for name, value in scope.get("headers", []):
            if name.lower() == b"content-length":
                try:
                    content_length = int(value.decode("latin-1").strip())
                except ValueError:
                    content_length = -1
                if content_length > self.max_bytes:
                    await self._send_413(scope, send)
                    return

        bytes_received = 0
        response_started = False
        limit_exceeded = False

        async def guarded_receive() -> Message:
            nonlocal bytes_received, limit_exceeded
            message = await receive()
            if message["type"] == "http.request":
                bytes_received += len(message.get("body", b""))
                if bytes_received > self.max_bytes:
                    limit_exceeded = True
                    raise _IngressPayloadTooLarge()
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if limit_exceeded:
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, guarded_receive, tracking_send)
        except _IngressPayloadTooLarge:
            pass
        if limit_exceeded and not response_started:
            await self._send_413(scope, send)


def _resolve_header_request_id(headers: list[tuple[bytes, bytes]]) -> str:
    for name, value in headers:
        if name.lower() == b"x-request-id":
            return resolve_request_id(value.decode("latin-1"))
    return resolve_request_id(None)


class RequestContextMiddleware:
    """Pure ASGI middleware attaching X-Request-ID and Cache-Control headers."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _resolve_header_request_id(scope.get("headers", []))
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        path: str = scope.get("path", "")
        is_api_v1 = path == "/api/v1" or path.startswith("/api/v1/")

        token = request_id_var.set(request_id)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
                if is_api_v1:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            request_id_var.reset(token)


async def _orphan_cleanup_loop(application: FastAPI) -> None:
    settings: Settings = application.state.settings
    session_factory = getattr(application.state, "session_factory", None)
    storage: LocalStorageAdapter = application.state.storage
    interval = settings.ORPHAN_CLEANUP_INTERVAL_SECONDS
    while True:
        await asyncio.sleep(interval)
        if session_factory is None:
            continue
        try:
            with session_factory() as db:
                StoredFileService(db, storage).run_orphan_cleanup(
                    max_age_seconds=settings.STAGING_ORPHAN_MAX_AGE_SECONDS,
                    login_attempt_max_age_seconds=settings.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
                )
                db.commit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Periodic orphan cleanup failed",
                extra={"error_class": type(exc).__name__},
            )


async def _job_reaper_loop(application: FastAPI) -> None:
    session_factory = getattr(application.state, "session_factory", None)
    if session_factory is None:
        return
    while True:
        await asyncio.sleep(15)
        try:
            with session_factory() as db:
                reap_expired_attempts(db)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Inference lease reaper failed",
                extra={"error_class": type(exc).__name__},
            )


@asynccontextmanager
async def _lifespan(application: FastAPI) -> AsyncIterator[None]:
    cleanup_task: asyncio.Task[None] | None = None
    reaper_task: asyncio.Task[None] | None = None
    if getattr(application.state, "session_factory", None) is not None:
        cleanup_task = asyncio.create_task(_orphan_cleanup_loop(application))
        reaper_task = asyncio.create_task(_job_reaper_loop(application))
    try:
        yield
    finally:
        if cleanup_task is not None:
            cleanup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cleanup_task
        if reaper_task is not None:
            reaper_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper_task
        engine = getattr(application.state, "db_engine", None)
        if engine is not None:
            engine.dispose()


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construct and configure the FastAPI application."""
    resolved_settings = settings if settings is not None else Settings()
    configure_logging(resolved_settings.LOG_LEVEL)

    db_engine = create_db_engine(resolved_settings)
    session_factory = create_session_factory(db_engine) if db_engine is not None else None
    storage = LocalStorageAdapter(resolved_settings.effective_storage_root)
    jwt_keys = load_jwt_key_material(resolved_settings)

    application = FastAPI(
        title="Brain Tumor Segmentation API",
        version="0.1.0",
        lifespan=_lifespan,
    )
    application.state.settings = resolved_settings
    application.state.db_engine = db_engine
    application.state.session_factory = session_factory
    application.state.storage = storage
    application.state.jwt_keys = jwt_keys

    register_exception_handlers(application)
    application.add_middleware(
        MultipartIngressLimitMiddleware,
        max_bytes=(
            resolved_settings.MAX_UPLOAD_BYTES + resolved_settings.MAX_MULTIPART_OVERHEAD_BYTES
        ),
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.effective_allowed_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Retry-After"],
    )
    application.add_middleware(RequestContextMiddleware)

    application.include_router(health_router)
    application.include_router(jwks_router)
    application.include_router(auth_router)
    application.include_router(admin_users_router)
    application.include_router(doctor_router)
    application.include_router(patients_router)
    application.include_router(cases_router)
    application.include_router(mask_versions_router)
    application.include_router(files_router)
    application.include_router(admin_operations_router)
    application.include_router(jobs_router)
    application.include_router(internal_worker_router)

    return application


app = create_app()
