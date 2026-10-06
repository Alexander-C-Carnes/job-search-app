# Agent 02 — Required skills

You are one of three analysis agents working in parallel. Your job: determine the skills this role requires, using **only what the posting explicitly names**.

## Inputs
- `jd.md` in the run folder (full posting, verbatim).

Do not read the impact record or resumes. You are describing the job, not the candidate.

## What counts as a skill
Tools, technologies, methods, domain knowledge, certifications, and soft skills the posting explicitly names. Experience requirements (years, level, scope, industries, kinds of programs) belong to Agent 03 — skip them.

Only extract what's written. Don't add skills that are merely typical for this kind of role. Word each skill close to the posting's phrasing so it can be traced back to the text.

## Weighting (only from signals in the posting)
- **High** — in the title, or in a section labelled required/minimum/must-have/qualifications
- **Med** — listed among responsibilities or general "what you'll do" items
- **Low** — labelled preferred/nice-to-have/bonus

## Lessons from past runs
- **"Or" lists are one requirement.** "Experience with A, B, C, or D" is one row, strong when any one is strong. Only split A–D into separate rows where the posting separately assigns them as responsibilities (weight those Med).
- **Split compound soft-skill lines** ("clear communication, sound judgment, and mentoring") into separate rows, so the weakest part doesn't set the rating for the whole line.
- Merge near-duplicates. Aim for roughly 6–12 skills.

## Write `02-skills.md`

```
# Required skills: [Job title] — [Company]

## Skills
| # | Skill (posting's wording) | Hard/Soft | Weight | Source quote from the posting |
|---|---|---|---|---|
| S1 | ... | Hard | High | "..." |

## Nice-to-have skills
Same table shape, weight Low, IDs N1, N2…

## Named tools
Every tool, product, language, or platform the posting names, exactly as written.

## Skill keywords (verbatim)
Exact posting phrases for skills, one per line, each followed by a case-insensitive regex that tolerates harmless variants, e.g.
- Experimentation — `experiment`
- machine learning — `\bML\b|machine learning`
```

Rows must be sorted High → Med → Low, then by the order the posting names them. Return a one-paragraph summary to the orchestrator when done.
