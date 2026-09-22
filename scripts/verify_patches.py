#!/usr/bin/env python3
"""XTrace patch-stack verification (P4-F6, handoff §10.7).

Portable regression for the review's evidence-check logic (replaces the
ad-hoc session scripts): applies the tracked patch stack to a CLEAN index
from each tree's pinned HEAD, compares every changed file byte-for-byte
against the installed working tree, and emits a machine-readable digest
binding (patch SHA-256s; optional component dylibs).

Read-only: uses a temporary GIT_INDEX_FILE; the real index, the source
trees and the patches are never modified.

Usage:
  python3 scripts/verify_patches.py [--out evidence.json]
                                    [--with-dylibs out/XTraceIntegration]
Exit code 0 iff both stacks replay with zero mismatches.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHROMIUM_STACK = [
    "0001-xtrace-native-logger.patch",
    "0003-xtrace-schema-v2-renderer.patch",
    "0004-xtrace-schema-v2-browser.patch",
    "0005-chromiumx-naming.patch",
]
V8_STACK = ["0002-xtrace-v8-vmp-hooks.patch"]
COMPONENT_DYLIBS = [
    "libchrome_dll.dylib",
    "libv8.dylib",
    "libcontent.dylib",
    "libblink_core.dylib",
    "libblink_platform.dylib",
    "libblink_modules.dylib",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def replay_tree(tree: Path, patch_names: list[str]) -> dict:
    patches = [ROOT / "patches" / name for name in patch_names]
    with tempfile.TemporaryDirectory(prefix="xtrace-verify-") as tmp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "index"))

        def git(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(
                ["git", "-C", str(tree), *args], env=env,
                capture_output=True, text=True)

        result = git("read-tree", "HEAD")
        if result.returncode:
            raise SystemExit(f"read-tree failed: {result.stderr}")
        for patch in patches:
            check = git("apply", "--cached", "--check", str(patch))
            if check.returncode:
                raise SystemExit(
                    f"{patch.name} does not apply cleanly on {tree}: "
                    f"{check.stderr}")
            applied = git("apply", "--cached", str(patch))
            if applied.returncode:
                raise SystemExit(f"apply failed: {applied.stderr}")
        listing = git("diff", "--cached", "--name-only", "-z")
        changed = listing.stdout.split("\0")[:-1]
        mismatches = []
        for name in changed:
            blob = subprocess.run(
                ["git", "-C", str(tree), "show", ":" + name], env=env,
                capture_output=True).stdout
            disk = (tree / name).read_bytes() if (tree / name).is_file() else b""
            if blob != disk:
                mismatches.append(name)
        tree_hash = git("write-tree")
        head = subprocess.run(
            ["git", "-C", str(tree), "rev-parse", "HEAD"],
            capture_output=True, text=True).stdout.strip()
        return {
            "head": head,
            "patches": patch_names,
            "files": len(changed),
            "mismatches": mismatches,
            "tree": tree_hash.stdout.strip(),
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=None,
                        help="write the JSON report here")
    parser.add_argument("--with-dylibs", type=Path, default=None,
                        help="also bind component dylib digests from this out dir")
    args = parser.parse_args()

    report = {
        "tool": "scripts/verify_patches.py",
        "chromium": replay_tree(ROOT / "chromium/src", CHROMIUM_STACK),
        "v8": replay_tree(ROOT / "chromium/src/v8", V8_STACK),
        "patch_sha256": {
            p.name: sha256_file(p)
            for p in sorted((ROOT / "patches").glob("*.patch"))
        },
    }
    if args.with_dylibs:
        report["component_dylibs"] = {
            name: sha256_file(args.with_dylibs / name)
            for name in COMPONENT_DYLIBS
            if (args.with_dylibs / name).is_file()
        }
    ok = (not report["chromium"]["mismatches"]
          and not report["v8"]["mismatches"])
    report["verdict"] = "pass" if ok else "fail"

    text = json.dumps(report, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n")
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
