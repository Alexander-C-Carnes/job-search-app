#!/usr/bin/env python3
"""Add a 'Tailored resume' column to ratings.json (copy of the impact-record
ratings, minus any requirement prefixes passed as --drop, which become the
given rating). Writes ratings-final.json. Usage:
  python add_tailored.py <run> <score> [--drop "S15=missing" ...]"""
import json, sys
run, score = sys.argv[1], int(sys.argv[2])
drops = dict(a.split("=") for a in sys.argv[3:] if "=" in a)
r = json.load(open(f"{run}/ratings.json"))
r["sources"].append("Tailored resume"); r["scores"].append(score)
for k in ("skills", "experience"):
    for row in r[k]:
        rid = row["requirement"].split()[0]
        val = drops.get(rid, row["ratings"][0])
        row["ratings"].append(val)
        if "notes" in row:
            row["notes"].append("Stated in resume-final.md at the impact-record scope" if rid not in drops else "Omitted from resume-final.md (bullet caps)")
json.dump(r, open(f"{run}/ratings-final.json", "w"), indent=1, ensure_ascii=False)
