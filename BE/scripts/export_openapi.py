"""Deterministic OpenAPI schema exporter for Brain Tumor Segmentation API."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_BE_DIR = Path(__file__).resolve().parents[1]
if str(_BE_DIR) not in sys.path:
    sys.path.insert(0, str(_BE_DIR))

from fastapi import FastAPI  # noqa: E402

from app.core.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

DEFAULT_OPENAPI_PATH = _BE_DIR / "openapi" / "openapi.json"


def render_openapi_json(application: FastAPI) -> str:
    """Render deterministic, sorted OpenAPI JSON text."""
    schema = application.openapi()
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def export_openapi_schema(*, output_path: Path = DEFAULT_OPENAPI_PATH, check: bool = False) -> bool:
    """Export OpenAPI JSON to disk or verify an existing artifact matches."""
    application = create_app(settings=Settings(_env_file=None, APP_ENV="test"))
    rendered = render_openapi_json(application)

    if check:
        if not output_path.is_file():
            return False
        return output_path.read_text(encoding="utf-8") == rendered

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(rendered, encoding="utf-8")
    return True


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for exporting or checking OpenAPI JSON."""
    parser = argparse.ArgumentParser(description="Export FastAPI OpenAPI schema to JSON.")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OPENAPI_PATH,
        help="Destination path for openapi.json",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail with non-zero exit code if the file is missing or out of date.",
    )
    args = parser.parse_args(argv)

    ok = export_openapi_schema(output_path=args.output, check=args.check)
    if args.check and not ok:
        print(f"OpenAPI schema mismatch or missing: {args.output}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
