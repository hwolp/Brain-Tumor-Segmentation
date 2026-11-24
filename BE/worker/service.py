"""Single-process inference worker with persistent verified model and lease heartbeats."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import signal
import tempfile
import threading
from pathlib import Path
from typing import Any

import httpx
import torch

from worker.adapter import (
    InputGeometryError,
    ManifestValidationError,
    load_model_from_manifest,
    run_case,
)
from worker.model import CheckpointVerificationError

logger = logging.getLogger("bts.worker")
_INTERNAL_PREFIX = "/api/v1/internal"


def resolve_worker_device(raw_device: str) -> str:
    """Resolve WORKER_DEVICE ('auto', 'cpu', 'cuda', 'cuda:0', ...) cleanly."""
    cleaned = raw_device.strip()
    if not cleaned:
        return "cpu"
    if cleaned.lower() == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return cleaned


class WorkerClient:
    def __init__(self, *, base_url: str, token: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/") + _INTERNAL_PREFIX
        self.client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={"X-Worker-Token": token},
        )

    def post(self, path: str, payload: dict[str, Any] | None = None) -> Any:
        response = self.client.post(f"{self.base_url}{path}", json=payload)
        response.raise_for_status()
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    def download(
        self,
        *,
        file_id: str,
        job_id: str,
        attempt_id: str,
        worker_id: str,
        lease_token: str,
        expected_sha256: str,
        target: Path,
    ) -> None:
        digest = hashlib.sha256()
        with self.client.stream(
            "GET",
            f"{self.base_url}/files/{file_id}/content",
            headers={
                "X-Job-ID": job_id,
                "X-Attempt-ID": attempt_id,
                "X-Worker-ID": worker_id,
                "X-Lease-Token": lease_token,
            },
        ) as streamed:
            streamed.raise_for_status()
            with target.open("wb") as output:
                for chunk in streamed.iter_bytes(65536):
                    output.write(chunk)
                    digest.update(chunk)
        if not hmac.compare_digest(expected_sha256, digest.hexdigest()):
            target.unlink(missing_ok=True)
            raise ValueError("downloaded input fingerprint mismatch")

    def complete(
        self, *, job_id: str, attempt_id: str, worker_id: str, lease_token: str, result: Any
    ) -> None:
        for attempt_idx in range(2):
            try:
                with (
                    result.mask_path.open("rb") as mask,
                    result.coverage_path.open("rb") as coverage,
                    result.metadata_path.open("rb") as metadata,
                ):
                    response = self.client.post(
                        f"{self.base_url}/jobs/{job_id}/complete",
                        headers={
                            "X-Job-ID": job_id,
                            "X-Attempt-ID": attempt_id,
                            "X-Worker-ID": worker_id,
                            "X-Lease-Token": lease_token,
                        },
                        files={
                            "mask": ("mask.nii.gz", mask, "application/gzip"),
                            "coverage": ("coverage.json", coverage, "application/json"),
                            "metadata": ("metadata.json", metadata, "application/json"),
                        },
                        timeout=180.0,
                    )
                    response.raise_for_status()
                    return
            except httpx.TransportError:
                if attempt_idx == 0:
                    continue
                raise

    def close(self) -> None:
        self.client.close()


class InferenceWorker:
    def __init__(
        self,
        *,
        api_base_url: str,
        token: str,
        worker_id: str,
        manifest_path: Path,
        checkpoint_path: Path | None,
        device: str = "cpu",
        poll_seconds: float = 5.0,
    ) -> None:
        if not token:
            raise ValueError("WORKER_TOKEN is required")
        self.worker_id = worker_id
        self.manifest_path = manifest_path
        self.checkpoint_path = checkpoint_path
        self.device = device
        normalized_dev = device.strip().lower()
        self.device_type = (
            "GPU" if (normalized_dev == "gpu" or normalized_dev.startswith("cuda")) else "CPU"
        )
        self.poll_seconds = poll_seconds
        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.model_version_id = f"{self.manifest['model_id']}:{self.manifest['version']}"
        self.model = load_model_from_manifest(
            manifest_path,
            device=device,
            checkpoint_path=checkpoint_path,
        )
        self.api = WorkerClient(base_url=api_base_url, token=token)
        self._active: dict[str, Any] | None = None
        self._progress_lock = threading.Lock()
        self._shutdown_event = threading.Event()

    def request_stop(self) -> None:
        """Signal the worker loop to exit cleanly after finishing any active job."""
        self._shutdown_event.set()

    def _heartbeat_loop(self, stop_event: threading.Event) -> None:
        while not stop_event.wait(15):
            try:
                self.api.post(
                    "/worker/heartbeat",
                    {
                        "worker_id": self.worker_id,
                        "device_type": self.device_type,
                        "model_version_id": self.model_version_id,
                    },
                )
            except Exception as exc:  # worker logs must not include MRI file names or payloads
                logger.warning("Worker heartbeat failed (%s)", type(exc).__name__)

            if stop_event.is_set():
                break

            with self._progress_lock:
                active = (
                    {
                        "job_id": self._active["job_id"],
                        "attempt_id": self._active["attempt_id"],
                        "lease_token": self._active["lease_token"],
                        "progress": dict(self._active["progress"]),
                    }
                    if self._active is not None
                    else None
                )
            if active is not None:
                try:
                    self.api.post(
                        f"/jobs/{active['job_id']}/heartbeat",
                        {
                            "worker_id": self.worker_id,
                            "attempt_id": active["attempt_id"],
                            "lease_token": active["lease_token"],
                            **active["progress"],
                        },
                    )
                except Exception as exc:
                    logger.warning("Job heartbeat failed (%s)", type(exc).__name__)

    def _claim(self) -> dict[str, Any] | None:
        return self.api.post(
            "/worker/claim",
            {
                "worker_id": self.worker_id,
                "device_type": self.device_type,
                "model_version_id": self.model_version_id,
            },
        )

    def _run_claim(self, claim: dict[str, Any]) -> None:
        job_id = claim["job_id"]
        attempt_id = claim["attempt_id"]
        lease_token = claim["lease_token"]
        with self._progress_lock:
            self._active = {
                "job_id": job_id,
                "attempt_id": attempt_id,
                "lease_token": lease_token,
                "progress": {
                    "stage": "loading",
                    "completed_slices": 0,
                    "total_slices": int(self.manifest["input_profile"]["shape"][2]),
                },
            }
        stop_event = threading.Event()
        heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(stop_event,),
            daemon=True,
        )
        heartbeat_thread.start()
        download_completed = False
        try:
            with tempfile.TemporaryDirectory(prefix="bts-worker-") as tmp:
                tmp_path = Path(tmp)
                input_paths: dict[str, Path] = {}
                for item in claim["files"]:
                    target = tmp_path / f"{item['modality']}.{item['extension']}"
                    self.api.download(
                        file_id=item["file_id"],
                        job_id=job_id,
                        attempt_id=attempt_id,
                        worker_id=self.worker_id,
                        lease_token=lease_token,
                        expected_sha256=item["sha256"],
                        target=target,
                    )
                    input_paths[item["modality"]] = target
                download_completed = True

                def progress(stage: str, completed: int, total: int) -> None:
                    reported_stage = "saving" if stage == "done" else stage
                    safe_total = max(1, int(total))
                    safe_completed = max(0, min(int(completed), safe_total))
                    with self._progress_lock:
                        if self._active is not None:
                            self._active["progress"] = {
                                "stage": reported_stage,
                                "completed_slices": safe_completed,
                                "total_slices": safe_total,
                            }

                result = run_case(
                    input_paths["flair"],
                    input_paths["t1ce"],
                    self.manifest_path,
                    tmp_path / "outputs",
                    progress_callback=progress,
                    device=self.device,
                    checkpoint_path=self.checkpoint_path,
                    preloaded_model=self.model,
                )
                self.api.complete(
                    job_id=job_id,
                    attempt_id=attempt_id,
                    worker_id=self.worker_id,
                    lease_token=lease_token,
                    result=result,
                )
            logger.info("Job completed")
        except Exception as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 409:
                resp_code: str | None = None
                try:
                    body = exc.response.json()
                    if isinstance(body, dict):
                        err_obj = body.get("error")
                        if isinstance(err_obj, dict) and isinstance(err_obj.get("code"), str):
                            resp_code = err_obj["code"]
                except Exception:
                    resp_code = None
                if resp_code in {"stale_attempt", "complete_digest_conflict"}:
                    logger.warning("Job attempt superseded (HTTP 409 %s)", resp_code)
                    return

            if isinstance(exc, InputGeometryError):
                error_code = "input_geometry_mismatch"
            elif isinstance(exc, ManifestValidationError):
                error_code = "model_unavailable"
            elif isinstance(exc, CheckpointVerificationError):
                error_code = "model_error"
            elif isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 422:
                error_code = "result_invalid"
            elif isinstance(exc, (httpx.TransportError, httpx.HTTPStatusError, OSError)) or (
                not download_completed and isinstance(exc, ValueError)
            ):
                error_code = "worker_error"
            else:
                error_code = "inference_error"
            try:
                self.api.post(
                    f"/jobs/{job_id}/fail",
                    {
                        "worker_id": self.worker_id,
                        "attempt_id": attempt_id,
                        "lease_token": lease_token,
                        "error_code": error_code,
                    },
                )
            except Exception as fail_exc:
                logger.warning("Could not report job failure (%s)", type(fail_exc).__name__)
            logger.warning("Job failed (%s)", error_code)
        finally:
            with self._progress_lock:
                self._active = None
            stop_event.set()
            heartbeat_thread.join(timeout=2)

    def run_forever(self) -> None:
        logger.info("Worker started (%s)", self.device_type)
        while not self._shutdown_event.is_set():
            try:
                self.api.post(
                    "/worker/heartbeat",
                    {
                        "worker_id": self.worker_id,
                        "device_type": self.device_type,
                        "model_version_id": self.model_version_id,
                    },
                )
                claim = self._claim()
                if claim is not None:
                    self._run_claim(claim)
                else:
                    self._shutdown_event.wait(self.poll_seconds)
            except KeyboardInterrupt:
                self.request_stop()
                break
            except Exception as exc:
                logger.warning("Worker poll failed (%s)", type(exc).__name__)
                self._shutdown_event.wait(self.poll_seconds)


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    manifest = Path(os.getenv("MODEL_MANIFEST_PATH", "worker/manifest.json"))
    checkpoint_raw = os.getenv("MODEL_CHECKPOINT_PATH")
    device = resolve_worker_device(os.getenv("WORKER_DEVICE", "cpu"))
    try:
        poll_seconds = max(1.0, float(os.getenv("WORKER_POLL_INTERVAL_SECONDS", "5")))
    except ValueError:
        poll_seconds = 5.0

    worker = InferenceWorker(
        api_base_url=os.getenv("WORKER_API_BASE_URL", "http://127.0.0.1:8000"),
        token=os.getenv("WORKER_TOKEN", ""),
        worker_id=os.getenv("WORKER_ID", "local-worker-1"),
        manifest_path=manifest,
        checkpoint_path=Path(checkpoint_raw) if checkpoint_raw else None,
        device=device,
        poll_seconds=poll_seconds,
    )

    def _handle_shutdown(signum: int, _frame: Any) -> None:
        logger.info("Received signal %s; shutting down worker gracefully...", signum)
        worker.request_stop()

    for sig_name in ("SIGTERM", "SIGINT"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            signal.signal(sig, _handle_shutdown)

    try:
        worker.run_forever()
    finally:
        worker.api.close()


if __name__ == "__main__":
    main()
