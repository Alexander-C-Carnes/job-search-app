"""How far along a résumé tailoring run is and about how long it has left, for the ring on the job's fit badge.

A tailoring run (`python -m jobpipe tailor JOB_ID`) prints a line as it starts each step (tailor.py), so the
step it's on is the last of those lines. How long a step takes is learned from finished runs: the time between
one step's line and the next (runs.py saves when each line was printed). Until a step has a few timed samples
it uses DEFAULT_S, scaled so the steps add up to how long whole tailoring runs have taken.
"""
from __future__ import annotations

import re
import statistics
import time
from datetime import datetime
from typing import Optional

from .runs import Run, RunManager

# (what the list shows, the line the step starts with, a first guess in seconds: a 2026-10 run took ~25 minutes)
STEPS = [
    ("Reading the posting", None, 30),                          # from the run's start
    ("Pulling out requirements", r"^\s*Stage 1:", 150),
    ("Matching to your record", r"^\s*Stage 2:", 240),
    ("Writing 3 drafts", r"^\s*Stage 3: writers", 320),
    ("Rating the drafts", r"^\s*Stage 3: rating", 85),
    ("Merging and checking", r"^\s*Stage 4: merge$", 380),
    ("Making the PDF", r"^\s*Stage 5: PDF", 30),
    ("Heat map and report", r"^\s*Stage 6:", 150),
]
DEFAULT_S = [s for _, _, s in STEPS]
MARKERS = [re.compile(m) if m else None for _, m, _ in STEPS]
REUSED = re.compile(r"^\s*Stages 1-2: reusing")   # the job already had a full score: steps 1 and 2 are skipped
SKIPPED_WHEN_REUSED = {1, 2}
MIN_SAMPLES = 3
RECENT = 20   # medians over the last this-many finished runs


def tailored_job(run: Run) -> Optional[str]:
    return run.args[1] if len(run.args) >= 2 and run.args[0] == "tailor" else None


def _ts(iso: Optional[str]) -> Optional[float]:
    try:
        return datetime.fromisoformat(iso).timestamp() if iso else None
    except ValueError:
        return None


def steps_seen(run: Run) -> tuple[dict[int, Optional[float]], bool]:
    """{step: when its line was printed (None if unknown)} for the steps the run has reached, and whether it reused a full score."""
    seen: dict[int, Optional[float]] = {0: _ts(run.started)}
    reused = False
    for n, line in enumerate(list(run.lines)):
        if REUSED.match(line):
            reused = True
            continue
        for i, m in enumerate(MARKERS):
            if m is not None and i not in seen and m.match(line):
                seen[i] = run.line_at[n] if n < len(run.line_at) else None
                break
    return seen, reused


class Estimator:
    def __init__(self, runs: RunManager):
        self.runs = runs
        self._cache: tuple[tuple, list[float]] = ((), DEFAULT_S)

    def _finished(self) -> list[Run]:
        done = [r for r in self.runs.runs.values() if tailored_job(r) and r.returncode == 0 and r.finished]
        return sorted(done, key=lambda r: r.id)[-RECENT:]

    def medians(self) -> list[float]:
        """Seconds each step usually takes, from finished tailoring runs."""
        done = self._finished()
        sig = tuple(r.id for r in done)
        if sig == self._cache[0]:
            return self._cache[1]
        samples: list[list[float]] = [[] for _ in STEPS]
        totals = []
        for r in done:
            seen, reused = steps_seen(r)
            start, end = _ts(r.started), _ts(r.finished)
            if not reused and start and end:
                totals.append(end - start)
            order = sorted(seen)
            for k, i in enumerate(order):
                t0 = seen[i]
                t1 = seen[order[k + 1]] if k + 1 < len(order) else end
                consecutive = k + 1 == len(order) and i == len(STEPS) - 1 or k + 1 < len(order) and order[k + 1] == i + 1
                if t0 is not None and t1 is not None and t1 >= t0 and consecutive:
                    samples[i].append(t1 - t0)
        scale = 1.0
        if len(totals) >= 2:   # whole runs: stretch the first guesses to match how long they really take
            scale = min(3.0, max(0.3, statistics.median(totals) / sum(DEFAULT_S)))
        out = [statistics.median(s) if len(s) >= MIN_SAMPLES else d * scale for s, d in zip(samples, DEFAULT_S)]
        self._cache = (sig, out)
        return out

    def durations(self) -> dict:
        """About how long each job action takes, for the times on its button: Make résumé is every step, a full
        score on its own is the first three (read the posting, pull out requirements, match them to your record)."""
        med = self.medians()
        return {"full_score_s": round(sum(med[:3])), "make_resume_s": round(sum(med))}

    def of(self, run: Run, now: Optional[float] = None) -> Optional[dict]:
        """Where a running tailoring run is: its step, the share done, and about how many seconds are left.
        `total_s` and `cap` let the page move the ring smoothly between polls without passing the step's end."""
        jid = tailored_job(run)
        if not jid or run.status != "running":
            return None
        now = now if now is not None else time.time()
        med = self.medians()
        seen, reused = steps_seen(run)
        cur = max(seen)
        order = [i for i in range(len(STEPS)) if not (reused and i in SKIPPED_WHEN_REUSED)]
        before = sum(med[i] for i in order if i < cur)
        after = sum(med[i] for i in order if i > cur)
        began = seen[cur]
        if began is None:   # a run from before lines had times: guess from the whole run's elapsed time
            began = (_ts(run.started) or now) + before
        in_step = max(0.0, now - began)
        floor = 0.1 * med[cur]          # past its usual length, a step is "nearly done" rather than overdue
        left_here = max(med[cur] - in_step, floor)
        total = before + med[cur] + after
        cap = (before + 0.95 * med[cur]) / total
        return {"job": jid, "step": STEPS[cur][0], "n": order.index(cur) + 1 if cur in order else 1, "of": len(order),
                "fraction": round(min((before + in_step) / total, cap), 4), "cap": round(cap, 4), "total_s": round(total),
                "eta_s": round(left_here + after), "eta_min_s": round(floor + after), "slow": in_step > 1.15 * med[cur]}
