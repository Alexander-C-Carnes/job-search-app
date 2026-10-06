"""Local state under data/: fetched jobs, triage results, and the JobsPipe credit ledger.

Everything is plain JSON so it can be inspected or edited by hand.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

from . import config

try:
    import fcntl
except ImportError:  # Windows: no advisory locks; the read-modify-write below is then unguarded
    fcntl = None


def _read(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def _write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True, default=str))
    tmp.replace(path)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def month_key(ts: Optional[datetime] = None) -> str:
    return (ts or datetime.now(timezone.utc)).strftime("%Y-%m")


def canonical_url(url: Optional[str]) -> str:
    """Drop query string and fragment (utm_*, gh_src, ...) so the same posting compares equal."""
    if not url:
        return ""
    p = urlsplit(url.strip())
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), "", ""))


def slug(*parts: str, max_len: int = 60) -> str:
    s = "-".join(p for p in parts if p)
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s[:max_len].rstrip("-") or "job"


class Store:
    def __init__(self, root: Optional[Path] = None):
        self.root = root or config.DATA
        self.jobs_dir = self.root / "jobs"
        self.state_path = self.root / "state.json"
        self.credits_path = self.root / "credits.json"

    @contextmanager
    def _locked(self):
        """Hold data/.lock while state.json is read, changed and written back: a pipeline run
        and the web app (scoring a job) are separate processes updating the same file."""
        self.root.mkdir(parents=True, exist_ok=True)
        with open(self.root / ".lock", "w") as f:
            if fcntl:
                fcntl.flock(f, fcntl.LOCK_EX)
            yield

    @contextmanager
    def tailoring(self, jid: str):
        """Yields False if another process is tailoring this job (they'd write the same folder),
        otherwise True, holding data/tailoring/<id>.lock until the block ends."""
        d = self.root / "tailoring"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f"{slug(jid)}.lock", "w") as f:
            if fcntl:
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    yield False
                    return
            yield True

    # ---- jobs -------------------------------------------------------------
    def save_job(self, job: dict, search_id: str) -> bool:
        """Store a job from a search. Returns True if it is new. A description you pasted is kept
        when a search finds the job again."""
        jid = str(job["id"])
        path = self.jobs_dir / f"{jid}.json"
        is_new = not path.exists()
        old = {} if is_new else self.job(jid)
        if old.get("description_pasted") and not job.get("description_pasted"):
            job = {**job, **{k: old[k] for k in ("description", "description_pasted", "description_read", "description_before_paste") if k in old}}
        _write(path, job)
        with self._locked():
            state = self.state()
            entry = state.setdefault(jid, {"first_seen": now_iso(), "searches": []})
            if search_id not in entry["searches"]:
                entry["searches"].append(search_id)
            entry["last_seen"] = now_iso()
            self._save_state(state)
        return is_new

    def job(self, jid: str) -> dict:
        return _read(self.jobs_dir / f"{jid}.json", None) or {}

    def paste_description(self, jid: str, text: str) -> None:
        """Keep the posting text you pasted for a stored job; scoring and tailoring read it first.
        The text it replaces is kept beside it."""
        job = self.job(jid)
        if not job.get("description_pasted"):
            job["description_before_paste"] = job.get("description") or ""
        job.update(description=text, description_pasted=now_iso(), description_read=False)
        _write(self.jobs_dir / f"{jid}.json", job)

    def state(self) -> dict:
        return _read(self.state_path, {})

    def _save_state(self, state: dict) -> None:
        _write(self.state_path, state)

    def update(self, jid: str, **fields: Any) -> None:
        """Records the web-app run making the change as the job's `last_run`; a change made outside
        any run (the app's own scoring, the terminal) clears it, so no run claims that change."""
        run_id = os.environ.get("JOBPIPE_RUN_ID")
        fields["last_run"] = int(run_id) if run_id else None
        with self._locked():
            state = self.state()
            state.setdefault(jid, {"first_seen": now_iso(), "searches": []}).update(fields)
            self._save_state(state)

    # ---- credits ----------------------------------------------------------
    def credits(self) -> dict:
        return _read(self.credits_path, {"lifetime": 0, "months": {}, "calls": []})

    def record_call(self, *, search_id: str, body: dict, charged: Optional[int], returned: int,
                    already_paid: Optional[int], status: str) -> None:
        with self._locked():   # a search in the terminal and one in the app may both be charging
            self._record_call(search_id=search_id, body=body, charged=charged, returned=returned,
                              already_paid=already_paid, status=status)

    def _record_call(self, *, search_id: str, body: dict, charged: Optional[int], returned: int,
                     already_paid: Optional[int], status: str) -> None:
        c = self.credits()
        # If the API did not report the charge, assume the worst case (every returned job was new).
        charge = charged if charged is not None else returned
        c["lifetime"] = c.get("lifetime", 0) + charge
        m = month_key()
        c.setdefault("months", {})[m] = c["months"].get(m, 0) + charge
        c.setdefault("calls", []).append({
            "at": now_iso(), "search": search_id, "status": status, "returned": returned,
            "credits_charged": charged, "jobs_already_paid": already_paid,
            "counted": charge, "body": body,
        })
        c["calls"] = c["calls"][-500:]
        _write(self.credits_path, c)

    def credits_used(self, period: str) -> int:
        c = self.credits()
        if period == "monthly":
            return c.get("months", {}).get(month_key(), 0)
        return c.get("lifetime", 0)
