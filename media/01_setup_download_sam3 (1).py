#!/usr/bin/env python3
"""Install Meta SAM 3 and download the official image checkpoint on Kaggle.

Run this once near the top of a Kaggle notebook:

    !python /kaggle/input/YOUR-DATASET/01_setup_download_sam3.py

Before running:
  1. Request/accept access at https://huggingface.co/facebook/sam3
  2. Add a Kaggle secret named HF_TOKEN containing a Hugging Face read token.
  3. Enable Internet and one or two T4 GPUs in Notebook settings.

The script intentionally downloads facebook/sam3/sam3.pt. SAM 3.1's public
checkpoint is primarily a multiplex video checkpoint; the standard SAM 3
checkpoint has the documented, stable image-inference path needed here.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from typing import Any


DEFAULT_WORKDIR = Path("/kaggle/working/sam3_runtime")
OFFICIAL_REPO = "https://github.com/facebookresearch/sam3.git"
HF_REPO = "facebook/sam3"
CHECKPOINT_NAME = "sam3.pt"


def run(command: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=cwd, check=True)


def get_hf_token() -> str | None:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        return token.strip()
    try:
        from kaggle_secrets import UserSecretsClient

        return UserSecretsClient().get_secret("HF_TOKEN").strip()
    except Exception:
        return None


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def install_runtime(repo_dir: Path, repo_revision: str) -> str:
    # Kaggle images change. Keep the existing CUDA-enabled torch when it already
    # satisfies SAM 3, instead of replacing it with a wheel that may mismatch.
    try:
        import torch

        torch_version = tuple(int(x) for x in torch.__version__.split("+")[0].split(".")[:2])
        if torch_version < (2, 6):
            raise RuntimeError(
                f"PyTorch {torch.__version__} is too old for this harness. "
                "Use a current Kaggle GPU runtime (official SAM 3 docs specify PyTorch >=2.7)."
            )
        if torch_version < (2, 7):
            print(
                f"WARNING: PyTorch {torch.__version__} is below Meta's documented 2.7 minimum. "
                "It may work, but choose a newer Kaggle runtime if inference fails."
            )
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is not available. Enable a GPU accelerator in Kaggle.")
        print(f"Using Kaggle PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
    except ImportError as exc:
        raise RuntimeError("Kaggle's CUDA PyTorch installation was not found.") from exc

    run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-q",
            "--upgrade",
            "huggingface_hub>=0.28",
            "opencv-python-headless>=4.8",
            "pillow>=10",
            "numpy>=1.26,<2",
            "pandas>=2",
            "requests>=2.31",
        ]
    )

    if repo_dir.exists() and (repo_dir / ".git").exists():
        run(["git", "fetch", "--depth", "1", "origin", repo_revision], cwd=repo_dir)
        run(["git", "checkout", "--detach", "FETCH_HEAD"], cwd=repo_dir)
    else:
        if repo_dir.exists():
            shutil.rmtree(repo_dir)
        run(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "--branch",
                repo_revision,
                OFFICIAL_REPO,
                str(repo_dir),
            ]
        )

    # SAM 3 declares its ordinary dependencies in pyproject.toml and does not
    # declare torch there, so this preserves Kaggle's CUDA-enabled torch build.
    run([sys.executable, "-m", "pip", "install", "-q", "-e", "."], cwd=repo_dir)
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repo_dir, text=True
    ).strip()
    return commit


def download_checkpoint(model_dir: Path, token: str) -> Path:
    from huggingface_hub import hf_hub_download, login

    login(token=token, add_to_git_credential=False)
    model_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading gated official checkpoint {HF_REPO}/{CHECKPOINT_NAME} ...")
    downloaded = Path(
        hf_hub_download(
            repo_id=HF_REPO,
            filename=CHECKPOINT_NAME,
            token=token,
            local_dir=str(model_dir),
        )
    )
    if not downloaded.is_file() or downloaded.stat().st_size < 1_000_000_000:
        raise RuntimeError(f"Checkpoint download appears incomplete: {downloaded}")
    return downloaded.resolve()


def gpu_inventory() -> list[dict[str, Any]]:
    import torch

    devices: list[dict[str, Any]] = []
    for index in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(index)
        devices.append(
            {
                "index": index,
                "name": props.name,
                "vram_gib": round(props.total_memory / 1024**3, 2),
                "compute_capability": f"{props.major}.{props.minor}",
            }
        )
    return devices


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workdir",
        type=Path,
        default=DEFAULT_WORKDIR,
        help="Runtime directory (default: /kaggle/working/sam3_runtime)",
    )
    parser.add_argument(
        "--repo-revision",
        default="main",
        help="Official SAM 3 git branch/tag/commit. The resolved commit is recorded.",
    )
    parser.add_argument(
        "--skip-install",
        action="store_true",
        help="Only download/verify the checkpoint; do not clone or pip-install SAM 3.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workdir = args.workdir.resolve()
    repo_dir = workdir / "sam3"
    model_dir = workdir / "models"
    workdir.mkdir(parents=True, exist_ok=True)

    if sys.version_info < (3, 12):
        print(
            f"WARNING: Meta documents Python >=3.12, while this runtime is "
            f"{platform.python_version()}. The package metadata supports older Python, "
            "so setup will continue; upgrade the Kaggle runtime if an import fails."
        )

    token = get_hf_token()
    if not token:
        raise RuntimeError(
            "HF_TOKEN was not found. Accept access at https://huggingface.co/facebook/sam3, "
            "then add a Kaggle secret named HF_TOKEN with a Hugging Face read token."
        )

    commit = "not-installed"
    if not args.skip_install:
        commit = install_runtime(repo_dir, args.repo_revision)

    checkpoint = download_checkpoint(model_dir, token)

    import torch

    manifest = {
        "created_by": Path(__file__).name,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "sam3_package": package_version("sam3"),
        "sam3_git_commit": commit,
        "sam3_repo": OFFICIAL_REPO,
        "checkpoint_repo": HF_REPO,
        "checkpoint_file": str(checkpoint),
        "checkpoint_bytes": checkpoint.stat().st_size,
        "checkpoint_sha256": sha256_file(checkpoint),
        "gpus": gpu_inventory(),
        "notes": [
            "One process uses one GPU; two T4 GPUs do not combine into 32 GB VRAM.",
            "The evaluation script can run one worker per T4 for parallel image folders.",
            "FlashAttention 3 is intentionally not installed because T4 is not its target GPU.",
        ],
    }
    manifest_path = workdir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("\nSetup complete")
    print(f"SAM 3 repo:  {repo_dir}")
    print(f"Checkpoint:  {checkpoint}")
    print(f"Manifest:    {manifest_path}")
    print("\nNext command:")
    print(
        "python 02_run_evaluate_sam3.py "
        "--images /kaggle/input/YOUR_DATASET/images "
        "--gpus 0,1 --output /kaggle/working/sam3_results"
    )


if __name__ == "__main__":
    main()
