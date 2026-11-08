"""Clippy wearable agent for the Raspberry Pi prototype (P05 minimal runtime).

Runs as a systemd service. While unclaimed it only checks in with the cloud and captures nothing.
Once the printed QR has been claimed in the app, it captures a JPEG every interval into a local
queue (SQLite metadata plus atomically written files) and uploads a snapshot when the app asks
(Sync now) or once a night. Images are deleted only after the server's durable receipt.

Not implemented yet: pause gesture, Wi-Fi setup, battery telemetry, local encryption.

    python3 -m clippy_device.agent --config ~/.clippy/config.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sqlite3
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger("clippy")
SNAPSHOT_LIMIT = 200
GRANT_BATCH = 20
FIX_MAX_AGE = 120


def instant(moment: float | None = None) -> str:
    when = datetime.fromtimestamp(moment if moment is not None else time.time(), timezone.utc)
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def local_zone(configured: str | None = None) -> str:
    """The IANA zone captures are stamped with: config override, then the system zone, else UTC."""
    candidates = [configured]
    try:
        candidates.append(subprocess.run(["timedatectl", "show", "-p", "Timezone", "--value"],
                                         capture_output=True, text=True, timeout=5).stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        candidates.append(Path("/etc/timezone").read_text().strip())
    except OSError:
        pass
    for zone in candidates:
        if zone:
            try:
                ZoneInfo(zone)
                return zone
            except (ZoneInfoNotFoundError, ValueError):
                continue
    return "UTC"


def zone_offset(zone: str, moment: float) -> int:
    """UTC offset in seconds for `zone` at `moment`, daylight saving included."""
    return int(datetime.fromtimestamp(moment, ZoneInfo(zone)).utcoffset().total_seconds())


def atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name("." + path.name + ".tmp")
    with open(temporary, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def new_id(prefix: str) -> str:
    return prefix + "_" + uuid.uuid4().hex[:24]


# --- configuration ---------------------------------------------------------------------------


@dataclass
class Config:
    device_id: str
    endpoint: str
    cert: Path
    key: Path
    data: Path
    capture_interval: int = 600
    nightly_utc: str | None = "02:00"
    status_interval: int = 20
    report_interval: int = 300
    width: int = 1280
    height: int = 960
    quality: int = 85
    gps_port: str | None = "/dev/serial0"
    time_zone: str | None = None

    @staticmethod
    def load(path: Path) -> Config:
        raw = json.loads(path.read_text())
        base = path.parent
        return Config(
            device_id=raw["deviceId"],
            endpoint=raw["endpoint"],
            cert=base / raw.get("cert", "certificate.pem"),
            key=base / raw.get("key", "private.key"),
            data=Path(raw.get("dataDir", base / "data")),
            capture_interval=int(raw.get("captureIntervalSeconds", 600)),
            nightly_utc=raw.get("nightlyUtc", "02:00"),
            gps_port=raw.get("gpsPort", "/dev/serial0"),
            time_zone=raw.get("timeZone"),
        )


# --- GPS ---------------------------------------------------------------------------------------


def nmea_checksum_ok(line: str) -> bool:
    if not line.startswith("$") or "*" not in line:
        return False
    body, _, given = line[1:].partition("*")
    value = 0
    for char in body:
        value ^= ord(char)
    try:
        return value == int(given[:2], 16)
    except ValueError:
        return False


def nmea_degrees(value: str, hemisphere: str) -> float | None:
    if not value or "." not in value:
        return None
    dot = value.index(".")
    degrees = float(value[: dot - 2]) + float(value[dot - 2 :]) / 60
    return -degrees if hemisphere in ("S", "W") else degrees


def parse_gga(line: str) -> dict | None:
    """Returns a position from a valid GGA sentence with a fix, else None."""
    if not nmea_checksum_ok(line):
        return None
    fields = line.split("*")[0].split(",")
    if not fields[0].endswith("GGA") or len(fields) < 9 or fields[6] in ("", "0"):
        return None
    latitude = nmea_degrees(fields[2], fields[3])
    longitude = nmea_degrees(fields[4], fields[5])
    if latitude is None or longitude is None:
        return None
    hdop = float(fields[8]) if fields[8] else 20.0
    return {
        "latitude": round(latitude, 6),
        "longitude": round(longitude, 6),
        # A rough consumer-GNSS bound; the contract only needs an honest accuracy figure.
        "accuracyMeters": min(100000.0, round(hdop * 5.0, 1)),
    }


class Gps:
    """Reads NMEA in a background thread and keeps the latest fix."""

    def __init__(self, port: str | None):
        self.port = port
        self.fix: dict | None = None
        self.fixed_at = 0.0
        if port:
            threading.Thread(target=self._run, name="gps", daemon=True).start()

    def _run(self) -> None:
        import serial  # pyserial, installed on the device

        while True:
            try:
                with serial.Serial(self.port, 9600, timeout=2) as stream:
                    while True:
                        line = stream.readline().decode("ascii", "replace").strip()
                        position = parse_gga(line)
                        if position:
                            self.fix, self.fixed_at = position, time.time()
            except Exception as error:  # noqa: BLE001 - a GPS fault must never stop capture
                log.warning("gps unavailable: %s", error)
                time.sleep(30)

    def location(self) -> dict | None:
        if not self.fix or time.time() - self.fixed_at > FIX_MAX_AGE:
            return None
        return {**self.fix, "sampledAt": instant(self.fixed_at), "source": "gnss"}


# --- local queue ---------------------------------------------------------------------------------


class Queue:
    """Captures are durable once their row commits. Sequence numbers stay contiguous."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.media = folder / "media"
        self.media.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(folder / "queue.db", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS captures (sequence INTEGER PRIMARY KEY,"
            " capture TEXT NOT NULL, file TEXT NOT NULL)"
        )
        self.db.commit()
        self._clean_orphans()

    def meta(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (key, value))
        self.db.commit()

    def _clean_orphans(self) -> None:
        known = {row[0] for row in self.db.execute("SELECT file FROM captures")}
        for path in self.media.iterdir():
            if path.name not in known:
                path.unlink(missing_ok=True)

    def add(self, data: bytes, device_id: str, epoch: int, location: dict | None, clock: str,
            zone: str = "UTC") -> dict:
        moment = time.time()
        with self.db:
            sequence = int(self.meta("last_sequence", "0")) + 1
            capture = {
                "schemaVersion": 1,
                "captureId": f"cap_{device_id}_{sequence:08d}",
                "deviceId": device_id,
                "ownershipEpoch": epoch,
                "sequence": sequence,
                "capturedAt": instant(moment),
                # The backend files each capture under its local date in this zone (D52).
                "timeZone": zone,
                "utcOffsetSeconds": zone_offset(zone, moment),
                "clockQuality": clock,
                "byteLength": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "contentType": "image/jpeg",
                "location": location,
            }
            name = f"{sequence:08d}.jpg"
            atomic_write(self.media / name, data)
            self.db.execute(
                "INSERT INTO captures (sequence, capture, file) VALUES (?, ?, ?)",
                (sequence, json.dumps(capture), name),
            )
            self.db.execute(
                "INSERT OR REPLACE INTO meta (k, v) VALUES ('last_sequence', ?)", (str(sequence),)
            )
        return capture

    def queued(self, limit: int = SNAPSHOT_LIMIT) -> list[tuple[dict, Path]]:
        rows = self.db.execute(
            "SELECT capture, file FROM captures ORDER BY sequence LIMIT ?", (limit,)
        ).fetchall()
        return [(json.loads(capture), self.media / name) for capture, name in rows]

    def stats(self) -> tuple[int, int]:
        rows = self.queued(1_000_000)
        return len(rows), sum(c["byteLength"] for c, _ in rows)

    def acknowledge(self, capture_ids: set[str]) -> None:
        for capture, path in self.queued(1_000_000):
            if capture["captureId"] in capture_ids:
                with self.db:
                    self.db.execute("DELETE FROM captures WHERE sequence = ?", (capture["sequence"],))
                path.unlink(missing_ok=True)


# --- cloud transport -----------------------------------------------------------------------------


class Rejected(Exception):
    def __init__(self, status: int, body):
        super().__init__(f"{status}: {body}")
        self.status = status
        self.code = (body or {}).get("error", {}).get("code") if isinstance(body, dict) else None


class Mqtt:
    """Request/response over the device's own IoT topics (D24 envelope)."""

    def __init__(self, config: Config):
        import ssl

        import paho.mqtt.client as mqtt

        self.prefix = f"clippy/v1/devices/{config.device_id}"
        self.connected = threading.Event()
        self.pending: dict[str, list] = {}
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=config.device_id, protocol=mqtt.MQTTv311
        )
        self.client.tls_set(
            certfile=str(config.cert), keyfile=str(config.key), tls_version=ssl.PROTOCOL_TLS_CLIENT
        )
        self.client.on_connect = self._connected
        self.client.on_disconnect = lambda *_: self.connected.clear()
        self.client.on_message = self._message
        self.client.reconnect_delay_set(1, 60)
        self.client.connect_async(config.endpoint, 8883, keepalive=60)
        self.client.loop_start()

    def _connected(self, client, _userdata, _flags, reason, _properties=None) -> None:
        if reason == 0:
            client.subscribe(self.prefix + "/responses/+", qos=1)
            self.connected.set()
            log.info("connected to AWS IoT")
        else:
            log.warning("IoT connection refused: %s", reason)

    def _message(self, _client, _userdata, message) -> None:
        try:
            response = json.loads(message.payload)
        except ValueError:
            return
        slot = self.pending.get(response.get("requestId"))
        if slot:
            slot[1] = response
            slot[0].set()

    def request(self, kind: str, body=None, snapshot: str | None = None, request_id: str | None = None,
                timeout: float = 25) -> dict:
        if not self.connected.wait(timeout):
            raise TimeoutError("not connected")
        request_id = request_id or new_id("req")
        slot = [threading.Event(), None]
        self.pending[request_id] = slot
        try:
            payload = {"schemaVersion": 1, "requestId": request_id, "type": kind,
                       "snapshotId": snapshot, "body": body}
            self.client.publish(self.prefix + "/requests", json.dumps(payload), qos=1)
            if not slot[0].wait(timeout):
                raise TimeoutError(f"no response to {kind}")
        finally:
            self.pending.pop(request_id, None)
        response = slot[1]
        if not 200 <= response["status"] < 300:
            raise Rejected(response["status"], response.get("body"))
        return response["body"]


def put(url: str, data: bytes, headers: dict) -> int:
    """PUT exactly the server-required headers. 412 means the immutable object already exists."""
    request = Request(url, data=data, method="PUT", headers=headers)
    try:
        with urlopen(request, timeout=60) as response:
            return response.status
    except HTTPError as error:
        if error.code == 412:
            return 412
        raise


# --- sync ----------------------------------------------------------------------------------------


def sync(queue: Queue, transport, device_id: str, epoch: int, revision: int, active: dict | None,
         uploader=put) -> dict | None:
    """Uploads one frozen snapshot and returns the receipt. Resumable through sync.json."""
    checkpoint_file = queue.folder / "sync.json"
    checkpoint = json.loads(checkpoint_file.read_text()) if checkpoint_file.exists() else None
    save = lambda: atomic_write(checkpoint_file, json.dumps(checkpoint).encode())  # noqa: E731
    if checkpoint is None:
        frozen = queue.queued()
        if not frozen:
            return None
        manual = bool(active and active.get("state") == "waiting_for_device" and active.get("trigger") == "manual")
        captures = [c for c, _ in frozen]
        key = new_id("sync")
        checkpoint = {
            "key": key,
            "captures": captures,
            "begin": {
                "schemaVersion": 1,
                "deviceId": device_id,
                "ownershipEpoch": epoch,
                "syncRequestId": active["syncRequestId"] if manual else None,
                "trigger": "manual" if manual else "nightly",
                # The backend requires startedAt <= cutoffAt: the window runs from the first capture to now.
                "startedAt": captures[0]["capturedAt"],
                "cutoffAt": max(instant(), captures[-1]["capturedAt"]),
                "sequenceStart": captures[0]["sequence"],
                "sequenceEnd": captures[-1]["sequence"],
                "captureCount": len(captures),
                "configurationRevision": revision,
            },
            "attempt": 0,
        }
        save()
    key = checkpoint["key"]
    captures = checkpoint["captures"]
    if "snapshot" not in checkpoint:
        try:
            checkpoint["snapshot"] = transport.request("sync.begin", checkpoint["begin"], request_id=key + "_begin")
        except Rejected:
            checkpoint_file.unlink(missing_ok=True)  # stale or conflicting request; start fresh later
            raise
        save()
    snapshot_id = checkpoint["snapshot"]["snapshotId"]
    identity = {"schemaVersion": 1, "deviceId": device_id, "ownershipEpoch": checkpoint["begin"]["ownershipEpoch"]}
    if "completion" not in checkpoint:
        checkpoint["attempt"] += 1
        save()
        attempt = checkpoint["attempt"]
        grants = []
        items = [{"kind": "capture", "captureId": c["captureId"], "byteLength": c["byteLength"],
                  "sha256": c["sha256"], "contentType": c["contentType"]} for c in captures]
        for offset in range(0, len(items), GRANT_BATCH):
            response = transport.request("upload.grants", {**identity, "items": items[offset:offset + GRANT_BATCH]},
                                         snapshot=snapshot_id, request_id=f"{key}_g{attempt}_{offset}")
            grants.extend(response["items"])
        for capture, grant in zip(captures, grants, strict=True):
            data = (queue.media / f"{capture['sequence']:08d}.jpg").read_bytes()
            if hashlib.sha256(data).hexdigest() != capture["sha256"]:
                raise ValueError(f"{capture['captureId']} changed on disk")
            uploader(grant["putURL"], data, grant["requiredHeaders"])
        manifest = {**checkpoint["begin"], **checkpoint["snapshot"],
                    "captures": [{**c, "uploadId": g["uploadId"]} for c, g in zip(captures, grants, strict=True)],
                    "gaps": []}
        del manifest["configurationRevision"]
        data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(data).hexdigest()
        grant = transport.request(
            "upload.grants",
            {**identity, "items": [{"kind": "manifest", "captureId": None, "byteLength": len(data),
                                    "sha256": digest, "contentType": "application/json"}]},
            snapshot=snapshot_id, request_id=f"{key}_m{attempt}")["items"][0]
        uploader(grant["putURL"], data, grant["requiredHeaders"])
        checkpoint["completion"] = {**identity, "manifestUploadId": grant["uploadId"], "manifestSHA256": digest}
        save()
    try:
        receipt = transport.request("sync.complete", checkpoint["completion"], snapshot=snapshot_id,
                                    request_id=f"{key}_complete_{checkpoint['attempt']}")
    except Rejected as error:
        if error.code == "MISSING_OBJECTS":
            del checkpoint["completion"]  # re-grant and re-upload on the next pass
            save()
        raise
    queue.acknowledge(set(receipt["acceptedCaptureIds"]) | set(receipt["suppressedCaptureIds"]))
    checkpoint_file.unlink(missing_ok=True)
    return receipt


# --- agent loop ----------------------------------------------------------------------------------


def clock_quality() -> str:
    try:
        out = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        return "synchronized" if out == "yes" else "estimated"
    except (OSError, subprocess.SubprocessError):
        return "estimated"


def camera(config: Config) -> bytes:
    target = config.data / ".frame.jpg"
    subprocess.run(
        ["rpicam-still", "--nopreview", "--immediate", "--width", str(config.width), "--height",
         str(config.height), "--quality", str(config.quality), "-o", str(target)],
        check=True, capture_output=True, timeout=60,
    )
    data = target.read_bytes()
    target.unlink(missing_ok=True)
    if not data.startswith(b"\xff\xd8") or len(data) > 5_000_000:
        raise ValueError("camera returned an invalid frame")
    return data


class Agent:
    def __init__(self, config: Config, transport=None, capture=None):
        self.config = config
        config.data.mkdir(parents=True, exist_ok=True)
        self.queue = Queue(config.data)
        self.gps = Gps(config.gps_port)
        self.transport = transport or Mqtt(config)
        self.capture_frame = capture or (lambda: camera(config))
        self.zone = local_zone(config.time_zone)
        self.paired = None
        self.identity: dict | None = None
        self.active: dict | None = None
        self.next = {"status": 0.0, "capture": 0.0, "report": 0.0}

    def poll_status(self) -> None:
        try:
            detail = self.transport.request("device.status")
        except Rejected as error:
            if error.status == 403:
                if self.paired is not False:
                    log.info("unclaimed: waiting for the QR to be claimed in the app")
                self.paired, self.identity, self.active = False, None, None
                return
            raise
        if not self.paired:
            log.info("claimed: capturing every %ss", self.config.capture_interval)
            self.next["capture"] = 0.0
        self.paired, self.identity, self.active = True, detail["identity"], detail.get("activeSync")

    def take(self) -> None:
        data = self.capture_frame()
        capture = self.queue.add(data, self.config.device_id, self.identity["ownershipEpoch"],
                                 self.gps.location(), clock_quality(), self.zone)
        log.info("captured %s (%d bytes, location %s)", capture["captureId"], len(data),
                 "yes" if capture["location"] else "none")

    def report(self) -> None:
        count, size = self.queue.stats()
        self.transport.request("state.report", {
            "schemaVersion": 1, "deviceId": self.config.device_id,
            "ownershipEpoch": self.identity["ownershipEpoch"], "captureState": "capturing",
            "batteryPercent": None, "charging": None, "queuedCaptures": count, "queuedBytes": size,
            "connectivity": "online", "clockQuality": clock_quality(),
            "appliedRevision": self.identity["appliedRevision"], "observedAt": instant()})

    def nightly_due(self) -> bool:
        if not self.config.nightly_utc:
            return False
        now = datetime.now(timezone.utc)
        today = now.strftime("%Y-%m-%d")
        return now.strftime("%H:%M") >= self.config.nightly_utc and self.queue.meta("nightly") != today

    def step(self) -> None:
        now = time.monotonic()
        if now >= self.next["status"]:
            self.next["status"] = now + self.config.status_interval
            self.poll_status()
        if not self.paired:
            return
        manual = bool(self.active and self.active.get("state") == "waiting_for_device"
                      and self.active.get("trigger") == "manual")
        if now >= self.next["capture"] or (manual and not self.queue.stats()[0]):
            self.next["capture"] = now + self.config.capture_interval
            self.take()
        if now >= self.next["report"]:
            self.next["report"] = now + self.config.report_interval
            self.report()
        nightly = self.nightly_due()
        if manual or nightly or (self.queue.folder / "sync.json").exists():
            receipt = sync(self.queue, self.transport, self.config.device_id,
                           self.identity["ownershipEpoch"], self.identity["appliedRevision"], self.active)
            if nightly:
                self.queue.set_meta("nightly", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
            if receipt:
                log.info("uploaded %d captures (days %s)", len(receipt["acceptedCaptureIds"]),
                         ", ".join(receipt["dayIds"]))
            self.active = None
            self.next["status"] = 0.0
            self.next["report"] = 0.0

    def run(self) -> None:
        log.info("Clippy agent %s starting (time zone %s)", self.config.device_id, self.zone)
        while True:
            try:
                self.step()
            except Exception as error:  # noqa: BLE001 - keep running; capture must survive upload faults
                log.warning("%s: %s", type(error).__name__, error)
                time.sleep(10)
            time.sleep(2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Clippy wearable agent")
    parser.add_argument("--config", type=Path, default=Path.home() / ".clippy" / "config.json")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Agent(Config.load(args.config)).run()


if __name__ == "__main__":
    main()
