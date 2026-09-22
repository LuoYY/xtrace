"""N5 (resource plan C0/C2): build-coordinator tests with a fake ninja.

No real ninja, no compiler: a fake runner records its argv, holds the
lock as the coordinator's child, and can be told to misbehave so the
watchdog gates are exercised against the MANAGED group only.
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COORD = ROOT / "scripts" / "xtrace_build_coordinator.py"

FAKE_NINJA = """#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
argv_file = os.environ["FAKE_NINJA_ARGV"]
with open(argv_file, "w") as handle:
    handle.write(json.dumps(sys.argv))
hold = float(os.environ.get("FAKE_NINJA_HOLD", "3"))
if os.environ.get("FAKE_NINJA_CHILD") == "1":
    kid = subprocess.Popen([sys.executable, "-c",
                            f"import time; time.sleep({hold + 5})"])
    kid.wait()
time.sleep(hold)
"""


class CoordinatorTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.out = base / "out-fake"
        self.out.mkdir()
        (self.out / "validation").mkdir(exist_ok=True)
        self.fake = base / "fake-ninja"
        self.fake.write_text(FAKE_NINJA)
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IEXEC)
        self.argv_file = base / "argv.json"
        self.lock = base / "lock"
        self.env = dict(
            os.environ,
            NINJA_BIN=str(self.fake),
            FAKE_NINJA_ARGV=str(self.argv_file),
            XTRACE_BUILD_LOCK_PATH=str(self.lock),
            XTRACE_BUILD_DISK_START_GIB="1",
            XTRACE_BUILD_DISK_STOP_GIB="0.0001",  # effectively off
            XTRACE_BUILD_SAMPLE_SECS="1",
        )
        self.env.pop("FAKE_NINJA_HOLD", None)
        self.env.pop("FAKE_NINJA_CHILD", None)

    def run_coord(self, *args, env=None, timeout=60):
        return subprocess.run(
            [sys.executable, str(COORD), str(self.out), *args],
            capture_output=True, text=True, env=env or self.env,
            timeout=timeout)

    def captured_argv(self):
        return json.loads(self.argv_file.read_text())

    def test_interactive_profile_limits(self):
        result = self.run_coord("chrome", "--profile", "interactive")
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self.captured_argv()
        for flag, value in (("-j", "2"), ("-l", "3"), ("-k", "1")):
            i = argv.index(flag)
            self.assertEqual(argv[i + 1], value, argv)

    def test_idle_profile_and_overrides(self):
        result = self.run_coord("d8", "--profile", "idle")
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self.captured_argv()
        self.assertEqual(argv[argv.index("-j") + 1], "4")
        self.assertEqual(argv[argv.index("-l") + 1], "6")
        result = self.run_coord("d8", "--jobs", "5", "--load-limit", "7")
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self.captured_argv()
        self.assertEqual(argv[argv.index("-j") + 1], "5")
        self.assertEqual(argv[argv.index("-l") + 1], "7")

    def test_zero_and_negative_jobs_refused(self):
        for bad in ("0", "-2"):
            result = self.run_coord("chrome", "--jobs", bad)
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertIn("JOBS", result.stderr)
        result = self.run_coord("chrome", "--load-limit", "0")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("LOAD_LIMIT", result.stderr)
        self.assertFalse(self.lock.exists(), "refused run must not hold the lock")

    def test_ninja_bin_respected(self):
        result = self.run_coord("chrome")
        self.assertEqual(result.returncode, 0, result.stderr)
        # The FAKE ran (argv file exists = NINJA_BIN was honored) and it
        # received the coordinator's own argument vector.
        argv = self.captured_argv()
        self.assertEqual(argv[0], str(self.fake))  # the FAKE executed
        self.assertEqual(argv[1], "-C")
        self.assertIn("chrome", argv)

    def test_second_instance_refused_while_first_holds(self):
        env = dict(self.env, FAKE_NINJA_HOLD="6")
        first = subprocess.Popen(
            [sys.executable, str(COORD), str(self.out), "chrome"],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.time() + 15
            while not self.argv_file.exists() and time.time() < deadline:
                time.sleep(0.1)
            self.assertTrue(self.argv_file.exists(), "fake ninja never started")
            second = self.run_coord("chrome")
            self.assertEqual(second.returncode, 3, second.stderr)
            self.assertIn("another coordinator holds", second.stderr)
        finally:
            first.wait(timeout=30)
        self.assertFalse(self.lock.exists(), "lock must release after exit")

    def test_disk_floor_stops_managed_group_only(self):
        env = dict(self.env,
                   FAKE_NINJA_HOLD="60",
                   FAKE_NINJA_CHILD="1",
                   XTRACE_BUILD_DISK_STOP_GIB=str(1 << 20))  # impossible floor
        result = self.run_coord("chrome", env=env, timeout=60)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("WATCHDOG STOP", result.stdout)
        self.assertIn("disk", result.stdout)
        # Lock released and state recorded even on watchdog stop.
        self.assertFalse(self.lock.exists())
        states = sorted((self.out / "validation").glob("coordinator-*.state.json"))
        self.assertTrue(states, "state json missing")
        state = json.loads(states[-1].read_text())
        self.assertTrue(state["lock_released"])
        self.assertIn("disk", state["exit_reason"])

    def test_stale_lock_replaced(self):
        stale = {"pid": 99999999, "out": "gone", "argv": [], "started": 0}
        self.lock.write_text(json.dumps(stale))
        result = self.run_coord("chrome")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.lock.exists())


if __name__ == "__main__":
    unittest.main()
