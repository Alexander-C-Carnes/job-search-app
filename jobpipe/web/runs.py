"""Run pipeline commands (`python -m jobpipe ...`) in the background and keep their output.

Up to MAX_RUNS at once, so several jobs can be tailored side by side. Runs that would collide
share a `key` and wait for each other: searches (they spend JobsPipe credits and write the day's
digest) go one at a time, and a job is never tailored by two runs at once. Each run is told its id
(JOBPIPE_RUN_ID), and the store marks the jobs it changes with it, so a run's results are its own.

Given a database (the app uses data/tracker.db), each run and every line it prints are saved
as they happen, so the Runs tab keeps its history when the app restarts. A run the app was
closed during shows as interrupted.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .. import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL, args TEXT NOT NULL,   -- args: the command's arguments, as JSON
  started TEXT NOT NULL, finished TEXT, returncode INTEGER,
  marks TEXT,     -- JSON: each job's scoring fields when the run started, to find what it changed
  results TEXT    -- JSON: the jobs it scored or tailored, once worked out
);
CREATE TABLE IF NOT EXISTS run_lines (
  run_id INTEGER NOT NULL, n INTEGER NOT NULL, line TEXT NOT NULL,
  at REAL,        -- when it was printed (Unix time), to learn how long each step of a run takes
  PRIMARY KEY (run_id, n)
);
"""


MAX_RUNS = 3   # each tailoring run makes ~11 Claude calls; more at once mostly queues on usage limits


class Busy(RuntimeError):
    pass


@dataclass
class Run:
    id: int
    label: str
    args: list[str]
    started: str
    lines: list[str] = field(default_factory=list)
    line_at: list[Optional[float]] = field(default_factory=list)   # when each line was printed (None before lines had times)
    returncode: Optional[int] = None
    finished: Optional[str] = None
    proc: Optional[subprocess.Popen] = None
    marks: Optional[dict[str, Any]] = None
    results: Optional[list[dict]] = None
    key: Optional[str] = None   # runs with the same key don't overlap (not saved: only running runs need it)

    @property
    def status(self) -> str:
        if self.returncode is None:
            return "running" if self.proc else "interrupted"   # no process: loaded after the app restarted
        return "done" if self.returncode == 0 else ("stopped" if self.returncode < 0 else "failed")

    def public(self, since: int = 0) -> dict:
        return {"id": self.id, "label": self.label, "args": self.args, "started": self.started,
                "finished": self.finished, "status": self.status, "returncode": self.returncode,
                "lines": self.lines[since:], "line_count": len(self.lines)}


class RunManager:
    def __init__(self, argv_prefix: Optional[list[str]] = None, cwd: Optional[Path] = None,
                 db: Optional[Path] = None, max_runs: int = MAX_RUNS):
        self.argv_prefix = argv_prefix or [sys.executable, "-m", "jobpipe"]
        self.max_runs = max_runs
        self.cwd = cwd or config.ROOT
        self.db = db
        self.runs: dict[int, Run] = {}
        self.lock = threading.Lock()
        self._next = 1
        if db is not None:
            db.parent.mkdir(parents=True, exist_ok=True)
            with closing(self._db()) as con, con:
                con.executescript(SCHEMA)
                if "at" not in {c["name"] for c in con.execute("PRAGMA table_info(run_lines)")}:
                    con.execute("ALTER TABLE run_lines ADD COLUMN at REAL")   # a database from before lines had times
            self._load()

    def _db(self) -> sqlite3.Connection:
        assert self.db is not None
        con = sqlite3.connect(self.db, timeout=30)
        con.row_factory = sqlite3.Row
        return con

    def _load(self) -> None:
        with closing(self._db()) as con:
            for r in con.execute("SELECT * FROM runs ORDER BY id"):
                self.runs[r["id"]] = Run(r["id"], r["label"], json.loads(r["args"]), r["started"],
                                         returncode=r["returncode"], finished=r["finished"],
                                         marks=json.loads(r["marks"]) if r["marks"] else None,
                                         results=json.loads(r["results"]) if r["results"] else None)
            for r in con.execute("SELECT run_id, line, at FROM run_lines ORDER BY run_id, n"):
                self.runs[r["run_id"]].lines.append(r["line"])
                self.runs[r["run_id"]].line_at.append(r["at"])
        self._next = max(self.runs, default=0) + 1

    def running(self) -> list[Run]:
        return [r for r in self.runs.values() if r.status == "running"]

    def active(self) -> Optional[Run]:
        return next(iter(self.running()), None)

    def start(self, label: str, args: list[str], marks: Optional[dict[str, Any]] = None,
              key: Optional[str] = None, busy: str = "") -> Run:
        """marks: anything the caller needs later to see what the run changed; saved with it.
        key: a run with the same key still going makes this one Busy, with the message `busy`."""
        with self.lock:
            going = self.running()
            if key and any(r.key == key for r in going):
                raise Busy(busy or "That run is already going.")
            if len(going) >= self.max_runs:
                raise Busy(f"{len(going)} runs are going, the most at once. Start this when one finishes.")
            run = Run(self._next, label, args, datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      marks=marks, key=key)
            self._next += 1
            # Unbuffered, so the Runs tab shows each line as it's printed rather than all of it at the end.
            run.proc = subprocess.Popen([*self.argv_prefix, *args], cwd=self.cwd, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True, bufsize=1,
                                        env={**os.environ, "PYTHONUNBUFFERED": "1", "JOBPIPE_RUN_ID": str(run.id)})
            self.runs[run.id] = run
            if self.db is not None:
                with closing(self._db()) as con, con:
                    con.execute("INSERT INTO runs(id, label, args, started, marks) VALUES(?, ?, ?, ?, ?)",
                                (run.id, label, json.dumps(args), run.started,
                                 json.dumps(marks) if marks is not None else None))
        threading.Thread(target=self._pump, args=(run,), daemon=True).start()
        return run

    def _pump(self, run: Run) -> None:
        assert run.proc and run.proc.stdout
        con = self._db() if self.db is not None else None
        try:
            for line in run.proc.stdout:
                line, at = line.rstrip("\n"), time.time()
                if con is not None:   # saved before it's shown, so a line the UI has seen is never lost
                    with con:
                        con.execute("INSERT INTO run_lines(run_id, n, line, at) VALUES(?, ?, ?, ?)", (run.id, len(run.lines), line, at))
                run.line_at.append(at)
                run.lines.append(line)
            returncode = run.proc.wait()
            finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
            if con is not None:
                with con:
                    con.execute("UPDATE runs SET returncode = ?, finished = ? WHERE id = ?", (returncode, finished, run.id))
            run.finished, run.returncode = finished, returncode
        finally:
            if con is not None:
                con.close()

    def save_results(self, run: Run, results: list[dict]) -> None:
        run.results = results
        if self.db is not None:
            with closing(self._db()) as con, con:
                con.execute("UPDATE runs SET results = ? WHERE id = ?", (json.dumps(results), run.id))

    def stop(self, run_id: int) -> Run:
        run = self.runs[run_id]
        if run.proc and run.status == "running":
            run.proc.terminate()
        return run

    def wait(self, run_id: int, timeout: float = 30) -> Run:
        run = self.runs[run_id]
        if run.proc:
            run.proc.wait(timeout)
        for _ in range(100):  # let the reader thread drain the pipe
            if run.returncode is not None:
                break
            threading.Event().wait(0.02)
        return run
