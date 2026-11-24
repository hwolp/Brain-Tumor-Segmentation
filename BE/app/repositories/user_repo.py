"""User repository."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.user import User


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class UserRepository:
    """Data access operations for User accounts."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return self.db.scalar(select(User).where(User.id == user_id))

    def get_by_username(self, username: str) -> User | None:
        normalized = username.strip().lower()
        return self.db.scalar(select(User).where(User.username == normalized))

    def create(
        self,
        *,
        username: str,
        display_name: str,
        password_hash: str,
        role: Literal["admin", "doctor"],
        is_active: bool = True,
        must_change_password: bool = True,
        password_changed_at: datetime | None = None,
        now: datetime | None = None,
    ) -> User:
        ts = now if now is not None else datetime.now(UTC)
        user = User(
            username=username.strip().lower(),
            display_name=display_name.strip(),
            password_hash=password_hash,
            role=role,
            is_active=is_active,
            must_change_password=must_change_password,
            password_changed_at=password_changed_at,
            created_at=ts,
            updated_at=ts,
        )
        self.db.add(user)
        self.db.flush()
        return user

    def list_doctors(
        self,
        *,
        q: str | None = None,
        is_active: bool | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[User], int]:
        conditions = [User.role == "doctor"]
        if is_active is not None:
            conditions.append(User.is_active.is_(is_active))
        if q is not None:
            trimmed = q.strip()
            if trimmed:
                pattern = f"%{_escape_like(trimmed)}%"
                conditions.append(
                    or_(
                        User.username.ilike(pattern, escape="\\"),
                        User.display_name.ilike(pattern, escape="\\"),
                    )
                )

        total = int(
            self.db.scalar(select(func.count()).select_from(User).where(*conditions)) or 0
        )
        stmt = (
            select(User)
            .where(*conditions)
            .order_by(User.created_at.desc(), User.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        items = list(self.db.scalars(stmt).all())
        return items, total
