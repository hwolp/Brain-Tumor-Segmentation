"""Session, RefreshToken, and LoginAttempt repository."""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.orm import Session as OrmSession

from app.models.session import LoginAttempt, RefreshToken, Session
from app.models.user import User

_LOGIN_IP_ADVISORY_LOCK_NS = 700010


class SessionRepository:
    """Data access and PostgreSQL row-locking operations for auth sessions."""

    def __init__(self, db: OrmSession) -> None:
        self.db = db

    def create_session_with_refresh_token(
        self,
        *,
        user_id: uuid.UUID,
        expires_at: datetime,
        token_hash: str,
        now: datetime | None = None,
    ) -> tuple[Session, RefreshToken]:
        ts = now if now is not None else datetime.now(UTC)
        session_obj = Session(
            user_id=user_id,
            family_id=uuid.uuid4(),
            created_at=ts,
            expires_at=expires_at,
        )
        self.db.add(session_obj)
        self.db.flush()

        refresh_obj = RefreshToken(
            session_id=session_obj.id,
            token_hash=token_hash,
            created_at=ts,
            expires_at=expires_at,
        )
        self.db.add(refresh_obj)
        self.db.flush()
        return session_obj, refresh_obj

    def get_session_and_user(
        self,
        *,
        session_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> tuple[Session, User] | None:
        row = self.db.execute(
            select(Session, User)
            .join(User, Session.user_id == User.id)
            .where(Session.id == session_id, User.id == user_id)
        ).first()
        if row is None:
            return None
        return row[0], row[1]

    def get_refresh_token_for_update(self, token_hash: str) -> RefreshToken | None:
        return self.db.scalar(
            select(RefreshToken)
            .where(RefreshToken.token_hash == token_hash)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    def get_refresh_token_by_hash(self, token_hash: str) -> RefreshToken | None:
        return self.db.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        )

    def get_session_by_id(self, session_id: uuid.UUID) -> Session | None:
        return self.db.scalar(select(Session).where(Session.id == session_id))

    def get_session_for_update(self, session_id: uuid.UUID) -> Session | None:
        return self.db.scalar(
            select(Session)
            .where(Session.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    def create_successor_refresh_token(
        self,
        *,
        session_id: uuid.UUID,
        token_hash: str,
        expires_at: datetime,
        now: datetime,
    ) -> RefreshToken:
        successor = RefreshToken(
            session_id=session_id,
            token_hash=token_hash,
            created_at=now,
            expires_at=expires_at,
        )
        self.db.add(successor)
        self.db.flush()
        return successor

    def revoke_session_family(
        self,
        session_id: uuid.UUID,
        *,
        reason: str,
        now: datetime,
        overwrite_reason: bool = False,
    ) -> bool:
        locked_id = self.db.scalar(
            select(Session.id)
            .where(Session.id == session_id)
            .order_by(Session.id.asc())
            .with_for_update()
        )
        if locked_id is None:
            return False

        session_obj = self.db.scalar(
            select(Session)
            .where(Session.id == locked_id)
            .execution_options(populate_existing=True)
        )
        if session_obj is None:
            return False

        was_open = session_obj.revoked_at is None
        if was_open:
            session_obj.revoked_at = now
            session_obj.revoke_reason = reason
        elif overwrite_reason:
            session_obj.revoke_reason = reason

        self.db.flush()
        self.db.execute(
            update(RefreshToken)
            .where(
                RefreshToken.session_id == session_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=now)
        )
        self.db.flush()
        return was_open

    def revoke_all_user_sessions(
        self,
        user_id: uuid.UUID,
        *,
        reason: str,
        now: datetime,
    ) -> int:
        open_session_ids = list(
            self.db.scalars(
                select(Session.id)
                .where(
                    Session.user_id == user_id,
                    Session.revoked_at.is_(None),
                )
                .order_by(Session.id.asc())
                .with_for_update()
            ).all()
        )
        if not open_session_ids:
            return 0

        self.db.execute(
            update(Session)
            .where(Session.id.in_(open_session_ids), Session.revoked_at.is_(None))
            .values(revoked_at=now, revoke_reason=reason)
            .execution_options(synchronize_session="fetch")
        )
        self.db.execute(
            update(RefreshToken)
            .where(
                RefreshToken.session_id.in_(open_session_ids),
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=now)
            .execution_options(synchronize_session=False)
        )
        self.db.flush()
        return len(open_session_ids)

    def acquire_login_ip_lock(self, ip_address: str) -> None:
        """Serialize concurrent login rate-limit checks per client IP within transaction."""
        digest = hashlib.sha256(ip_address.encode("utf-8")).digest()
        ip_key = int.from_bytes(digest[:4], byteorder="big", signed=True)
        self.db.execute(
            text("SELECT pg_advisory_xact_lock(:ns, :ip_key)"),
            {"ns": _LOGIN_IP_ADVISORY_LOCK_NS, "ip_key": ip_key},
        )

    def delete_expired_login_attempts(self, *, before: datetime) -> int:
        """Delete LoginAttempt rows older than the sliding rate-limit window."""
        result = self.db.execute(
            delete(LoginAttempt).where(LoginAttempt.attempted_at < before)
        )
        self.db.flush()
        return int(result.rowcount or 0)

    def _count_recent_failures(
        self,
        *,
        predicates: tuple[object, ...],
        threshold: int,
    ) -> tuple[int, datetime | None]:
        count = int(
            self.db.scalar(
                select(func.count()).select_from(LoginAttempt).where(*predicates)  # type: ignore[arg-type]
            )
            or 0
        )
        if count < threshold:
            return count, None

        release_ts = self.db.scalar(
            select(LoginAttempt.attempted_at)
            .where(*predicates)  # type: ignore[arg-type]
            .order_by(LoginAttempt.attempted_at.asc())
            .offset(count - threshold)
            .limit(1)
        )
        return count, release_ts

    def count_recent_failures_user_ip(
        self,
        *,
        username: str,
        ip_address: str,
        since: datetime,
        threshold: int,
    ) -> tuple[int, datetime | None]:
        return self._count_recent_failures(
            predicates=(
                LoginAttempt.username == username,
                LoginAttempt.ip_address == ip_address,
                LoginAttempt.attempted_at >= since,
            ),
            threshold=threshold,
        )

    def count_recent_failures_ip(
        self,
        *,
        ip_address: str,
        since: datetime,
        threshold: int,
    ) -> tuple[int, datetime | None]:
        return self._count_recent_failures(
            predicates=(
                LoginAttempt.ip_address == ip_address,
                LoginAttempt.attempted_at >= since,
            ),
            threshold=threshold,
        )

    def record_login_attempt(
        self,
        *,
        username: str,
        ip_address: str,
        attempted_at: datetime,
    ) -> LoginAttempt:
        attempt = LoginAttempt(
            username=username,
            ip_address=ip_address,
            attempted_at=attempted_at,
        )
        self.db.add(attempt)
        self.db.flush()
        return attempt
