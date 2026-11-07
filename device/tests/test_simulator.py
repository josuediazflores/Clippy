import hashlib
import tempfile
import unittest
from pathlib import Path
from clippy_device.simulator import generate


class SimulatorTests(unittest.TestCase):
    def test_bytes_and_identity_repeat_exactly(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            first = generate(output)
            self.assertEqual(first, generate(output))
            for capture in first:
                data = (output / (capture['captureId'] + '.png')).read_bytes()
                self.assertEqual(capture['sha256'], hashlib.sha256(data).hexdigest())
                self.assertEqual(capture['byteLength'], len(data))
