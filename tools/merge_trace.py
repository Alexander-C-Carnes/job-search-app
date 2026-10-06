#!/usr/bin/env python3
"""Build trace-final.md for a merged resume: map each final line to the closest
line in resume-draft-[A|B|C].md and copy that draft trace row's ledger and
requirement IDs. Usage: python merge_trace.py <run-folder>"""
import difflib, re, sys
from pathlib import Path

run = Path(sys.argv[1])

def lines(md):
    out = []
    for l in md.splitlines():
        if l.startswith("- "):
            out.append(l[2:])
        elif (l and not l.startswith(("#", "*", "Hard Skills", "Soft Skills")) and "linkedin.com/in/" not in l
              and len(l.split()) > 8):                    # not headings, skills or the contact line
            out.append(l)
    return out

def first8(t):
    return " ".join(re.sub(r"[*`]", "", t).split()[:8])

def trace_rows(p):
    rows = {}
    for l in p.read_text().splitlines():
        if not l.startswith("|") or l.startswith("|---") or "Starts with" in l:
            continue
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", l)[1:-1]]
        if len(cells) >= 5:
            rows[cells[1].replace("\\|", "|").lower()] = (cells[3], cells[4])
    return rows

drafts = {}
for x in "ABC":
    d, t = run / f"resume-draft-{x}.md", run / f"trace-{x}.md"
    if d.exists() and t.exists():
        drafts[x] = (lines(d.read_text()), trace_rows(t))

final_md = (run / "resume-final.md").read_text()
out = ["# Trace: merged final (resume-final.md)", "",
       "Each line is matched to the closest draft line; ledger and requirement IDs come from that draft's trace.", "",
       "| Line | Starts with (first 8 words, exact) | Source draft (similarity) | Ledger IDs | Requirement IDs |",
       "|---|---|---|---|---|"]
for i, fl in enumerate(lines(final_md), 1):
    best = (0, None, None)
    for x, (dl, _) in drafts.items():
        for cand in dl:
            r = difflib.SequenceMatcher(None, fl.lower(), cand.lower()).ratio()
            if r > best[0]:
                best = (r, x, cand)
    r, x, cand = best
    led, req = "?", "?"
    if x:
        rows = drafts[x][1]
        key = first8(cand).lower()
        for k, v in rows.items():
            if k.startswith(key[:40]) or key.startswith(k[:40]):
                led, req = v
                break
    out.append(f"| L{i} | {first8(fl).replace('|', chr(92)+'|')} | {x} ({r:.2f}) | {led} | {req} |")
bul = [l for l in final_md.splitlines() if l.startswith("- ")]
out += ["", "Full bullet text (for checker coverage):", ""] + bul
(run / "trace-final.md").write_text("\n".join(out) + "\n")
print("\n".join(out[:len(out) - len(bul) - 3]))
