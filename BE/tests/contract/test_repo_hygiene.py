"""Contract tests for dependency pinning, .gitignore rules, and secret/artifact hygiene."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_BE_DIR = _REPO_ROOT / "BE"
_FE_DIR = _REPO_ROOT / "FE"

_PINNED_REQ_RE = re.compile(
    r"^[A-Za-z0-9._-]+(?:\[[A-Za-z0-9,._-]+\])?==[A-Za-z0-9.+_-]+$"
)
_EXACT_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[A-Za-z0-9.+-]+)?$")
_PRIVATE_KEY_MARKERS = (
    "-----BEGIN " + "PRIVATE KEY-----",
    "-----BEGIN " + "RSA PRIVATE KEY-----",
    "-----BEGIN " + "EC PRIVATE KEY-----",
    "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
)


def test_backend_and_worker_dependencies_are_strictly_pinned() -> None:
    req_path = _BE_DIR / "requirements.txt"
    assert req_path.is_file()
    req_lines = [
        line.strip()
        for line in req_path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert len(req_lines) > 0
    for line in req_lines:
        assert _PINNED_REQ_RE.fullmatch(
            line
        ), f"Unpinned requirement in BE/requirements.txt: {line}"

    manifest_path = _BE_DIR / "worker" / "manifest.json"
    assert manifest_path.is_file()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    deps = manifest.get("dependencies")
    assert isinstance(deps, dict) and len(deps) > 0
    for pkg, version in deps.items():
        assert isinstance(version, str) and _EXACT_SEMVER_RE.fullmatch(
            version
        ), f"Worker dependency {pkg!r} is not strictly pinned: {version!r}"

    lock_path = _FE_DIR / "package-lock.json"
    assert lock_path.is_file(), "FE/package-lock.json must exist for reproducible FE builds"
    lock_json = json.loads(lock_path.read_text(encoding="utf-8"))
    assert int(lock_json.get("lockfileVersion", 0)) >= 2
    assert isinstance(lock_json.get("packages"), dict) and len(lock_json["packages"]) > 0


def test_env_examples_contain_only_safe_placeholders() -> None:
    be_env = _BE_DIR / ".env.example"
    fe_env = _FE_DIR / ".env.example"
    assert be_env.is_file()
    assert fe_env.is_file()

    be_text = be_env.read_text(encoding="utf-8")
    fe_text = fe_env.read_text(encoding="utf-8")
    for text in (be_text, fe_text):
        for marker in _PRIVATE_KEY_MARKERS:
            assert marker not in text
        assert "bts_local_dev_pw" not in text

    kv: dict[str, str] = {}
    for raw in be_text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        kv[k.strip()] = v.strip()

    assert "REPLACE_WITH_" in kv.get("DATABASE_URL", "")
    assert "REPLACE_WITH_" in kv.get("WORKER_TOKEN", "")
    git_bin = shutil.which("git")
    has_git = git_bin is not None and (_REPO_ROOT / ".git").exists()
    secrets_dir = (_BE_DIR / "secrets").resolve(strict=False)

    for key_var in ("JWT_PRIVATE_KEY_PATH", "JWT_PUBLIC_KEY_PATH"):
        rel = kv.get(key_var, "")
        assert rel
        key_path = (_BE_DIR / rel).resolve(strict=False)
        assert key_path.is_relative_to(
            secrets_dir
        ), f"{key_var} must point inside gitignored BE/secrets/: {rel}"
        if key_path.exists() and has_git:
            repo_rel = key_path.relative_to(_REPO_ROOT.resolve()).as_posix()
            ignored = subprocess.run(
                [git_bin, "check-ignore", "-q", "--", repo_rel],
                cwd=_REPO_ROOT,
                check=False,
            )
            assert ignored.returncode == 0, f"{key_var} target is not gitignored: {repo_rel}"
            tracked = subprocess.run(
                [git_bin, "ls-files", "-z", "--", repo_rel],
                cwd=_REPO_ROOT,
                capture_output=True,
                check=True,
            )
            assert tracked.stdout == b"", f"{key_var} target is tracked in git: {repo_rel}"


def test_gitignore_covers_secrets_storage_checkpoints_and_medical_data() -> None:
    gitignore_path = _REPO_ROOT / ".gitignore"
    assert gitignore_path.is_file()
    rules = {
        line.strip()
        for line in gitignore_path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }
    required_rules = {
        ".env",
        ".env.*",
        "!.env.example",
        "!BE/.env.example",
        "!FE/.env.example",
        "*.pem",
        "*.key",
        "secrets/",
        "BE/secrets/",
        "storage/",
        "backups/",
        "*.pt",
        "*.nii",
        "*.nii.gz",
        "FE/playwright-report/",
        "FE/test-results/",
        "FE/blob-report/",
        "!BE/tests/fixtures/**",
        "!FE/src/test/fixtures/**",
    }
    missing = required_rules - rules
    assert not missing, f"Missing required .gitignore entries: {sorted(missing)}"


def test_git_tracks_zero_sensitive_or_heavy_files() -> None:
    git_bin = shutil.which("git")
    if git_bin is None or not (_REPO_ROOT / ".git").exists():
        pytest.skip("Git CLI or .git directory unavailable")

    proc = subprocess.run(
        [git_bin, "ls-files", "-z"],
        cwd=_REPO_ROOT,
        capture_output=True,
        check=True,
    )
    tracked = [item for item in proc.stdout.decode("utf-8").split("\x00") if item]

    ls_sensitive = subprocess.run(
        [git_bin, "ls-files", "-z", "--", "BE/secrets", "secrets", "BE/.env", "FE/.env"],
        cwd=_REPO_ROOT,
        capture_output=True,
        check=True,
    )
    assert ls_sensitive.stdout == b"", "Sensitive files or secrets directory tracked in git"

    must_ignore = (
        "BE/.env",
        "FE/.env",
        "BE/secrets/jwt-private.pem",
        "secrets/root.pem",
        "storage/sample.bin",
        "backups/dump.tar",
        "weights.pt",
        "scan.nii.gz",
    )
    for sample in must_ignore:
        res = subprocess.run(
            [git_bin, "check-ignore", "-q", "--", sample],
            cwd=_REPO_ROOT,
            check=False,
        )
        assert res.returncode == 0, f"Expected .gitignore to ignore {sample}"

    must_not_ignore = (
        ".env.example",
        "BE/.env.example",
        "FE/.env.example",
        "BE/tests/fixtures/sample.nii.gz",
        "FE/src/test/fixtures/sample.nii.gz",
    )
    for sample in must_not_ignore:
        res = subprocess.run(
            [git_bin, "check-ignore", "-q", "--", sample],
            cwd=_REPO_ROOT,
            check=False,
        )
        assert res.returncode == 1, f"Expected .gitignore negation to keep {sample}"

    forbidden_prefixes = (
        "storage/",
        "secrets/",
        "BE/secrets/",
        "backups/",
        "FE/playwright-report/",
        "FE/test-results/",
        "FE/blob-report/",
        "BE/.venv/",
        ".venv/",
        "FE/node_modules/",
    )
    forbidden_suffixes = (".pem", ".key", ".pt", ".pth", ".onnx", ".ckpt")
    allowed_nifti_prefixes = ("BE/tests/fixtures/", "FE/src/test/fixtures/")

    for raw_path in tracked:
        norm = raw_path.replace("\\", "/")
        name = Path(norm).name
        assert not (
            name == ".env" or (name.startswith(".env.") and not norm.endswith(".env.example"))
        ), f"Sensitive .env file tracked in git: {norm}"
        assert not norm.startswith(forbidden_prefixes), f"Forbidden path tracked in git: {norm}"
        assert not norm.lower().endswith(
            forbidden_suffixes
        ), f"Secret or model checkpoint file tracked in git: {norm}"
        if norm.lower().endswith((".nii", ".nii.gz")):
            assert norm.startswith(
                allowed_nifti_prefixes
            ), f"Heavy medical NIfTI file tracked outside test fixtures: {norm}"

        full_path = _REPO_ROOT / norm
        text_exts = (".env.example", ".py", ".ts", ".tsx", ".json", ".yml", ".yaml")
        if full_path.is_file() and full_path.stat().st_size <= 512 * 1024:
            if norm.lower().endswith(text_exts):
                text_body = full_path.read_text(encoding="utf-8", errors="ignore")
                for marker in _PRIVATE_KEY_MARKERS:
                    assert marker not in text_body, f"Private key marker found in {norm}"
