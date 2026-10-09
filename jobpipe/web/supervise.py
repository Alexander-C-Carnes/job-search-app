"""Run one of the app's runs apart from the app, so that restarting the app doesn't cut it short.

    python -m jobpipe.web.supervise <nonce> <database> <run id> -- <command…>

The app (runs.py) starts this in a session of its own, with nothing tying it to the app's process: no pipe,
no terminal. It runs the command and saves every line the command prints (with when) and then its exit
status to the run's rows in the database, which is where the app reads them, before or after a restart.
The nonce makes this process recognisable on its command line, so the app only ever signals its own runs.
SIGTERM (Stop in the app, or quitting it) stops the command; what it printed and its status are still saved.
"""
from __future__ import annotations

import signal
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from datetime import datetime, timezone


def main(argv: list[str]) -> int:
    if len(argv) < 5 or argv[3] != "--":
        print(__doc__, file=sys.stderr)
        return 2
    _nonce, db, run_id, _, *cmd = argv
    rid = int(run_id)
    with closing(sqlite3.connect(db, timeout=60)) as con:
        n = con.execute("SELECT COUNT(*) FROM run_lines WHERE run_id = ?", (rid,)).fetchone()[0]

        def save(line: str) -> None:
            nonlocal n
            with con:   # saved line by line, so the app shows each one as it's printed
                con.execute("INSERT INTO run_lines(run_id, n, line, at) VALUES(?, ?, ?, ?)", (rid, n, line, time.time()))
            n += 1

        proc: subprocess.Popen | None = None
        stopping = False

        def stop(*_):
            nonlocal stopping
            stopping = True
            if proc is not None and proc.poll() is None:
                proc.terminate()
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, stop)
        try:
            if stopping:
                raise InterruptedError
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace", bufsize=1)
        except InterruptedError:
            returncode = -signal.SIGTERM
        except OSError as e:
            save(f"Couldn't start: {e}")
            returncode = 1
        else:
            if stopping:             # stopped while it was starting
                proc.terminate()
            assert proc.stdout
            for line in proc.stdout:
                save(line.rstrip("\n"))
            returncode = proc.wait()
        with con:
            con.execute("UPDATE runs SET returncode = ?, finished = ? WHERE id = ?",
                        (returncode, datetime.now(timezone.utc).isoformat(timespec="seconds"), rid))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
