"""N0 (review R6): run the node fake-pipe transport tests.

Skips gracefully when node is unavailable so the suite stays portable;
failure is a real failure when node exists (the F5 driver depends on this
transport).
"""

import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tests" / "f5_fake_pipe.cjs"


class FakePipeTransportTest(unittest.TestCase):
    def test_session_routing_timeouts_errors_and_teardown(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not installed")
        result = subprocess.run(
            [node, str(SCRIPT)], capture_output=True, text=True, timeout=60)
        self.assertEqual(
            result.returncode, 0,
            f"fake pipe tests failed:\n{result.stdout}\n{result.stderr}")
        self.assertIn("PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
