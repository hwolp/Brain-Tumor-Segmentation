"""Repository helpers for AdminBenchmarkRun records."""

from __future__ import annotations

import uuid

from sqlalchemy import String, func, or_, select
from sqlalchemy.orm import Session

from app.models.admin_benchmark import AdminBenchmarkRun
from app.models.user import User


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class AdminBenchmarkRepository:
    """Data access layer for isolated Admin AI benchmark evaluation runs."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, benchmark_id: uuid.UUID) -> AdminBenchmarkRun | None:
        return self.db.get(AdminBenchmarkRun, benchmark_id)

    def get_by_id_for_update(self, benchmark_id: uuid.UUID) -> AdminBenchmarkRun | None:
        return self.db.scalar(
            select(AdminBenchmarkRun)
            .where(AdminBenchmarkRun.id == benchmark_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    def get_detail_row(
        self, benchmark_id: uuid.UUID
    ) -> tuple[AdminBenchmarkRun, str] | None:
        return self.db.execute(
            select(AdminBenchmarkRun, User.username)
            .join(User, User.id == AdminBenchmarkRun.created_by)
            .where(AdminBenchmarkRun.id == benchmark_id)
        ).first()

    def list_paginated(
        self,
        *,
        q: str | None,
        state: str | None,
        worker_id: str | None,
        page: int,
        page_size: int,
    ) -> tuple[list[AdminBenchmarkRun], int]:
        conditions = []
        if state:
            conditions.append(AdminBenchmarkRun.state == state)
        if worker_id:
            conditions.append(AdminBenchmarkRun.target_worker_id == worker_id)
        search = (q or "").strip()
        if search:
            pattern = f"%{_escape_like(search)}%"
            conditions.append(
                or_(
                    AdminBenchmarkRun.id.cast(String).ilike(pattern, escape="\\"),
                    AdminBenchmarkRun.title.ilike(pattern, escape="\\"),
                    AdminBenchmarkRun.target_worker_id.ilike(pattern, escape="\\"),
                )
            )

        total = int(
            self.db.scalar(
                select(func.count()).select_from(AdminBenchmarkRun).where(*conditions)
            )
            or 0
        )
        rows = list(
            self.db.scalars(
                select(AdminBenchmarkRun)
                .where(*conditions)
                .order_by(AdminBenchmarkRun.created_at.desc(), AdminBenchmarkRun.id.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
        )
        return rows, total

    def claim_next_for_worker(self, worker_id: str) -> AdminBenchmarkRun | None:
        return self.db.scalar(
            select(AdminBenchmarkRun)
            .where(
                AdminBenchmarkRun.target_worker_id == worker_id,
                AdminBenchmarkRun.state == "queued",
            )
            .order_by(AdminBenchmarkRun.created_at, AdminBenchmarkRun.id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
            .limit(1)
        )
