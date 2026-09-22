#!/usr/bin/env python3
"""XTrace patch-stack verification (P4-F6, hardened N4/review R7).

Portable regression for the review's evidence-check logic: applies the
tracked patch stack to a CLEAN index from each tree's HEAD, compares
every changed file byte-for-byte against the installed working tree,
detects OUT-OF-MANIFEST drift (worktree files that differ from the
patched index beyond the stack's own file list), pins both source HEADs
to the frozen baselines, and emits a machine-readable digest binding.

Fail-closed: every git invocation's return code is checked; a missing
file is a mismatch (never confused with an empty blob); a requested
dylib that is absent is an error, not a skip.

Read-only: uses a temporary GIT_INDEX_FILE; the real index, the source
trees and the patches are never modified.

Usage:
  python3 scripts/verify_patches.py [--out evidence.json]
                                    [--with-dylibs out/XTraceIntegration]
Exit code 0 iff both stacks replay with zero mismatches, no drift, and
both HEADs match the pinned baselines.
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
PINNED_HEADS = {
    "chromium": "73088b4e50b1dc69eaa0bdb14a8e4592813174fd",
    "v8": "af6aa2ec5047676cfb3150b46449faac7578be7e",
}
COMPONENT_DYLIBS = [
    "libchrome_dll.dylib",
    "libv8.dylib",
    "libcontent.dylib",
    "libblink_core.dylib",
    "libblink_platform.dylib",
    "libblink_modules.dylib",
]


class VerificationError(SystemExit):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def replay_tree(tree: Path, patch_names: list[str], pinned_head: str) -> dict:
    patches = [ROOT / "patches" / name for name in patch_names]
    with tempfile.TemporaryDirectory(prefix="xtrace-verify-") as tmp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "index"))

        def git(*args: str) -> str:
            result = subprocess.run(
                ["git", "-C", str(tree), *args], env=env,
                capture_output=True, text=True)
            if result.returncode != 0:
                raise VerificationError(
                    f"git {' '.join(args)} failed ({result.returncode}): "
                    f"{result.stderr.strip()}")
            return result.stdout

        def git_bytes(*args: str) -> bytes:
            result = subprocess.run(
                ["git", "-C", str(tree), *args], env=env,
                capture_output=True)
            if result.returncode != 0:
                raise VerificationError(
                    f"git {' '.join(args)} failed ({result.returncode})")
            return result.stdout

        head = git("rev-parse", "HEAD").strip()
        git("read-tree", "HEAD")
        for patch in patches:
            git("apply", "--cached", "--check", str(patch))
            git("apply", "--cached", str(patch))
        listing = git("diff", "--cached", "--name-only", "-z")
        changed = listing.split("\0")[:-1]
        mismatches = []
        for name in changed:
            blob = git_bytes("show", ":" + name)
            disk_path = tree / name
            if not disk_path.is_file():
                # Missing file is a mismatch — never conflated with an
                # empty blob (review R7).
                mismatches.append(f"{name} (missing from worktree)")
                continue
            if blob != disk_path.read_bytes():
                mismatches.append(name)
        # Out-of-manifest drift: files that differ from the patched index
        # but are NOT part of the stack's own file list.
        drift = []
        status = git("status", "--porcelain", "--untracked-files=no")
        for line in status.splitlines():
            if not line.startswith((" M", "M ", " D", "D ", "C ", " T")):
                continue
            name = line[3:].strip().strip('"')
            if name not in changed:
                drift.append(name)
        tree_hash = git("write-tree").strip()
        return {
            "head": head,
            "head_matches_pin": head == pinned_head,
            "patches": patch_names,
            "files": len(changed),
            "mismatches": mismatches,
            "out_of_manifest_drift": sorted(set(drift)),
            "tree": tree_hash,
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
        "chromium": replay_tree(
            ROOT / "chromium/src", CHROMIUM_STACK, PINNED_HEADS["chromium"]),
        "v8": replay_tree(
            ROOT / "chromium/src/v8", V8_STACK, PINNED_HEADS["v8"]),
        "patch_sha256": {
            p.name: sha256_file(p)
            for p in sorted((ROOT / "patches").glob("*.patch"))
        },
    }
    if args.with_dylibs:
        bound = {}
        missing = []
        for name in COMPONENT_DYLIBS:
            path = args.with_dylibs / name
            if path.is_file():
                bound[name] = sha256_file(path)
            else:
                missing.append(name)
        if missing:
            # Requested digests must exist — silence is how the empty
            # releaseVariant object happened (review R7).
            raise VerificationError(
                f"--with-dylibs: missing {missing} in {args.with_dylibs}")
        report["component_dylibs"] = bound
    ok = (
        not report["chromium"]["mismatches"]
        and not report["v8"]["mismatches"]
        and not report["chromium"]["out_of_manifest_drift"]
        and not report["v8"]["out_of_manifest_drift"]
        and report["chromium"]["head_matches_pin"]
        and report["v8"]["head_matches_pin"]
    )
    report["verdict"] = "pass" if ok else "fail"

    text = json.dumps(report, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n")
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
