from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.nn import functional as F


class CheckpointVerificationError(RuntimeError):
    """Raised when a model checkpoint fails integrity or architecture verification."""


class DoubleConv(nn.Module):
    """Two 3x3 conv-BN-ReLU blocks followed by 2D spatial dropout."""

    def __init__(self, in_channels: int, out_channels: int, dropout: float) -> None:
        super().__init__()
        self.block = nn.Sequential(
            nn.Conv2d(in_channels, out_channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(out_channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(out_channels, out_channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(out_channels),
            nn.ReLU(inplace=True),
            nn.Dropout2d(dropout) if dropout > 0 else nn.Identity(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.block(x)


class Down(nn.Module):
    """Encoder stage: 2x2 max-pooling followed by DoubleConv."""

    def __init__(self, in_channels: int, out_channels: int, dropout: float) -> None:
        super().__init__()
        self.block = nn.Sequential(
            nn.MaxPool2d(2),
            DoubleConv(in_channels, out_channels, dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.block(x)


class Up(nn.Module):
    """Decoder stage: 2x2 transposed conv, skip alignment padding, and DoubleConv."""

    def __init__(self, in_channels: int, skip_channels: int, out_channels: int, dropout: float) -> None:
        super().__init__()
        self.up = nn.ConvTranspose2d(in_channels, in_channels // 2, kernel_size=2, stride=2)
        self.conv = DoubleConv(in_channels // 2 + skip_channels, out_channels, dropout)

    def forward(self, x: torch.Tensor, skip: torch.Tensor) -> torch.Tensor:
        x = self.up(x)
        dy = skip.size(2) - x.size(2)
        dx = skip.size(3) - x.size(3)
        if dy != 0 or dx != 0:
            x = F.pad(x, [dx // 2, dx - dx // 2, dy // 2, dy - dy // 2])
        return self.conv(torch.cat([skip, x], dim=1))


class TDASegUNet(nn.Module):
    """2D U-Net with 6 input channels: [FLAIR, T1ce, FLAIR-H0, FLAIR-H1, T1ce-H0, T1ce-H1].

    Layer names (`i`, `d1`..`d4`, `u1`..`u4`, `out`) match the verified Demo2 checkpoint.
    """

    def __init__(self, in_channels: int = 6, num_classes: int = 4, base: int = 16) -> None:
        super().__init__()
        if in_channels <= 0 or num_classes <= 0 or base <= 0:
            raise ValueError("in_channels, num_classes, and base must be positive integers")
        self.in_channels = in_channels
        self.num_classes = num_classes
        self.base = base
        self.checkpoint_sha256: str | None = None

        self.i = DoubleConv(in_channels, base, 0.2)
        self.d1 = Down(base, base * 2, 0.2)
        self.d2 = Down(base * 2, base * 4, 0.3)
        self.d3 = Down(base * 4, base * 8, 0.3)
        self.d4 = Down(base * 8, base * 16, 0.5)
        self.u1 = Up(base * 16, base * 8, base * 8, 0.5)
        self.u2 = Up(base * 8, base * 4, base * 4, 0.3)
        self.u3 = Up(base * 4, base * 2, base * 2, 0.2)
        self.u4 = Up(base * 2, base, base, 0.2)
        self.out = nn.Conv2d(base, num_classes, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1 = self.i(x)
        x2 = self.d1(x1)
        x3 = self.d2(x2)
        x4 = self.d3(x3)
        x5 = self.d4(x4)
        x = self.u1(x5, x4)
        x = self.u2(x, x3)
        x = self.u3(x, x2)
        x = self.u4(x, x1)
        return self.out(x)


def compute_sha256(path: str | Path, chunk_size: int = 1024 * 1024) -> str:
    """Compute the lowercase SHA-256 hex digest of a file using streaming reads."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"File not found for SHA-256 verification: {file_path}")
    digest = hashlib.sha256()
    with file_path.open("rb") as fh:
        while chunk := fh.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_device(device: str | torch.device) -> torch.device:
    """Resolve an explicit device without silent CUDA-to-CPU fallback."""
    resolved = torch.device(device)
    if resolved.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError(f"Requested device '{resolved}' is unavailable because CUDA is not available")
    return resolved


def _extract_state_dict(payload: Any) -> dict[str, torch.Tensor]:
    """Extract and validate a tensor state_dict from a loaded checkpoint payload."""
    if not isinstance(payload, Mapping) or not payload:
        raise CheckpointVerificationError("Checkpoint payload must be a non-empty mapping")

    if "model" in payload:
        candidate = payload["model"]
        if not isinstance(candidate, Mapping) or not candidate:
            raise CheckpointVerificationError("Checkpoint key 'model' must map to a non-empty state_dict")
    else:
        candidate = payload

    state_dict: dict[str, torch.Tensor] = {}
    for key, value in candidate.items():
        if not isinstance(key, str) or not isinstance(value, torch.Tensor):
            raise CheckpointVerificationError(
                "Checkpoint missing 'model' state_dict or contains non-tensor entries in state_dict"
            )
        state_dict[key] = value
    return state_dict


def load_verified_model(
    checkpoint_path: str | Path,
    expected_sha256: str,
    device: str | torch.device = "cpu",
    in_channels: int = 6,
    num_classes: int = 4,
    base: int = 16,
) -> TDASegUNet:
    """Verify checkpoint SHA-256 and load TDASegUNet strictly in eval mode."""
    ckpt_path = Path(checkpoint_path)
    if not ckpt_path.is_file():
        raise FileNotFoundError(f"Checkpoint file does not exist: {ckpt_path}")

    normalized_expected = str(expected_sha256).strip().lower()
    if len(normalized_expected) != 64 or any(ch not in "0123456789abcdef" for ch in normalized_expected):
        raise CheckpointVerificationError("expected_sha256 must be a valid 64-character hex SHA-256 string")

    actual_sha256 = compute_sha256(ckpt_path)
    if not hmac.compare_digest(actual_sha256, normalized_expected):
        raise CheckpointVerificationError(
            f"Checkpoint SHA-256 mismatch: expected {normalized_expected}, got {actual_sha256}"
        )

    resolved_device = _resolve_device(device)

    try:
        payload = torch.load(ckpt_path, map_location=resolved_device, weights_only=True)
    except Exception as exc:
        raise CheckpointVerificationError(f"Failed to load checkpoint safely: {exc}") from exc

    state_dict = _extract_state_dict(payload)
    model = TDASegUNet(in_channels=in_channels, num_classes=num_classes, base=base)
    expected_sd = model.state_dict()

    expected_keys = set(expected_sd.keys())
    actual_keys = set(state_dict.keys())
    missing = sorted(expected_keys - actual_keys)
    unexpected = sorted(actual_keys - expected_keys)
    if missing or unexpected:
        raise CheckpointVerificationError(
            f"Checkpoint architecture key mismatch: missing={missing[:10]}, unexpected={unexpected[:10]}"
        )

    shape_mismatches = [
        f"{k}: expected {tuple(expected_sd[k].shape)}, got {tuple(state_dict[k].shape)}"
        for k in expected_sd
        if expected_sd[k].shape != state_dict[k].shape
    ]
    if shape_mismatches:
        raise CheckpointVerificationError(
            f"Checkpoint tensor shape mismatch: {shape_mismatches[:10]}"
        )

    try:
        model.load_state_dict(state_dict, strict=True)
    except Exception as exc:
        raise CheckpointVerificationError(f"Strict state_dict load failed: {exc}") from exc

    for name, tensor in model.state_dict().items():
        if tensor.is_floating_point() and not torch.isfinite(tensor).all():
            raise CheckpointVerificationError(f"Non-finite parameter/buffer detected in '{name}'")

    model.checkpoint_sha256 = normalized_expected
    model.to(resolved_device)
    model.eval()
    return model
