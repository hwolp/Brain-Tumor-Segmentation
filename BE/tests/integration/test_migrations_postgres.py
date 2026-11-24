"""Integration tests for Alembic migrations and PostgreSQL persistence."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


def _assert_safe_test_database(database_url: str) -> None:
    db_name = make_url(database_url).database
    if not db_name or db_name in {"bts_dev", "postgres"} or db_name.endswith(("_dev", "_prod")):
        raise RuntimeError(
            f"Refusing to run destructive downgrade migration test against non-test DB '{db_name}'"
        )


def _alembic_config(database_url: str) -> Config:
    be_dir = Path(__file__).resolve().parents[2]
    cfg = Config(str(be_dir / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    return cfg


def test_downgrade_guard_rejects_dev_and_prod_databases() -> None:
    for unsafe_url in (
        "postgresql+psycopg://bts_user:pw@127.0.0.1:5432/bts_dev",
        "postgresql+psycopg://bts_user:pw@127.0.0.1:5432/clinic_dev",
        "postgresql+psycopg://bts_user:pw@127.0.0.1:5432/clinic_prod",
    ):
        with pytest.raises(RuntimeError, match="Refusing to run destructive downgrade"):
            _assert_safe_test_database(unsafe_url)


def test_alembic_upgrade_downgrade_upgrade_cycle(ensure_postgres_ready: str) -> None:
    _assert_safe_test_database(ensure_postgres_ready)
    cfg = _alembic_config(ensure_postgres_ready)
    engine = create_engine(ensure_postgres_ready)

    expected_tables = {
        "system_settings",
        "users",
        "sessions",
        "refresh_tokens",
        "login_attempts",
        "audit_events",
        "patients",
        "cases",
        "case_create_idempotency_keys",
        "stored_files",
        "volumes",
        "mask_versions",
        "mask_save_idempotency_keys",
        "model_versions",
        "inference_jobs",
        "job_attempts",
        "job_create_idempotency_keys",
        "worker_instances",
    }

    try:
        command.upgrade(cfg, "head")
        inspector = inspect(engine)
        table_names = set(inspector.get_table_names())
        assert expected_tables <= table_names

        # P1 table checks
        columns = {col["name"]: col for col in inspector.get_columns("system_settings")}
        assert set(columns.keys()) == {"key", "value_json", "updated_at", "updated_by"}
        assert "JSONB" in repr(columns["value_json"]["type"]).upper()
        assert getattr(columns["updated_at"]["type"], "timezone", False) is True
        pk = inspector.get_pk_constraint("system_settings")
        assert pk["constrained_columns"] == ["key"]
        assert pk["name"] == "pk_system_settings"

        # P2 table checks
        user_cols = {col["name"]: col for col in inspector.get_columns("users")}
        assert set(user_cols.keys()) == {
            "id",
            "username",
            "display_name",
            "password_hash",
            "role",
            "is_active",
            "must_change_password",
            "password_changed_at",
            "created_at",
            "updated_at",
        }
        assert {c["name"] for c in inspector.get_check_constraints("users")} >= {
            "ck_users_username_format",
            "ck_users_role",
        }
        assert {i["name"] for i in inspector.get_indexes("users")} >= {
            "ix_users_username_lower",
            "ix_users_role_created_at_id",
        }

        session_fks = inspector.get_foreign_keys("sessions")
        assert any(
            fk["referred_table"] == "users" and fk["options"].get("ondelete") == "RESTRICT"
            for fk in session_fks
        )
        assert "ix_sessions_user_id" in {i["name"] for i in inspector.get_indexes("sessions")}

        rt_fks = inspector.get_foreign_keys("refresh_tokens")
        assert any(
            fk["referred_table"] == "sessions" and fk["options"].get("ondelete") == "CASCADE"
            for fk in rt_fks
        )
        assert "ix_refresh_tokens_session_id" in {
            i["name"] for i in inspector.get_indexes("refresh_tokens")
        }

        attempt_indexes = {
            i["name"]: i["column_names"] for i in inspector.get_indexes("login_attempts")
        }
        assert attempt_indexes["ix_login_attempts_username_ip_attempted_at"] == [
            "username",
            "ip_address",
            "attempted_at",
        ]
        assert attempt_indexes["ix_login_attempts_ip_attempted_at"] == [
            "ip_address",
            "attempted_at",
        ]

        audit_cols = {col["name"]: col for col in inspector.get_columns("audit_events")}
        assert "JSONB" in repr(audit_cols["safe_diff"]["type"]).upper()
        assert {c["name"] for c in inspector.get_check_constraints("audit_events")} >= {
            "ck_audit_events_actor_type",
            "ck_audit_events_outcome",
        }

        # P3-P5 index & check constraint checks
        assert "ux_patients_owner_code_lower" in {
            i["name"] for i in inspector.get_indexes("patients")
        }
        assert "ux_volumes_case_modality_active" in {
            i["name"] for i in inspector.get_indexes("volumes")
        }
        assert "ck_mask_versions_source" in {
            c["name"] for c in inspector.get_check_constraints("mask_versions")
        }
        job_indexes = {i["name"]: i for i in inspector.get_indexes("inference_jobs")}
        assert "ux_inference_jobs_active_case" in job_indexes
        assert job_indexes["ux_inference_jobs_active_case"]["unique"] is True
        job_checks = {c["name"]: c for c in inspector.get_check_constraints("inference_jobs")}
        state_check_name = next(
            (
                name
                for name in (
                    "ck_inference_jobs_state",
                    "ck_inference_jobs_ck_inference_jobs_state",
                )
                if name in job_checks
            ),
            None,
        )
        assert state_check_name is not None
        assert "queued" in job_checks[state_check_name]["sqltext"]

        # Full downgrade to base removes all P1-P6 tables
        command.downgrade(cfg, "base")
        inspector = inspect(engine)
        assert expected_tables.isdisjoint(set(inspector.get_table_names()))

        # Re-upgrade to head restores all 18 tables, constraints, and P6 admin_settings seed
        command.upgrade(cfg, "head")
        inspector = inspect(engine)
        assert expected_tables <= set(inspector.get_table_names())
        assert "ck_mask_versions_source" in {
            c["name"] for c in inspector.get_check_constraints("mask_versions")
        }
        assert "ux_inference_jobs_active_case" in {
            i["name"] for i in inspector.get_indexes("inference_jobs")
        }
        with engine.connect() as conn:
            seeded = conn.execute(
                text("SELECT value_json FROM system_settings WHERE key = 'admin_settings'")
            ).scalar_one_or_none()
            assert isinstance(seeded, dict)
            assert seeded["accepting_jobs"] is True
            assert seeded["version"] == 1
    finally:
        engine.dispose()


def test_p2_postgres_check_constraints_reject_invalid_username_and_role(
    ensure_postgres_ready: str,
) -> None:
    from app.models import User

    cfg = _alembic_config(ensure_postgres_ready)
    command.upgrade(cfg, "head")
    engine = create_engine(ensure_postgres_ready)
    try:
        with Session(engine) as session:
            session.add(
                User(
                    username="UPPERCASE_BAD",
                    display_name="Bad User",
                    password_hash="hash",
                    role="doctor",
                )
            )
            with pytest.raises(IntegrityError):
                session.commit()
            session.rollback()

            session.add(
                User(
                    username="valid.user.1",
                    display_name="Bad Role",
                    password_hash="hash",
                    role="superadmin",
                )
            )
            with pytest.raises(IntegrityError):
                session.commit()
            session.rollback()
    finally:
        engine.dispose()


def test_system_settings_persists_across_engine_dispose(ensure_postgres_ready: str) -> None:
    from app.models import SystemSetting

    cfg = _alembic_config(ensure_postgres_ready)
    command.upgrade(cfg, "head")

    smoke_key = f"p1.smoke.{uuid.uuid4().hex}"
    actor_id = uuid.uuid4()
    expected_value = {"accepting_jobs": True, "max_upload_mib": 100}

    engine_one = create_engine(ensure_postgres_ready)
    try:
        with Session(engine_one) as session:
            session.add(
                SystemSetting(
                    key=smoke_key,
                    value_json=expected_value,
                    updated_by=actor_id,
                )
            )
            session.commit()
    finally:
        engine_one.dispose()

    engine_two = create_engine(ensure_postgres_ready)
    try:
        with Session(engine_two) as session:
            row = session.scalar(
                select(SystemSetting).where(SystemSetting.key == smoke_key)
            )
            assert row is not None
            assert row.value_json == expected_value
            assert row.updated_by == actor_id
            assert row.updated_at.tzinfo is not None

            session.delete(row)
            session.commit()
    finally:
        engine_two.dispose()
