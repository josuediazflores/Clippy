"""Finite resumable upload through the v1 local transport adapter."""

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from clippy_device.simulator import generate


def atomic_json(path: Path, value):
    temp = path.with_suffix(".tmp")
    with temp.open("w") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(path)


class LocalHTTPTransport:
    def __init__(self, base_url: str):
        parsed = urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise ValueError("Synthetic transport permits loopback HTTP only")
        self.base_url = base_url.rstrip("/")

    def request(self, method: str, path: str, payload: dict, key: str) -> dict:
        request = Request(
            self.base_url + path,
            json.dumps(payload).encode(),
            method=method,
            headers={
                "Authorization": "Bearer local-device-a",
                "Content-Type": "application/json",
                "Idempotency-Key": key,
            },
        )
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def put(self, url: str, data: bytes, headers: dict) -> int:
        if not url.startswith(self.base_url + "/local/uploads/"):
            raise ValueError("Grant escaped local origin")
        request = Request(
            url, data, method="PUT", headers={**headers, "Authorization": "Bearer local-device-a"}
        )
        try:
            with urlopen(request, timeout=10) as response:
                return response.status
        except HTTPError as error:
            if error.code == 412:
                return 412  # Only completion reconciliation can acknowledge this capture.
            raise


def sync(
    folder: Path,
    transport: LocalHTTPTransport,
    start: int,
    count: int,
    trigger: str,
    stop_after: str | None = None,
):
    folder.mkdir(parents=True, exist_ok=True)
    checkpoint_file = folder / "checkpoint.json"
    if checkpoint_file.exists():
        checkpoint = json.loads(checkpoint_file.read_text())
        if checkpoint["config"] != [start, count, trigger]:
            raise ValueError("Frozen snapshot config changed; use a new queue directory")
        captures = json.loads((folder / "captures.json").read_text())
    else:
        captures = generate(folder, start, count)
        checkpoint = {"config": [start, count, trigger], "uploaded": [], "acknowledged": False}
        atomic_json(checkpoint_file, checkpoint)
    if checkpoint["acknowledged"]:
        return checkpoint["receipt"]
    operation = f"sim_{trigger}_{start}_{count}"
    begin = {
        "schemaVersion": 1,
        "deviceId": "dev_sample_001",
        "ownershipEpoch": 1,
        "syncRequestId": None,
        "trigger": trigger,
        "startedAt": "2026-11-07T20:00:00Z",
        "cutoffAt": "2026-11-07T20:00:00Z",
        "sequenceStart": start,
        "sequenceEnd": start + count - 1,
        "captureCount": count,
        "configurationRevision": 1,
    }
    if "snapshot" not in checkpoint:
        checkpoint["snapshot"] = transport.request(
            "POST", "/v1/device/snapshots", begin, operation + "_begin"
        )
        atomic_json(checkpoint_file, checkpoint)
    snapshot = checkpoint["snapshot"]
    prefix = "/v1/device/snapshots/" + snapshot["snapshotId"]
    if "completion" in checkpoint:
        receipt = transport.request(
            "POST", prefix + "/complete", checkpoint["completion"], operation + "_complete"
        )
        checkpoint["receipt"] = receipt
        checkpoint["acknowledged"] = True
        atomic_json(checkpoint_file, checkpoint)
        return receipt
    items = [
        {
            "kind": "capture",
            "captureId": c["captureId"],
            "sha256": c["sha256"],
            "byteLength": c["byteLength"],
            "contentType": c["contentType"],
        }
        for c in captures
    ]
    grants = []
    # New grant key permits expiry renewal while preserving upload identities.
    checkpoint["attempt"] = checkpoint.get("attempt", 0) + 1
    atomic_json(checkpoint_file, checkpoint)
    for offset in range(0, len(items), 20):
        response = transport.request(
            "POST",
            prefix + "/grants",
            {
                "schemaVersion": 1,
                "deviceId": "dev_sample_001",
                "ownershipEpoch": 1,
                "items": items[offset : offset + 20],
            },
            operation + f"_grants_{checkpoint['attempt']}_{offset}",
        )
        grants.extend(response["items"])
    for index, (capture, grant) in enumerate(zip(captures, grants, strict=True)):
        data = (folder / (capture["captureId"] + ".png")).read_bytes()
        if (
            len(data) != capture["byteLength"]
            or hashlib.sha256(data).hexdigest() != capture["sha256"]
        ):
            raise ValueError("Local media no longer matches frozen capture")
        # Reconcile every retry, including lost checkpoints. PUT success never deletes bytes.
        transport.put(grant["putURL"], data, grant["requiredHeaders"])
        if capture["captureId"] not in checkpoint["uploaded"]:
            checkpoint["uploaded"].append(capture["captureId"])
        if stop_after == "put-before-checkpoint" and index == 0:
            return None
        atomic_json(checkpoint_file, checkpoint)
        if stop_after == "first-upload" and index == 0:
            return None
    manifest = {
        **begin,
        **snapshot,
        "captures": [
            {**c, "uploadId": g["uploadId"]} for c, g in zip(captures, grants, strict=True)
        ],
        "gaps": [],
    }
    del manifest["configurationRevision"]
    data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    manifest_hash = hashlib.sha256(data).hexdigest()
    grant = transport.request(
        "POST",
        prefix + "/grants",
        {
            "schemaVersion": 1,
            "deviceId": "dev_sample_001",
            "ownershipEpoch": 1,
            "items": [
                {
                    "kind": "manifest",
                    "captureId": None,
                    "byteLength": len(data),
                    "sha256": manifest_hash,
                    "contentType": "application/json",
                }
            ],
        },
        operation + f"_manifest_{checkpoint['attempt']}",
    )["items"][0]
    transport.put(grant["putURL"], data, grant["requiredHeaders"])
    checkpoint["completion"] = {
        "schemaVersion": 1,
        "deviceId": "dev_sample_001",
        "ownershipEpoch": 1,
        "manifestUploadId": grant["uploadId"],
        "manifestSHA256": manifest_hash,
    }
    atomic_json(checkpoint_file, checkpoint)
    if stop_after == "manifest":
        return None
    receipt = transport.request(
        "POST", prefix + "/complete", checkpoint["completion"], operation + "_complete"
    )
    if stop_after == "receipt-before-checkpoint":
        return None
    checkpoint["receipt"] = receipt
    checkpoint["acknowledged"] = True
    atomic_json(checkpoint_file, checkpoint)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8787")
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--count", type=int, default=2)
    parser.add_argument("--trigger", choices=["manual", "nightly"], default="manual")
    parser.add_argument(
        "--stop-after",
        choices=["put-before-checkpoint", "first-upload", "manifest", "receipt-before-checkpoint"],
    )
    args = parser.parse_args()
    receipt = sync(
        args.queue,
        LocalHTTPTransport(args.url),
        args.start,
        args.count,
        args.trigger,
        args.stop_after,
    )
    print(json.dumps({"acknowledged": receipt is not None, "receipt": receipt}))


if __name__ == "__main__":
    main()
