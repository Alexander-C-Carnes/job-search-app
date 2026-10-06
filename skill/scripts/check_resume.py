#!/usr/bin/env python3
"""Mechanical checks on a tailored resume markdown (drafts and the merged final).

Usage:
    python check_resume.py resume.md --title "Exact Posting Title" [--trace trace.md]
                           [--city "Portland, OR"] [--name Jordan] [--withdrawn 41.2%]

Checks the pre-delivery checklist items a script can verify. It does not judge
truthfulness; the orchestrator still checks every line against the evidence
ledger. Exit code 1 if any FAIL, 0 otherwise (WARNs don't fail).
"""
import argparse
import re
import sys
import unicodedata

REQUIRED_HEADINGS = ["SUMMARY", "PROFESSIONAL EXPERIENCE", "CORE SKILLS", "EDUCATION"]
BAD_CHARS = {"\u2192": "arrow", "\u25b8": "triangle", "\u2605": "star", "\u200b": "zero-width space",
             "\u200c": "zero-width char", "\u200d": "zero-width joiner", "\ufeff": "BOM"}
WEAK = [r"\bresponsible for\b", r"\bresults[- ]driven\b", r"\bpassionate\b", r"\bteam player\b"]


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[*_`]", "", s)).strip().lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("resume")
    ap.add_argument("--title", required=True, help="exact job title from the posting")
    ap.add_argument("--trace", help="trace-X.md to confirm every bullet is traced")
    ap.add_argument("--city", default="", help="the City, ST the contact line must show")
    ap.add_argument("--name", default="the candidate", help="the candidate's first name, for messages")
    ap.add_argument("--max-pages", type=int, default=2, help="the résumé format's page limit (Compact: 1)")
    ap.add_argument("--withdrawn", action="append", default=[],
                    help="a figure the impact record withdrew, e.g. 41.2%% (repeatable); its presence fails")
    a = ap.parse_args()
    text = open(a.resume, encoding="utf-8").read()
    lines = text.splitlines()
    fails, warns = [], []

    # 1. exact job title
    if a.title not in text:
        fails.append(f'Exact job title not found: "{a.title}"')
    headline = next((l.strip().strip("*").strip() for l in lines if l.startswith("**")), "")
    if not headline.startswith(a.title):
        fails.append(f'Headline must start with the exact job title "{a.title}": {headline}')
    job_re = re.compile(r"^\*\*[^*]+\*\* \|")
    for ln in lines:
        if job_re.match(ln) and a.title in ln:
            warns.append(f"Exact title appears on a job/title line: confirm {a.name} held it")

    # 2. headings
    heads = [re.sub(r"^#+\s*", "", l).strip().upper() for l in lines if l.startswith("## ")]
    for h in REQUIRED_HEADINGS:
        if h not in heads:
            fails.append(f"Missing heading: {h}")
    if "EXPERIENCE" in heads:
        fails.append('Heading "Experience" used; must be PROFESSIONAL EXPERIENCE')
    if any("CAPABILITIES" in h for h in heads):
        fails.append('Heading "Core Capabilities" used; must be CORE SKILLS')
    for l in lines:
        if l.startswith("#") and re.search(r"[–—▸★•]", l):
            fails.append(f"Decorative character in heading: {l.strip()}")

    # 3. CORE SKILLS lines
    hard = next((l for l in lines if l.strip().startswith("Hard Skills:")), None)
    soft = next((l for l in lines if l.strip().startswith("Soft Skills:")), None)
    for name, l, lo, hi in (("Hard", hard, 8, 12), ("Soft", soft, 6, 10)):
        if not l:
            fails.append(f"Missing '{name} Skills:' line")
            continue
        n = len([x for x in l.split(":", 1)[1].split("|") if x.strip()])
        if not lo <= n <= hi:
            warns.append(f"{name} Skills has {n} items (target {lo}-{hi})")
    if hard and soft:
        total = sum(len([x for x in l.split(":", 1)[1].split("|") if x.strip()]) for l in (hard, soft))
        if not 14 <= total <= 22:
            warns.append(f"CORE SKILLS total {total} (target 14-22)")

    # 4. characters
    for ch, name in BAD_CHARS.items():
        if ch in text:
            fails.append(f"Disallowed character: {name}")
    for c in set(text):
        if unicodedata.category(c) == "So":
            fails.append(f"Symbol/emoji character: {c!r}")

    # 5. contact line
    if a.city not in text or "linkedin.com/in/" not in text:
        fails.append(f"Contact line needs {a.city or 'the city'} and the visible linkedin.com/in/ URL")

    # 6. dates
    date_re = re.compile(r"^\*[A-Z][a-z]{2} \d{4}[–-](?:[A-Z][a-z]{2} \d{4}|Present)(?: \| [^*]+)?\*$")
    for i, l in enumerate(lines):
        if job_re.match(l) and i + 1 < len(lines):
            nxt = lines[i + 1].strip()
            if not date_re.match(nxt):
                fails.append(f"Job line not followed by '*Mon YYYY–Mon YYYY | Location*': {l.strip()[:60]}")

    # 7. wording
    summ = re.search(r"## SUMMARY\n(.*?)\n## ", text, re.S)
    if summ and re.search(r"\b(I|me|my)\b", summ.group(1)):
        fails.append("Summary uses I/me/my")
    for pat in WEAK:
        if re.search(pat, text, re.I):
            fails.append(f"Weak phrase: {pat}")
    for m in a.withdrawn:
        if m in text:
            fails.append(f"Withdrawn metric present: {m}")
    if re.search(r"\$\d", text):
        warns.append("Dollar figure present: confirm it is not a 'Do not claim' savings figure")

    # 8. length
    words = len(re.findall(r"\b\w+\b", text))
    limit = 650 if a.max_pages == 1 else 1100
    if words > limit:
        warns.append(f"{words} words: likely over {'one page' if a.max_pages == 1 else f'{a.max_pages} pages'}")

    # 9. trace coverage
    bullets = [l.strip()[2:] for l in lines if l.strip().startswith("- ")]
    if a.trace:
        tr = norm(open(a.trace, encoding="utf-8").read())
        for b in bullets:
            key = " ".join(norm(b).split()[:6])
            if key not in tr:
                fails.append(f"Bullet not in trace: {b[:70]}")

    print(f"{a.resume}: {words} words, {len(bullets)} bullets")
    for f in fails:
        print("FAIL", f)
    for w in warns:
        print("WARN", w)
    print("RESULT:", "FAIL" if fails else "PASS")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
