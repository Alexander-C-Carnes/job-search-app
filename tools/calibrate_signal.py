#!/usr/bin/env python3
"""Compare the signal score with full-run scores on jobs whose full score is known.

  python tools/calibrate_signal.py [--repeat 2] [--effort low]

Reads data/calibration/set.json: [{"slug", "name", "ref"}], where ref is the job's full-run
impact-record score (the tracker's Fit Score for a job that went through tailoring), and
data/calibration/<slug>.jd.md, the posting in jd.md form. It runs the signal scorer on each
(real Claude calls; nothing is stored and Notion is not touched) and prints the gap per job.
The aim is an average gap within half a point. To add a job, append it to set.json and save
its jd.md (outputs/<date>/runs/<job>/jd.md from a tailoring run is the right file).
"""
import argparse
import asyncio
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jobpipe import config, triage  # noqa: E402
from jobpipe.cli import _load_env  # noqa: E402
from jobpipe.config import ModelCfg  # noqa: E402
from jobpipe.pipeline import make_runner  # noqa: E402


async def main(repeat: int, effort: str) -> None:
    cfg = config.load()
    folder = config.DATA / "calibration"
    jobs = json.loads((folder / "set.json").read_text())
    model = ModelCfg(cfg.triage_model.model, effort or cfg.triage_model.effort)
    runner = make_runner(cfg)

    async def one(job: dict, k: int):
        try:
            t = await triage.triage_one(runner, model, (folder / f"{job['slug']}.jd.md").read_text(), f"{job['slug'][:30]}#{k}")
            return job["slug"], t
        except Exception as e:  # noqa: BLE001 - one failure shouldn't stop the table
            return job["slug"], e

    results: dict[str, list] = {}
    for slug, t in await asyncio.gather(*(one(j, k) for j in jobs for k in range(repeat))):
        results.setdefault(slug, []).append(t)
    gaps = []
    print(f"{'full':>4} {'signal':>8} {'gap':>5}  {'coverage':>9}  job")
    for job in jobs:
        ok = [t for t in results[job["slug"]] if isinstance(t, triage.Triage)]
        if not ok:
            print(f"{job['ref']:>4}    failed: {results[job['slug']][0]}")
            continue
        gap = statistics.mean(t.fit_score for t in ok) - job["ref"]
        gaps.append(gap)
        print(f"{job['ref']:>4} {'/'.join(str(t.fit_score) for t in ok):>8} {gap:>+5.1f}  "
              f"{'/'.join(str(round(t.coverage_pct or 0)) for t in ok):>8}%  {job['name'][:70]}")
    if gaps:
        print(f"\n{len(gaps)} jobs: average gap {statistics.mean(gaps):+.2f}, average size of gap "
              f"{statistics.mean(map(abs, gaps)):.2f}, within half a point {sum(abs(g) <= 0.5 for g in gaps)}/{len(gaps)}, "
              f"within one point {sum(abs(g) <= 1 for g in gaps)}/{len(gaps)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repeat", type=int, default=1, help="score each job this many times (shows run-to-run noise)")
    ap.add_argument("--effort", default="", help="override models.triage.effort")
    args = ap.parse_args()
    _load_env()
    asyncio.run(main(args.repeat, args.effort))
