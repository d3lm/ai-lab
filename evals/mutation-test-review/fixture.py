"""Builds a throwaway git repo for one eval case.

A case lives in cases/<id>/ as:
  case.json   metadata and the answer key (never copied into the fixture)
  base/       files of the initial commit on `main`
  head/       files overlaid for the change under review
The change is committed on a `feature` branch (mode "branch") or left
uncommitted on `main` (mode "uncommitted").
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
CASES_DIR = EVAL_DIR / "cases"
REPO_ROOT = EVAL_DIR.parent.parent
DEFAULT_SKILL_DIR = REPO_ROOT / "skills" / "mutation-test-review"
NODE_TEMPLATE = EVAL_DIR / ".cache" / "node-template"

GIT_ENV = {
  "GIT_AUTHOR_NAME": "Fixture Dev",
  "GIT_AUTHOR_EMAIL": "dev@example.com",
  "GIT_COMMITTER_NAME": "Fixture Dev",
  "GIT_COMMITTER_EMAIL": "dev@example.com",
}


def list_cases() -> list[str]:
  return sorted(path.name for path in CASES_DIR.iterdir() if (path / "case.json").is_file())


def load_case(case_id: str) -> dict:
  case = json.loads((CASES_DIR / case_id / "case.json").read_text())
  case["id"] = case_id

  return case


def git(cwd: Path, *args: str, date: str | None = None) -> str:
  env = {**os.environ, **GIT_ENV}

  if date:
    env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = date

  result = subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True)

  return result.stdout


def _overlay(src: Path, dest: Path) -> None:
  for path in sorted(src.rglob("*")):
    if path.is_file():
      target = dest / path.relative_to(src)
      target.parent.mkdir(parents=True, exist_ok=True)
      shutil.copy2(path, target)


def _write_ts_lockfile(dest: Path) -> None:
  """`dest` is the directory holding the package's package.json."""
  package = json.loads((dest / "package.json").read_text())
  lockfile = json.loads((NODE_TEMPLATE / "package-lock.json").read_text())

  lockfile["name"] = package["name"]
  lockfile["packages"][""]["name"] = package["name"]

  (dest / "package-lock.json").write_text(json.dumps(lockfile, indent=2) + "\n")


def _install_skill(dest: Path, skill_dir: Path) -> None:
  target = dest / ".claude" / "skills" / "mutation-test-review"
  ignore = shutil.ignore_patterns("__pycache__", "*.pyc", "evals")
  shutil.copytree(skill_dir, target, ignore=ignore)

  with open(dest / ".git" / "info" / "exclude", "a") as exclude_file:
    exclude_file.write(".claude/\n")


def build(
  case_id: str,
  dest: Path,
  skill_dir: Path | None = DEFAULT_SKILL_DIR,
  node_modules: bool = True,
) -> dict:
  """Create the fixture repo at `dest` (must not exist). Returns the case."""
  case = load_case(case_id)
  case_dir = CASES_DIR / case_id
  dest.mkdir(parents=True)

  _overlay(case_dir / "base", dest)
  pkg_dir = dest / case.get("pkg", ".")

  if case["lang"] == "ts":
    _write_ts_lockfile(pkg_dir)

  base_message = case.get("base_message", "initial commit")

  git(dest, "init", "-q", "-b", "main")
  git(dest, "add", "-A")
  git(dest, "commit", "-q", "-m", base_message, date="2026-09-01T10:00:00Z")

  if case["mode"] == "branch":
    git(dest, "checkout", "-q", "-b", "feature")
    _overlay(case_dir / "head", dest)

    for rel in case.get("delete", []):
      (dest / rel).unlink()

    git(dest, "add", "-A")
    git(
      dest,
      "commit",
      "-q",
      "-m",
      case["commit_message"],
      date="2026-09-02T10:00:00Z",
    )
  elif case["mode"] == "uncommitted":
    _overlay(case_dir / "head", dest)

    for rel in case.get("delete", []):
      (dest / rel).unlink()
  else:
    raise ValueError(f"unknown mode {case['mode']!r}")

  if case["lang"] == "ts" and node_modules:
    subprocess.run(
      [
        "cp",
        "-cR",
        str(NODE_TEMPLATE / "node_modules"),
        str(pkg_dir / "node_modules"),
      ],
      check=True,
    )

  if skill_dir is not None:
    _install_skill(dest, skill_dir)

  return case


def snapshot(repo: Path) -> dict:
  """State of the repo that the skill must leave unchanged."""

  def run(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=False, capture_output=True, text=True).stdout

  tracked_diff = run("diff", "HEAD", "--binary")
  shasum = subprocess.run(["shasum"], input=tracked_diff, check=True, capture_output=True, text=True)
  diff_sha = shasum.stdout.split()[0]

  ignored_status = run("status", "--porcelain=v1", "--ignored", "--untracked-files=normal")

  return {
    "head": run("rev-parse", "HEAD").strip(),
    "branch": run("symbolic-ref", "--short", "HEAD").strip(),
    "status": run("status", "--porcelain=v1", "--untracked-files=all"),
    "diff_sha": diff_sha,
    "stash": run("stash", "list"),
    "worktrees": run("worktree", "list", "--porcelain").count("worktree "),
    "branches": run("branch", "--format=%(refname:short) %(objectname)"),
    "ignored": sorted(line[3:] for line in ignored_status.splitlines() if line.startswith("!! ")),
  }


if __name__ == "__main__":
  import argparse

  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("case")
  parser.add_argument("dest", type=Path)
  parser.add_argument("--no-skill", action="store_true")
  args = parser.parse_args()

  build(args.case, args.dest, None if args.no_skill else DEFAULT_SKILL_DIR)
  print(args.dest)
