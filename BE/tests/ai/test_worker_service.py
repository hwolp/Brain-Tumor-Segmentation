"""Unit tests for Cloud-ready AI Worker service helpers, device selection, and graceful stop."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_BE_DIR = Path(__file__).resolve().parents[2]
if str(_BE_DIR) not in sys.path:
    sys.path.insert(0, str(_BE_DIR))

from worker import service as worker_service  # noqa: E402


def _write_minimal_manifest(tmp_path: Path) -> Path:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "model_id": "tda-seg-unet",
                "version": "cce-dice-ep136",
                "input_profile": {"shape": [240, 240, 155]},
            }
        ),
        encoding="utf-8",
    )
    return manifest


def test_resolve_worker_device_auto_and_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker_service.torch.cuda, "is_available", lambda: True)
    assert worker_service.resolve_worker_device("auto") == "cuda"
    assert worker_service.resolve_worker_device(" AUTO ") == "cuda"

    monkeypatch.setattr(worker_service.torch.cuda, "is_available", lambda: False)
    assert worker_service.resolve_worker_device("auto") == "cpu"
    assert worker_service.resolve_worker_device("") == "cpu"

    assert worker_service.resolve_worker_device("cuda:0") == "cuda:0"
    assert worker_service.resolve_worker_device("cpu") == "cpu"


@pytest.mark.parametrize(
    ("device_arg", "expected_type"),
    [
        ("cpu", "CPU"),
        ("cuda", "GPU"),
        ("cuda:0", "GPU"),
        ("gpu", "GPU"),
    ],
)
def test_inference_worker_device_type_mapping(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    device_arg: str,
    expected_type: str,
) -> None:
    manifest = _write_minimal_manifest(tmp_path)
    monkeypatch.setattr(worker_service, "load_model_from_manifest", lambda *a, **kw: object())

    worker = worker_service.InferenceWorker(
        api_base_url="http://127.0.0.1:8000",
        token="test-token",
        worker_id="cloud-test-1",
        manifest_path=manifest,
        checkpoint_path=None,
        device=device_arg,
    )
    try:
        assert worker.device_type == expected_type
    finally:
        worker.api.close()


def test_inference_worker_request_stop_exits_run_forever_promptly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = _write_minimal_manifest(tmp_path)
    monkeypatch.setattr(worker_service, "load_model_from_manifest", lambda *a, **kw: object())

    worker = worker_service.InferenceWorker(
        api_base_url="http://127.0.0.1:8000",
        token="test-token",
        worker_id="cloud-test-2",
        manifest_path=manifest,
        checkpoint_path=None,
        device="cpu",
        poll_seconds=60.0,
    )

    calls: list[str] = []

    def fake_post(path: str, payload: dict[str, object] | None = None) -> None:
        calls.append(path)
        if path == "/worker/claim":
            worker.request_stop()
        return None

    worker.api.post = MagicMock(side_effect=fake_post)  # type: ignore[method-assign]
    try:
        worker.run_forever()
    finally:
        worker.api.close()

    assert calls == ["/worker/heartbeat", "/worker/claim"]
