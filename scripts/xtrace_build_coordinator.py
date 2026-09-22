#!/usr/bin/env python3
"""XTrace build coordinator (N5, resource plan §3/§4, C0+C2).

Single coordinator for every ninja invocation against this project's out
dirs: two profiles (interactive -j2/-l3/-k1 default, idle -j4/-l6/-k1),
explicit JOBS/LOAD_LIMIT overrides (0 and illegal values rejected), a
project-wide exclusive lock, QoS scheduling (taskpolicy -b + nice 10),
a 5-second watchdog over ONLY the managed process group (disk floor,
sustained memory pressure, managed-tree RSS/CPU budgets, swap growth),
and SIGINT-based pause that preserves incremental state.

Fail-closed: unknown profiles, JOBS<=0, LOAD_LIMIT<=0, a held lock, or a
filesystem under the start gate refuse to build. Every run writes a log,
an exit-code file, and a state json next to it.

Usage:
  python3 scripts/xtrace_build_coordinator.py <out-dir> [target]
      [--profile interactive|idle] [--jobs N] [--load-limit N]
      [--gen-only] [--dry-run] [--ninja-bin PATH]

Test seams (env): XTRACE_BUILD_DISK_START_GIB / XTRACE_BUILD_DISK_STOP_GIB
override the disk gates; XTRACE_BUILD_SAMPLE_SECS shrinks the watchdog
interval; XTRACE_BUILD_LOCK_PATH relocates the lock.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "chromium/src"
TREE_NINJA = SRC / "third_party/ninja/ninja"

PROFILES = {
    "interactive": {"jobs": 2, "load": 3},
    "idle": {"jobs": 4, "load": 6},
}
DEFAULT_DISK_START_GIB = 60.0
DEFAULT_DISK_STOP_GIB = 30.0
TREE_RSS_BUDGET_GIB = 12.0
TREE_CPU_BUDGET_PERCENT = 350.0
TREE_CPU_SUSTAIN_SECS = 30.0


class Refused(SystemExit):
    """Startup refusal (exit code 3): nothing ran, nothing to clean."""

    def __init__(self, message: str):
        super().__init__(3)
        self.message = message
        print(message, file=sys.stderr)


def disk_free_gib(path: Path) -> float:
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize / (1 << 30)


def env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    return float(value) if value else default


def env_int(name: str) -> int:
    value = os.environ.get(name)
    return int(value) if value else 0


class Lock:
    """Project-wide exclusive build lock (O_EXCL create + liveness check)."""

    def __init__(self, path: Path):
        self.path = path
        self.held = False

    def acquire(self, payload: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                prior = json.loads(self.path.read_text())
            except (ValueError, OSError):
                prior = {}
            pid = prior.get("pid")
            alive = False
            if isinstance(pid, int):
                alive = Path(f"/proc/{pid}").exists() or (
                    subprocess.run(["kill", "-0", str(pid)],
                                   capture_output=True).returncode == 0)
            if alive:
                raise Refused(
                    f"another coordinator holds the build lock "
                    f"(pid {pid}, out {prior.get('out')}): {self.path}")
            # Stale holder (dead pid): verified, then replaced.
            self.path.unlink()
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w") as handle:
            json.dump(payload, handle, indent=1)
        self.held = True

    def release(self) -> None:
        if self.held:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            self.held = False


def tree_stats(pgid: int) -> tuple[float, float]:
    """Managed group's aggregated CPU% (single-core=100) and RSS KiB."""
    result = subprocess.run(
        ["ps", "-o", "pgid=,pcpu=,rss=", "-x"],
        capture_output=True, text=True)
    cpu = 0.0
    rss = 0
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) != 3:
            continue
        try:
            row_pgid = int(parts[0])
        except ValueError:
            continue
        if row_pgid == pgid:
            cpu += float(parts[1])
            rss += int(parts[2])
    return cpu, float(rss)


def memory_pressure_level() -> int:
    """macOS memorystatus level: 1 normal, 2 warning, 4 critical (0=unknown)."""
    result = subprocess.run(
        ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
        capture_output=True, text=True)
    try:
        return int(result.stdout.strip())
    except ValueError:
        return 0


def swap_used_gib() -> float:
    result = subprocess.run(["sysctl", "-n", "vm.swapusage"],
                            capture_output=True, text=True)
    for token in result.stdout.replace("=", " ").split():
        pass
    try:
        # "total = 1024.00M  used = 12.00M  free = 1012.00M"
        used = result.stdout.split("used =")[1].split()[0]
        value = float(used.rstrip("GM"))
        return value / 1024 if used.endswith("G") else value / (1 << 20)
    except (IndexError, ValueError):
        return -1.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("target", nargs="?", default="chrome")
    parser.add_argument("--profile", default="interactive",
                        choices=sorted(PROFILES))
    parser.add_argument("--jobs", type=int)
    parser.add_argument("--load-limit", type=int)
    parser.add_argument("--gen-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--ninja-bin", type=Path)
    args = parser.parse_args()

    if args.profile not in PROFILES:
        raise Refused(f"unknown profile {args.profile!r}")
    jobs = args.jobs if args.jobs is not None else PROFILES[args.profile]["jobs"]
    load = (args.load_limit if args.load_limit is not None
            else PROFILES[args.profile]["load"])
    if jobs <= 0:
        raise Refused(f"JOBS must be >= 1 (got {jobs}; 0 means unlimited in ninja)")
    if load <= 0:
        raise Refused(f"LOAD_LIMIT must be >= 1 (got {load})")

    ninja_bin = args.ninja_bin
    if ninja_bin is None:
        env_ninja = os.environ.get("NINJA_BIN", "").strip()
        ninja_bin = Path(env_ninja) if env_ninja else TREE_NINJA
    if shutil.which(str(ninja_bin)) is None and not ninja_bin.is_file():
        raise Refused(f"ninja binary not found: {ninja_bin}")
    out_dir = args.out_dir.resolve()
    if not out_dir.is_dir():
        raise Refused(f"out dir missing: {out_dir}")

    start_gate = env_float("XTRACE_BUILD_DISK_START_GIB",
                           DEFAULT_DISK_START_GIB)
    free = disk_free_gib(out_dir)
    if free < start_gate:
        raise Refused(
            f"disk gate: {free:.1f} GiB free < {start_gate:.0f} GiB required "
            f"on {out_dir}")

    validation = out_dir / "validation"
    validation.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log_path = validation / f"coordinator-{stamp}.log"
    state_path = validation / f"coordinator-{stamp}.state.json"
    lock_path = Path(os.environ.get("XTRACE_BUILD_LOCK_PATH") or
                     (SRC / "out/.xtrace-build-lock"))
    lock = Lock(lock_path)
    argv = ([str(ninja_bin), "-C", str(out_dir),
             "-j", str(jobs), "-l", str(load), "-k", "1"]
            + (["-n", "-d", "explain"] if args.dry_run else [])
            + (["-t", "commands", args.target] if args.gen_only
               else [args.target]))
    lock.acquire({"pid": os.getpid(), "out": str(out_dir),
                  "argv": argv, "started": time.time()})
    log = log_path.open("w")

    def emit(message: str) -> None:
        log.write(message + "\n")
        log.flush()
        print(message)

    emit(f"coordinator argv: {json.dumps(argv)}")
    emit(f"profile={args.profile} jobs={jobs} load={load} "
         f"disk_free={free:.1f}GiB lock={lock_path}")

    env = {k: v for k, v in os.environ.items()
           if k not in ("GOROOT", "GOTOOLDIR")}
    child = subprocess.Popen(
        argv, stdout=log, stderr=subprocess.STDOUT, env=env,
        start_new_session=True)  # own process group: we signal ONLY this
    pgid = child.pid
    stop_floor = env_float("XTRACE_BUILD_DISK_STOP_GIB", DEFAULT_DISK_STOP_GIB)
    sample_secs = max(1, env_int("XTRACE_BUILD_SAMPLE_SECS") or 5)
    stop_reason = None
    rss_over_since = None
    cpu_over_since = None
    swap_prev = swap_used_gib()

    def interrupt() -> None:
        try:
            os.killpg(pgid, signal.SIGINT)
        except ProcessLookupError:
            pass

    import threading
    done = threading.Event()

    def watchdog() -> None:
        nonlocal stop_reason, rss_over_since, cpu_over_since, swap_prev
        while not done.wait(sample_secs):
            free_now = disk_free_gib(out_dir)
            if free_now < stop_floor:
                stop_reason = (f"disk {free_now:.1f} GiB < {stop_floor:.0f} "
                               "GiB floor")
                emit(f"WATCHDOG STOP: {stop_reason}")
                interrupt()
                return
            level = memory_pressure_level()
            if level in (2, 4):
                stop_reason = f"memory pressure level {level} (warning/critical)"
                emit(f"WATCHDOG STOP: {stop_reason}")
                interrupt()
                return
            cpu, rss_kib = tree_stats(pgid)
            rss_gib = rss_kib / (1 << 20)
            if rss_gib > TREE_RSS_BUDGET_GIB:
                if rss_over_since is None:
                    rss_over_since = time.time()
                elif time.time() - rss_over_since >= sample_secs * 2:
                    stop_reason = (f"managed tree RSS {rss_gib:.1f} GiB > "
                                   f"{TREE_RSS_BUDGET_GIB:.0f} GiB twice")
                    emit(f"WATCHDOG STOP: {stop_reason}")
                    interrupt()
                    return
            else:
                rss_over_since = None
            if cpu > TREE_CPU_BUDGET_PERCENT:
                if cpu_over_since is None:
                    cpu_over_since = time.time()
                elif time.time() - cpu_over_since >= TREE_CPU_SUSTAIN_SECS:
                    stop_reason = (f"managed tree CPU {cpu:.0f}% > "
                                   f"{TREE_CPU_BUDGET_PERCENT:.0f}% for "
                                   f"{TREE_CPU_SUSTAIN_SECS:.0f}s")
                    emit(f"WATCHDOG STOP: {stop_reason}")
                    interrupt()
                    return
            else:
                cpu_over_since = None
            swap_now = swap_used_gib()
            if swap_prev >= 0 and swap_now > swap_prev + 1.0:
                emit(f"WATCHDOG NOTE: swap +{swap_now - swap_prev:.1f} GiB "
                     f"in window ({swap_now:.1f} GiB total)")
            swap_prev = swap_now
            emit(f"sample: disk={free_now:.1f}GiB cpu={cpu:.0f}% "
                 f"rss={rss_gib:.1f}GiB")

    watcher = threading.Thread(target=watchdog, daemon=True)
    watcher.start()
    try:
        exit_code = child.wait()
    finally:
        done.set()
        watcher.join(timeout=2 * sample_secs)
        # Group cleanup: SIGINT did not finish every descendant.
        try:
            os.killpg(pgid, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if stop_reason:
        exit_reason = f"watchdog: {stop_reason}"
    elif exit_code == 0:
        exit_reason = "success"
    elif exit_code == -signal.SIGINT:
        exit_reason = "interrupted (SIGINT; incremental state preserved)"
    else:
        exit_reason = f"ninja exit {exit_code}"
    lock.release()
    state = {"argv": argv, "profile": args.profile, "jobs": jobs,
             "load": load, "exit_code": exit_code,
             "exit_reason": exit_reason, "log": str(log_path),
             "lock_released": not lock_path.exists(),
             "ts": time.time()}
    state_path.write_text(json.dumps(state, indent=1))
    emit(f"exit_code={exit_code} reason={exit_reason} "
         f"lock_released={state['lock_released']}")
    log.close()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
