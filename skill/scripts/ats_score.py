#!/usr/bin/env python3
"""Compute the Skills / Experience / Keywords / Total scorecard (0-100%).

Usage:
    python ats_score.py ratings.json keywords.json \
        --resume "Platform resume=references/resume-platform.md" \
        [--resume "Name=path" ...] [--weights 35,35,30] [--target 80]

ratings.json   Same file used by heatmap.py. Source names in --resume must match
               entries in its "sources" list; sources without a resume file (e.g.
               the impact record) get Skills and Experience only.
keywords.json  {"Keyword label": "case-insensitive regex", ...}, taken from the
               posting's own wording (typically 30-50 terms).

Scoring:
  Skills / Experience: strong=100, partial=50, missing=0; High rows count 3x,
  Med 2x, Low 1x.
  Keywords: share of keyword patterns found literally in the resume text.
  Total: weighted sum (default 35 skills / 35 experience / 30 keywords).
"""
import argparse
import json
import re
import sys

WEIGHT = {"high": 3, "med": 2, "medium": 2, "low": 1}
VALUE = {"strong": 1.0, "partial": 0.5, "missing": 0.0}


def section_pct(rows, i):
    total = sum(WEIGHT[r["weight"].lower()] for r in rows)
    if not total:
        return None
    got = sum(WEIGHT[r["weight"].lower()] * VALUE[r["ratings"][i].lower()] for r in rows)
    return 100 * got / total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ratings")
    ap.add_argument("keywords")
    ap.add_argument("--resume", action="append", default=[], help='"Source name=path/to/resume.txt|md"')
    ap.add_argument("--weights", default="35,35,30")
    ap.add_argument("--target", type=float, default=80)
    a = ap.parse_args()

    d = json.load(open(a.ratings))
    kw = json.load(open(a.keywords))
    ws, we, wk = [float(x) / 100 for x in a.weights.split(",")]
    files = {}
    for spec in a.resume:
        name, _, path = spec.partition("=")
        files[name.strip()] = path.strip()
    unknown = set(files) - set(d["sources"])
    if unknown:
        sys.exit(f"--resume names not in ratings sources: {sorted(unknown)}")

    print(f"Weights: skills {ws:.0%} / experience {we:.0%} / keywords {wk:.0%}; target {a.target:.0f}%\n")
    print(f"{'Source':34s} {'Skills':>7s} {'Exper.':>7s} {'Keywd':>7s} {'TOTAL':>7s}")
    missing_by_source = {}
    for i, src in enumerate(d["sources"]):
        s = section_pct(d.get("skills", []), i)
        e = section_pct(d.get("experience", []), i)
        k = tot = None
        if src in files:
            text = open(files[src], encoding="utf-8", errors="ignore").read()
            hits = {label: bool(re.search(p, text, re.I)) for label, p in kw.items()}
            k = 100 * sum(hits.values()) / len(hits)
            tot = ws * s + we * e + wk * k
            missing_by_source[src] = [label for label, h in hits.items() if not h]
        fmt = lambda v: "   n/a" if v is None else f"{v:6.0f}%"
        flag = "" if tot is None else ("  PASS" if tot >= a.target else "  below target")
        print(f"{src:34s} {fmt(s)} {fmt(e)} {fmt(k)} {fmt(tot)}{flag}")
    for src, miss in missing_by_source.items():
        print(f"\nMissing keywords — {src} ({len(miss)}): " + (", ".join(miss) if miss else "none"))


if __name__ == "__main__":
    main()
