import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from clippy_device.agent import Agent, Config, Queue, Rejected, nmea_checksum_ok, parse_gga, sync

GGA_FIX = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47"
GGA_NOFIX = "$GPGGA,,,,,,0,00,99.99,,,,,,*48"


class FakeCloud:
    """Plays the device Lambda: idempotent by request ID, can fail one call on demand."""

    def __init__(self, owned=True):
        self.owned = owned
        self.calls = []
        self.responses = {}
        self.objects = {}
        self.fail_once = None
        self.active = None

    def request(self, kind, body=None, snapshot=None, request_id=None, timeout=0):
        self.calls.append((kind, request_id))
        if not self.owned:
            raise Rejected(403, {"error": {"code": "FORBIDDEN"}})
        if self.fail_once == kind:
            self.fail_once = None
            raise TimeoutError("lost response")
        if request_id in self.responses:
            return self.responses[request_id]
        if kind == "device.status":
            result = {"identity": {"ownershipEpoch": 1, "appliedRevision": 1, "claimState": "owned"},
                      "activeSync": self.active}
        elif kind == "state.report":
            result = body
        elif kind == "sync.begin":
            if body["startedAt"] > body["cutoffAt"] or body["sequenceEnd"] < body["sequenceStart"]:
                raise Rejected(400, {"error": {"code": "INVALID_REQUEST"}})
            self.begin = body
            result = {"schemaVersion": 1, "snapshotId": "snap_1", "syncRequestId": body["syncRequestId"] or "sync_auto",
                      "deviceId": body["deviceId"], "ownershipEpoch": 1}
        elif kind == "upload.grants":
            assert 1 <= len(body["items"]) <= 20
            result = {"items": [{"uploadId": f"up_{item['captureId'] or 'manifest'}", "putURL": f"https://s3/{item['sha256']}",
                                 "requiredHeaders": {"If-None-Match": "*"}} for item in body["items"]]}
        elif kind == "sync.complete":
            manifest = json.loads(self.objects[body["manifestSHA256"]])
            assert hashlib.sha256(self.objects[body["manifestSHA256"]]).hexdigest() == body["manifestSHA256"]
            ids = [c["captureId"] for c in manifest["captures"]]
            assert all(c["sha256"] in self.objects for c in manifest["captures"])
            result = {"acceptedCaptureIds": ids, "suppressedCaptureIds": [], "dayIds": ["day_x"]}
        self.responses[request_id] = result
        return result

    def put(self, url, data, headers):
        self.objects[url.rsplit("/", 1)[1]] = data
        return 200


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_nmea_fix_and_no_fix(self):
        self.assertTrue(nmea_checksum_ok(GGA_FIX))
        fix = parse_gga(GGA_FIX)
        self.assertAlmostEqual(fix["latitude"], 48.1173, places=4)
        self.assertAlmostEqual(fix["longitude"], 11.516667, places=5)
        self.assertEqual(fix["accuracyMeters"], 4.5)
        self.assertIsNone(parse_gga(GGA_NOFIX))
        self.assertIsNone(parse_gga(GGA_FIX.replace("*47", "*00")), "bad checksum is ignored")

    def test_queue_sequences_survive_restart_and_orphans_are_removed(self):
        queue = Queue(self.dir)
        a = queue.add(b"\xff\xd8one", "dev_clippy_001", 1, None, "synchronized")
        (queue.media / "stray.jpg").write_bytes(b"partial")
        reopened = Queue(self.dir)
        b = reopened.add(b"\xff\xd8two", "dev_clippy_001", 1, None, "synchronized")
        self.assertEqual((a["sequence"], b["sequence"]), (1, 2))
        self.assertEqual(b["captureId"], "cap_dev_clippy_001_00000002")
        self.assertFalse((reopened.media / "stray.jpg").exists())
        reopened.acknowledge({a["captureId"]})
        c = reopened.add(b"\xff\xd8three", "dev_clippy_001", 1, None, "synchronized")
        self.assertEqual(c["sequence"], 3, "sequence never reuses acknowledged numbers")

    def test_manual_sync_uploads_resumes_with_same_ids_and_deletes_only_after_receipt(self):
        queue = Queue(self.dir)
        for i in range(23):  # more than one grant batch
            queue.add(b"\xff\xd8" + bytes([i]) * 10, "dev_clippy_001", 1, None, "synchronized")
        cloud = FakeCloud()
        cloud.fail_once = "sync.complete"
        active = {"syncRequestId": "sync_app_1", "state": "waiting_for_device", "trigger": "manual"}
        with self.assertRaises(TimeoutError):
            sync(queue, cloud, "dev_clippy_001", 1, 1, active, uploader=cloud.put)
        self.assertEqual(queue.stats()[0], 23, "nothing deleted before a receipt")
        self.assertEqual(cloud.begin["syncRequestId"], "sync_app_1")
        self.assertEqual(cloud.begin["trigger"], "manual")
        first_complete = [r for k, r in cloud.calls if k == "sync.complete"]

        receipt = sync(queue, cloud, "dev_clippy_001", 1, 1, None, uploader=cloud.put)
        self.assertEqual(len(receipt["acceptedCaptureIds"]), 23)
        self.assertEqual(queue.stats(), (0, 0))
        self.assertEqual(list(queue.media.iterdir()), [])
        self.assertFalse((self.dir / "sync.json").exists())
        completes = [r for k, r in cloud.calls if k == "sync.complete"]
        self.assertEqual(completes[-1], first_complete[0], "retry reuses the request ID")
        self.assertEqual(sum(1 for k, _ in cloud.calls if k == "sync.begin"), 1, "snapshot begun once")

    def test_unclaimed_device_captures_nothing_and_claimed_device_starts(self):
        config = Config(device_id="dev_clippy_001", endpoint="x", cert=Path("c"), key=Path("k"),
                        data=self.dir, gps_port=None, nightly_utc=None)
        cloud = FakeCloud(owned=False)
        frames = []
        agent = Agent(config, transport=cloud, capture=lambda: frames.append(1) or b"\xff\xd8frame")
        agent.step()
        self.assertFalse(agent.paired)
        self.assertEqual(frames, [])
        cloud.owned = True
        agent.next["status"] = 0
        agent.step()
        self.assertTrue(agent.paired)
        self.assertEqual(len(frames), 1)
        self.assertEqual(agent.queue.stats()[0], 1)


if __name__ == "__main__":
    unittest.main()
