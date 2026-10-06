# Scoring and fit report

The orchestrator uses this file in Stage 6. The matcher agent (Stage 2) uses the rubric and rating rules to rate each requirement.

## Score (1–10)

Produce one score per source with this rubric:
- **Impact record score** — how well {first}'s *actual* experience fits the role (the ceiling a perfectly tailored resume could reach, combined with the resume variants for roles the impact record covers only briefly).
- **A score for each resume variant** — how well each document, as written, fits.

| Score | Meaning |
|---|---|
| **1–3** | No or almost no relevant skills or experience. (1 = nothing; 3 = a few minor overlaps.) |
| **4–5** | Some relevant skills OR some relevant experience — not both. (5 if the one present is fairly strong.) |
| **6–7** | Relevant skills AND experience, but covering only ~60–70% of the role. (6 ≈ 60%, 7 ≈ 70%.) |
| **8** | Relevant experience and skills covering most of the role (~80–90%); gaps are minor or quickly learnable. |
| **9** | Significant relevant experience and skills; missing at most one skill. |
| **10** | Perfect fit — exact match on skills, experience, and level. Use sparingly. |

Rules:
- Pick the band first, then the number within it.
- A missing hard requirement (mandatory degree, clearance, language, license, location) caps the score — call it out explicitly.
- Seniority mismatch (far over- or under-leveled) makes experience partial, not strong. A one-level step (Senior → Staff) is **not** far: rate level on demonstrated scope, and treat a headline that literally announces a lower level (e.g., "Sr Engineer (L5)") as a resume problem to fix.
- Nice-to-haves move a score within its band, never into a higher band.
- The gap between the impact-record score and a resume score is the **rewrite opportunity** — the most actionable finding. Say so explicitly when it's 1+ points.

## ATS scorecard (0–100%)

Alongside the 1–10 score, compute for every source:
- **Skills %** and **Experience %** from the heat-map ratings: strong = 100, partial = 50, missing = 0; High rows count 3×, Med 2×, Low 1×.
- **Keywords %** (resumes only): the share of the posting's keywords that appear literally in the resume text.
- **Total %** = 35% Skills + 35% Experience + 30% Keywords, unless the user sets other weights. **Target: 80%+.**

Run `python scripts/ats_score.py ratings.json keywords.json --resume "<source name>=<resume path>" ...` (one `--resume` per resume source; PDFs: extract text first with `pdftotext -layout`). The impact record gets Skills and Experience only, since it isn't a document anyone submits.

Be honest about what the number is: it's this skill's own estimate, not the employer's. Many ATSs (Greenhouse, for example) don't auto-reject on a match percentage; recruiters search and filter by keywords, job title, skills, education, and location. So literal wording matters even when no score is computed. See "ATS and recruiter-scorecard best practices" for how that search and sorting works.

When Keywords % is the drag, list the missing keywords and sort them into two groups:
1. **Truthful adds** — work the impact record supports, with where each keyword would go.
2. **Don't add** — no evidence (e.g., a level or title never held, a domain never worked in). Never stuff keywords the evidence doesn't support; that includes hidden or white-text keywords.

## Report template

Use this structure:

```
# [Job title] — [Company]

## Job summary
...

## What the job will be doing
...

## Fit scores
| Source | Score | One-line reason |
|---|---|---|
| Impact record (actual experience) | X/10 | ... |
| [each resume variant] | X/10 | ... |

**Recommended resume to send:** [variant] — [why], or "none as-is; tailor [variant]" if all trail the impact score.

## ATS scorecard
| Source | Skills | Experience | Keywords | **Total** |
|---|---|---|---|---|
| Impact record (ceiling) | X% | X% | n/a | n/a |
| [each resume] | X% | X% | X% | **X%** ✅/⚠️ |
Target 80%+. One line on the method and weights. Then the missing-keyword split (truthful adds vs. don't add).

## Heat map
[Delivered as an interactive Plotly chart — see "Building the heat map" below. In the report, add one line pointing to it and a compact emoji version so the report still reads on its own:]
| Requirement | Weight | Impact | Platform | Leadership |
|---|---|---|---|---|
| [requirement] | High | 🟩 | 🟨 | 🟥 |
Legend: 🟩 strong · 🟨 partial · 🟥 missing

## Where the fit is strongest
3–5 bullets, each tied to specific evidence (name the launch, tool, metric, or program).

## Unconfirmed gaps
Requirements rated missing or partial in ALL sources. Label them unconfirmed — {first} may have this experience outside the bundled documents. List them here briefly; the questions go at the end.

## Suggested improvements
### 1. Resume rewrites (evidence you already have)
Requirements that are 🟩 in the impact record but 🟨/🟥 in the resume. For each: which resume, what to add or change, and the specific impact-record evidence to draw on (with the real figure — e.g., "120 PRs across 9 repos, 104 merged"). Offer a draft bullet when useful.

### 2. Posting-language keywords
Two short lists from the keyword bank:
- **Use** — posting phrases {first}'s evidence supports, each paired with the evidence it attaches to and where it goes (title line, summary, a specific bullet, Core Skills).
- **Held back** — posting phrases left out because the evidence doesn't support them, each with a one-line reason (e.g. "Kafka — user-confirmed he lacks it"; "Terraform — not in any source; ask"). Turn any "not in any source" items into questions at the end.

Then show the ranked **Hard Skills** and **Soft Skills** lists for CORE SKILLS (see "Required resume elements").

### 3. Positioning
How to frame the story for this role — headline, summary line, which work to lead with, what to cut or shrink.

### 4. ATS & format check
Check the recommended resume against "Resume best practices" and the pre-delivery checklist in "ATS and recruiter-scorecard best practices". List only the failures that matter for this posting (exact job title, CORE SKILLS, headline, summary, bullets, headings, characters, job lines, contact line, length).

### 5. Skills to build
Only for gaps {first} has **confirmed** he lacks. On the first pass, write "Pending your answers to the questions below" instead of guessing.

### Why [top score] and not [top score + 1]
One or two sentences on what specifically holds the best score back.

## Scorecard stories
For each High-weight requirement {first} meets, name the one story from his evidence he should be ready to tell in STAR form (situation, task, action, result), one line each. Structured-hiring systems give interviewers a rating per attribute, so each must-have needs a story ready.

## Questions before I finalize
One numbered question per unconfirmed gap, highest weight first. Make each specific and tied to the posting's wording, e.g.:
1. The posting asks for "experience managing hardware programs". Have you run anything with a hardware component, such as devices, firmware, or manufacturing partners? If so, what was your role and scope?
Also note which scores could change depending on the answers.
```

## Building the heat map (Plotly)

Use the bundled script `scripts/heatmap.py`, which renders a two-panel (Skills, Experience) Plotly heat map as a self-contained interactive HTML file: rows are requirements sorted by weight, columns are the three sources with their scores, cells are green/amber/red with hover text showing the evidence.

1. Make sure Plotly is installed: `pip install plotly` (add `--break-system-packages` if pip refuses).
2. The matcher agent writes the ratings to `ratings.json` in this shape:
   ```json
   {
     "title": "[Job title] — [Company]",
     "sources": ["Impact record", "Platform resume", "Leadership resume"],
     "scores": [8, 7, 6],
     "skills": [
       {"requirement": "Payments compliance", "weight": "High",
        "ratings": ["strong", "partial", "missing"],
        "notes": ["Led PCI DSS audit readiness", "Mentions PCI only", ""]}
     ],
     "experience": [ ...same shape... ]
   }
   ```
   `ratings` values are `strong`, `partial`, or `missing`, one per source, in the same order as `sources`. `weight` is `High`, `Med`, or `Low`. `notes` is optional but make it count — a short piece of evidence per cell (or why it's missing) makes the hover text useful.
3. Run: `python scripts/heatmap.py ratings.json <outputs-dir>/heatmap-<company>-<role>.html`, using the surface's user-visible outputs folder (e.g. `/mnt/user-data/outputs/`).
4. Deliver the HTML file to the user with whatever file-sharing tool the environment provides.

If Plotly can't be installed (no network), skip the chart, keep the emoji table, and say so in one line. If a user uploaded an extra resume, add it as another source column. Keep improvement lists prioritized — the 3–6 changes that would move the score most, not an exhaustive list.
