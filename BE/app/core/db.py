"""PostgreSQL engine/session factory and readiness check."""

from __future__ import annotations

import logging
from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings

logger = logging.getLogger(__name__)


def create_db_engine(settings: Settings) -> Engine | None:
    """Create a pooled SQLAlchemy engine when DATABASE_URL is configured."""
    if not settings.DATABASE_URL:
        return None

    return create_engine(
        settings.DATABASE_URL,
        pool_size=settings.DB_POOL_SIZE,
        max_overflow=settings.DB_MAX_OVERFLOW,
        pool_pre_ping=True,
        pool_recycle=1800,
        hide_parameters=True,
        connect_args={"connect_timeout": 3},
    )


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Create a SQLAlchemy sessionmaker bound to the given engine."""
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def check_database_health(engine: Engine | None) -> bool:
    """Execute a lightweight SELECT 1 check against PostgreSQL."""
    if engine is None:
        return False
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except SQLAlchemyError as exc:
        logger.warning(
            "Database readiness check failed",
            extra={"error_class": type(exc).__name__},
        )
        return False
    except Exception as exc:  # pragma: no cover - defensive fallback
        logger.warning(
            "Database readiness check errored",
            extra={"error_class": type(exc).__name__},
        )
        return False


def get_db_session(request: Request) -> Iterator[Session]:
    """Yield a scoped SQLAlchemy session from application state."""
    session_factory: sessionmaker[Session] | None = getattr(
        request.app.state, "session_factory", None
    )
    if session_factory is None:
        raise RuntimeError("Database session factory is not configured")
    with session_factory() as session:
        yield session
