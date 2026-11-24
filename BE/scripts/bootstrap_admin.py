"""Interactive CLI to create or reset the initial administrator account."""

from __future__ import annotations

import argparse
import getpass
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

_BE_DIR = Path(__file__).resolve().parents[1]
if str(_BE_DIR) not in sys.path:
    sys.path.insert(0, str(_BE_DIR))

from app.core.config import Settings  # noqa: E402
from app.core.db import create_db_engine, create_session_factory  # noqa: E402
from app.core.security import (  # noqa: E402
    generate_rsa_keypair,
    hash_password,
    validate_password_policy,
)
from app.repositories.audit_repo import AuditRepository  # noqa: E402
from app.repositories.session_repo import SessionRepository  # noqa: E402
from app.repositories.user_repo import UserRepository  # noqa: E402
from app.schemas.admin_user import (  # noqa: E402
    normalize_and_validate_display_name,
    normalize_and_validate_username,
)


def _load_settings() -> Settings:
    settings = Settings()
    if settings.DATABASE_URL is None:
        env_path = _BE_DIR / ".env"
        if env_path.is_file():
            settings = Settings(_env_file=env_path)
    return settings


def _prompt_password() -> str:
    password = getpass.getpass("Admin password (12-128 chars): ")
    confirm = getpass.getpass("Confirm admin password: ")
    if password != confirm:
        raise ValueError("Mật khẩu xác nhận không khớp.")
    return validate_password_policy(password)


def run_bootstrap_admin(
    *,
    username: str | None,
    display_name: str | None,
    reset: bool,
    init_jwt_keys: bool,
    force: bool = False,
    settings: Settings | None = None,
) -> int:
    """Interactively bootstrap or reset an admin user without CLI password arguments."""
    resolved = settings if settings is not None else _load_settings()

    if init_jwt_keys:
        priv_path = resolved.JWT_PRIVATE_KEY_PATH or (_BE_DIR / "secrets" / "jwt-private.pem")
        pub_path = resolved.JWT_PUBLIC_KEY_PATH or (_BE_DIR / "secrets" / "jwt-public.pem")
        if (priv_path.exists() or pub_path.exists()) and not force:
            print(
                f"JWT key files already exist at {priv_path} / {pub_path}. "
                "Pass --force to overwrite existing keys.",
                file=sys.stderr,
            )
            return 1
        generate_rsa_keypair(priv_path, pub_path, key_size=2048)
        print(f"Generated RSA-2048 keypair at {priv_path} and {pub_path}")
        if username is None and not reset:
            return 0

    if not resolved.DATABASE_URL:
        print("DATABASE_URL must be configured to run bootstrap_admin.", file=sys.stderr)
        return 1

    raw_username = username if username is not None else input("Admin username: ")
    try:
        normalized_username = normalize_and_validate_username(raw_username)
    except ValueError as exc:
        print(f"Invalid username: {exc}", file=sys.stderr)
        return 1

    engine = create_db_engine(resolved)
    if engine is None:
        print("Failed to initialize database engine.", file=sys.stderr)
        return 1

    SessionLocal = create_session_factory(engine)
    try:
        with SessionLocal() as db:
            users = UserRepository(db)
            sessions = SessionRepository(db)
            audits = AuditRepository(db)
            existing = users.get_by_username(normalized_username)

            if reset:
                if existing is None:
                    print(f"Admin user '{normalized_username}' does not exist.", file=sys.stderr)
                    return 1
                if existing.role != "admin":
                    print(
                        f"User '{normalized_username}' is not an admin account.",
                        file=sys.stderr,
                    )
                    return 1

                try:
                    new_password = _prompt_password()
                except ValueError as exc:
                    print(f"Invalid password: {exc}", file=sys.stderr)
                    return 1

                now = datetime.now(UTC)
                existing.password_hash = hash_password(new_password)
                existing.is_active = True
                existing.must_change_password = False
                existing.password_changed_at = now
                existing.updated_at = now
                if display_name is not None:
                    try:
                        existing.display_name = normalize_and_validate_display_name(display_name)
                    except ValueError as exc:
                        print(f"Invalid display name: {exc}", file=sys.stderr)
                        return 1

                revoked_count = sessions.revoke_all_user_sessions(
                    existing.id,
                    reason="admin_cli_reset",
                    now=now,
                )
                audits.record_event(
                    actor_type="system",
                    actor_id=None,
                    action="system.reset_admin",
                    resource_type="user",
                    resource_id=str(existing.id),
                    outcome="success",
                    request_id=str(uuid.uuid4()),
                    ip_address=None,
                    safe_diff={
                        "username": existing.username,
                        "role": "admin",
                        "sessions_revoked": revoked_count,
                    },
                    now=now,
                )
                db.commit()
                print(f"Reset password for admin '{existing.username}' successfully.")
                return 0

            if existing is not None:
                print(
                    f"User '{normalized_username}' already exists. Use --reset to reset password.",
                    file=sys.stderr,
                )
                return 1

            raw_display = (
                display_name if display_name is not None else input("Admin display name: ")
            )
            try:
                clean_display = normalize_and_validate_display_name(raw_display)
                password = _prompt_password()
            except ValueError as exc:
                print(f"Invalid input: {exc}", file=sys.stderr)
                return 1

            now = datetime.now(UTC)
            admin_user = users.create(
                username=normalized_username,
                display_name=clean_display,
                password_hash=hash_password(password),
                role="admin",
                is_active=True,
                must_change_password=False,
                password_changed_at=now,
                now=now,
            )
            audits.record_event(
                actor_type="system",
                actor_id=None,
                action="system.bootstrap_admin",
                resource_type="user",
                resource_id=str(admin_user.id),
                outcome="success",
                request_id=str(uuid.uuid4()),
                ip_address=None,
                safe_diff={"username": admin_user.username, "role": "admin"},
                now=now,
            )
            db.commit()
            print(f"Created admin user '{admin_user.username}' ({admin_user.id}).")
            return 0
    finally:
        engine.dispose()


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for interactive admin bootstrap/reset."""
    parser = argparse.ArgumentParser(
        description="Interactively create or reset an administrator account."
    )
    parser.add_argument(
        "--username",
        type=str,
        default=None,
        help="Administrator username (prompted interactively if omitted).",
    )
    parser.add_argument(
        "--display-name",
        type=str,
        default=None,
        help="Administrator display name (prompted interactively if omitted).",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Reset password of an existing administrator account (prompts via getpass).",
    )
    parser.add_argument(
        "--init-jwt-keys",
        action="store_true",
        help="Generate RSA-2048 JWT signing keys into configured JWT paths or ./secrets/.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow --init-jwt-keys to overwrite existing RSA key files.",
    )
    args = parser.parse_args(argv)
    return run_bootstrap_admin(
        username=args.username,
        display_name=args.display_name,
        reset=args.reset,
        init_jwt_keys=args.init_jwt_keys,
        force=args.force,
    )


if __name__ == "__main__":
    raise SystemExit(main())
