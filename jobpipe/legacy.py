"""Copy a pre-profile checkout's personal files into the profile folder.

Before profiles, everything personal lived in the repo: searches.yaml and .env at the top, the impact
record, résumés and confirmed notes in skill/references, skill runs in resume-runs/, and data/ and
outputs/. move() copies them to the profile folder without overwriting anything there, and rewrites the
absolute paths stored in data/ (and outputs/' JSON) so they point at the new folders. The originals stay
where they were, so nothing is lost if something goes wrong; delete them from the repo once the app
works from the profile.

    python -m jobpipe.legacy [OLD_CHECKOUT]     # default: this repo
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import sys
from pathlib import Path

from . import config

METHOD_FILES = ("resume-rules.md", "scoring-and-report.md")   # skill/references files that are the method, not yours
TEXT = (".json", ".md", ".txt", ".html")


def found(root: Path) -> bool:
    """The checkout still has someone's searches.yaml or impact record in it."""
    return (root / "searches.yaml").is_file() or (root / "skill" / "references" / "impact-record.md").is_file()


def _copy(src: Path, dst: Path, log) -> None:
    if not src.exists():
        return
    if src.is_dir():
        for f in sorted(src.rglob("*")):
            if f.is_file():
                _copy(f, dst / f.relative_to(src), log)
        return
    if dst.exists():
        log(f"  kept {dst} (already there)")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _rewrite(text: str, swaps: list[tuple[str, str]]) -> str:
    for old, new in swaps:
        text = text.replace(old, new)
    return text


def _rewrite_db(db: Path, swaps: list[tuple[str, str]]) -> None:
    con = sqlite3.connect(db)
    try:
        for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            cols = [r[1] for r in con.execute(f'PRAGMA table_info("{table}")')]
            for col in cols:
                for old, new in swaps:
                    con.execute(f'UPDATE "{table}" SET "{col}" = REPLACE("{col}", ?, ?) '
                                f'WHERE typeof("{col}") = \'text\' AND instr("{col}", ?) > 0', (old, new, old))
        con.commit()
    finally:
        con.close()


def move(root: Path, profile: Path, log=print) -> None:
    root, profile = Path(root).resolve(), Path(profile).expanduser()
    data, outputs = config._env_path("JOBPIPE_DATA_DIR", profile / "data"), config._env_path("JOBPIPE_OUTPUTS_DIR", profile / "outputs")
    log(f"Copying your files from {root} to your profile folder, {profile}:")
    profile.mkdir(parents=True, exist_ok=True)
    _copy(root / "searches.yaml", profile / "searches.yaml", log)
    if (root / ".env").exists() and not (profile / ".env").exists():
        _copy(root / ".env", profile / ".env", log)
        os.chmod(profile / ".env", 0o600)
    for f in sorted((root / "skill" / "references").glob("*")):
        if f.is_file() and f.name not in METHOD_FILES:
            _copy(f, profile / "references" / f.name, log)
    _copy(root / "skill" / "examples", profile / "examples", log)
    _copy(root / "resume-runs", profile / "resume-runs", log)
    _copy(root / "data", data, log)
    _copy(root / "outputs", outputs, log)
    if not (profile / ".env").exists():
        shutil.copy(config.ROOT / ".env.example", profile / ".env")
        os.chmod(profile / ".env", 0o600)

    # The app stores absolute paths (a job's résumé PDF, its run folder): point them at the new folders.
    swaps = [(f"{root}/outputs/", f"{outputs}/"), (f"{root}/data/", f"{data}/"),
             (f"{root}/resume-runs/", f"{profile / 'resume-runs'}/")]
    for folder, suffixes in ((data, TEXT), (outputs, (".json",))):
        for f in folder.rglob("*") if folder.exists() else ():
            if f.is_file() and f.suffix in suffixes:
                text = f.read_text(errors="surrogateescape")
                new = _rewrite(text, swaps)
                if new != text:
                    f.write_text(new, errors="surrogateescape")
    for db in data.glob("*.db") if data.exists() else ():
        _rewrite_db(db, swaps)
    log(f"Done. The app now reads and writes {profile}. The originals are still in {root}; "
        f"delete them from there once everything looks right.")


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else config.ROOT
    if not found(src):
        sys.exit(f"No searches.yaml or skill/references/impact-record.md in {src}: nothing to move.")
    move(src, config.PROFILE)
