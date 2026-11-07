"""Finite synthetic capture generator, with no camera or timer access."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class SyntheticCamera:
    def capture(self, sequence: int) -> tuple[bytes, str]:
        return (
            ROOT / f"fixtures/media/capture_{(sequence - 1) % 3 + 1}.png"
        ).read_bytes(), "image/png"


def generate(output: Path, start: int = 1, count: int = 2):
    if not 1 <= count <= 200 or start < 1:
        raise ValueError("bounded positive count and sequence required")
    output.mkdir(parents=True, exist_ok=True)
    camera = SyntheticCamera()
    captures = []
    for seq in range(start, start + count):
        data, content_type = camera.capture(seq)
        capture_id = f"cap_sample_{seq:03d}"
        metadata = {
            "schemaVersion": 1,
            "captureId": capture_id,
            "deviceId": "dev_sample_001",
            "ownershipEpoch": 1,
            "sequence": seq,
            "capturedAt": f"2026-11-07T{8 + seq % 12:02d}:00:00Z",
            "timeZone": "UTC",
            "utcOffsetSeconds": 0,
            "clockQuality": "synchronized",
            "byteLength": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "contentType": content_type,
            "location": None,
        }
        (output / f"{capture_id}.png").write_bytes(data)
        captures.append(metadata)
    (output / "captures.json").write_text(json.dumps(captures, indent=2) + "\n")
    return captures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".local/device"))
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--count", type=int, default=2)
    args = parser.parse_args()
    captures = generate(args.output, args.start, args.count)
    print(f"Generated {len(captures)} synthetic captures. No schedule or hardware activated.")


if __name__ == "__main__":
    main()
