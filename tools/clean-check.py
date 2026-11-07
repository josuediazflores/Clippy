"""Verify an isolated source export, then remove only its temporary files."""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    scratch = ROOT / ".local"
    scratch.mkdir(exist_ok=True)
    files = (
        subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
        )
        .decode()
        .split("\0")
    )
    with tempfile.TemporaryDirectory(prefix="clean-check-", dir=scratch) as folder:
        clean = Path(folder)
        for name in set(filter(None, files)):
            source = ROOT / name
            if source.is_file():
                target = clean / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        env = {**os.environ, "PYTHONPATH": str(clean / "device")}
        for command in [
            ["npm", "ci", "--no-audit", "--no-fund"],
            ["uv", "sync", "--locked"],
            ["npm", "run", "check"],
            ["bash", "tools/ios-build.sh"],
            ["npm", "run", "demo" if os.environ.get("CLIPPY_CLEAN_UI") == "1" else "scenario"],
        ]:
            print("Clean export:", " ".join(command), flush=True)
            subprocess.run(command, cwd=clean, env=env, check=True, timeout=480)
        if os.environ.get("CLIPPY_CLEAN_UI") == "1":
            destination = ROOT / ".local/evidence/clean-ui"
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(clean / ".local/evidence", destination)
    print(
        "Clean source export passed: locked install, checks, fresh iOS build, local scenario. Temporary export removed."
    )


if __name__ == "__main__":
    main()
