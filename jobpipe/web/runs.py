"""Run pipeline commands (`python -m jobpipe ...`) in the background and keep their output.

Up to MAX_RUNS at once, so several jobs can be tailored side by side. A run started with queue=True
when that many are going (Make résumé) waits its turn instead of being refused, and starts by itself
when one finishes; a waiting run exists only in memory until it starts. Runs that would collide
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
    queued: bool = False        # waiting for a free slot; started by the manager when one opens

    @property
    def status(self) -> str:
        if self.queued:
            return "queued"
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
        self.waiting: list[Run] = []     # queued runs, first in first out
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

    def start(self, label: str, args: list[str], marks: Any = None,
              key: Optional[str] = None, busy: str = "", queue: bool = False) -> Run:
        """marks: anything the caller needs later to see what the run changed; saved with it. A callable is
        called when the run starts, so a queued run marks the state it starts from.
        key: a run with the same key going or waiting makes this one Busy, with the message `busy`.
        queue: when MAX_RUNS are going, wait for a free slot (status "queued") instead of raising Busy."""
        with self.lock:
            going = self.running()
            if key and any(r.key == key for r in (*going, *self.waiting)):
                raise Busy(busy or "That run is already going.")
            if len(going) >= self.max_runs and not queue:
                raise Busy(f"{len(going)} runs are going, the most at once. Start this when one finishes.")
            run = Run(self._next, label, args, datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      marks=marks, key=key)
            self._next += 1
            if len(going) >= self.max_runs or self.waiting:     # behind the runs already waiting, too
                run.queued = True
                self.waiting.append(run)
            else:
                self._launch(run)
            self.runs[run.id] = run
        return run

    def _launch(self, run: Run) -> None:
        """Start the run's process (with the lock held)."""
        run.started = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if callable(run.marks):
            run.marks = run.marks()
        # Unbuffered, so the Runs tab shows each line as it's printed rather than all of it at the end.
        run.proc = subprocess.Popen([*self.argv_prefix, *run.args], cwd=self.cwd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1,
                                    env={**os.environ, "PYTHONUNBUFFERED": "1", "JOBPIPE_RUN_ID": str(run.id)})
        run.queued = False         # only now: with no process yet it would read as interrupted
        if self.db is not None:
            with closing(self._db()) as con, con:
                con.execute("INSERT INTO runs(id, label, args, started, marks) VALUES(?, ?, ?, ?, ?)",
                            (run.id, run.label, json.dumps(run.args), run.started,
                             json.dumps(run.marks) if run.marks is not None else None))
        threading.Thread(target=self._pump, args=(run,), daemon=True).start()

    def _start_waiting(self) -> None:
        """Start queued runs while there are free slots."""
        with self.lock:
            while self.waiting and len(self.running()) < self.max_runs:
                run = self.waiting.pop(0)
                try:
                    self._launch(run)
                except Exception as e:  # noqa: BLE001 - a run that can't start fails; the next one still gets its turn
                    run.lines.append(f"Couldn't start: {e}")
                    run.returncode, run.finished = 1, datetime.now(timezone.utc).isoformat(timespec="seconds")

    def queue_position(self, run: Run) -> Optional[int]:
        """1 for the next queued run to start, None when it isn't waiting."""
        return self.waiting.index(run) + 1 if run in self.waiting else None

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
            self._start_waiting()      # its slot is free

    def save_results(self, run: Run, results: list[dict]) -> None:
        run.results = results
        if self.db is not None:
            with closing(self._db()) as con, con:
                con.execute("UPDATE runs SET results = ? WHERE id = ?", (json.dumps(results), run.id))

    def stop(self, run_id: int) -> Run:
        run = self.runs[run_id]
        with self.lock:
            if run.queued:             # never started: it leaves the queue, and nothing was saved
                self.waiting.remove(run)
                run.queued = False
                run.returncode, run.finished = -15, datetime.now(timezone.utc).isoformat(timespec="seconds")
                return run
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
