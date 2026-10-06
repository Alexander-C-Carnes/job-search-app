# job-search

A personal job-hunting pipeline. It finds new postings on [JobsPipe](https://jobspipe.dev), scores each one against your record of past work, writes a tailored résumé (PDF, in one of five formats) for the best ones, and keeps a job tracker that syncs with Notion. It runs on your own Mac, as a command-line tool and as a local web app. Claude does the scoring and writing through your Claude subscription, so you don't pay for API credits.

Everything about you lives in your own **profile folder**, outside the repo: your record of past work, your résumés, your settings and searches, your API keys, and every job, tracker row and résumé the app makes. It's `~/JobSearch` unless you set `JOBPIPE_HOME`. The repo holds only the code and the method, so anyone can use it, and pulling updates never touches your files. [Set it up for yourself](#set-it-up-for-yourself) takes you through it.

## How it works

```
searches.yaml ──► JobsPipe search ──► local filters ──► skip jobs already triaged / Applied in Notion
                  (credit-capped)                        │
                                                         ▼
                                   signal score (1 Claude call per job, 1-10 fit)
                                                         │  best N with fit ≥ 7
                                                         ▼
          resume-job-fit (Stage 1 analysts ×3 → matcher → writers A/B/C → rater → merge
                          → PDF in your résumé format → heat map + report)
                                                         │
                                                         ▼
              Notion Tasks row · apply-*.md checklist · digest.md          ──►  you apply
```

1. **Find jobs.** `searches.yaml` holds saved searches (titles, remote or hybrid, locations, salary floor, how recent). Each one becomes a request to the JobsPipe API. JobsPipe charges one credit per job returned, so every search has a `limit` and each run has a credit budget. Jobs are stored in `data/` so they're never paid for twice.
2. **Skip what you've seen.** Jobs already scored, or already marked Applied, Interviewing, Offer, Denied, Done or Not Applying in the tracker, are dropped.
3. **Signal score.** One short Claude call per job gives it a 1–10 fit score against your **impact record**, a detailed document of what you've done and what it achieved (`references/impact-record.md` in your profile folder). If the listing is only a stub, the full posting is fetched from the employer's site first. A job is never scored on its title alone.
4. **Make résumés for the best ones.** Jobs scoring 7 or higher (the top 3 by default) get **Make résumé**: the full `resume-job-fit` pipeline, about 11 Claude calls per job:
   - three analysts each pull one thing out of the posting: its objectives, the skills it requires, and the experience it requires;
   - a matcher rates every requirement against the impact record and each of your existing résumés, and builds an evidence ledger and a "do not claim" list;
   - three writers draft résumés independently, each with a different emphasis, using the posting's own wording wherever your evidence supports it;
   - the drafts are rated and merged into one résumé, which is checked by `skill/scripts/check_resume.py` (format and honesty rules) and an ATS keyword scorer;
   - small Hugging Face models running on your Mac check the merged résumé against your evidence: whether every line is backed by what it cites (flagged lines get one review pass), and which posting keywords it's missing that your record does support (those go into a keyword pass) — see [Evidence checks](#evidence-checks-local-models);
   - the résumé is rendered to a PDF in your résumé format (two pages; one in Compact), with a fit report and an interactive heat map.
5. **Track it.** The job is recorded in a local tracker (`data/tracker.db`) and copied to a Notion database. You also get an `apply-*.md` checklist with the link, the PDF to attach, and the posting's hard requirements, plus a `digest.md` for the run.
6. **You apply.** The pipeline never submits an application. You review the résumé, apply, and set the job to Applied.

**Honesty rules.** Every claim in a résumé has to trace back to the impact record, your existing résumés, or answers you've confirmed. When a requirement isn't covered anywhere, the report doesn't call it a gap. It ends with a question about it, and the answers you give (with **Add a confirmed fact** in the app's **Impact record** tab, which files them under the record's **Confirmed facts** section) count as evidence on later runs.

**Where things live.** The repo:

| Path | What's in it |
|---|---|
| `jobpipe/` | The Python app: CLI (`cli.py`), pipeline (`pipeline.py`), JobsPipe client (`jobs_api.py`), triage, tailoring orchestrator (`tailor.py`), PDF renderer (`render.py`), tracker and Notion sync, the startup search (`startups.py`), and the web app (`web/`) |
| `skill/` | The `resume-job-fit` method: agent briefs (`agents/`), rules and scoring rubric (`references/`), check scripts. Nobody's personal details: the prompts say `{name}`, `{contact}` and the like, filled in from your profile as they load |
| `example-profile/` | What a new profile starts as: a made-up candidate (Jordan Rivera) with an impact record, a résumé and example searches. The tests run as Jordan too |
| `jobsearch`, `start.sh` | Scripts that set up `.venv` and start the web app |

Your profile folder (`~/JobSearch`, or `$JOBPIPE_HOME`), which never goes in git:

| Path | What's in it |
|---|---|
| `searches.yaml` | Who you are (`candidate:`), saved searches, credit budget, Notion IDs, and which Claude model each stage uses |
| `.env` | Your API keys |
| `references/` | Your impact record (with your confirmed facts at the end) and your résumés (`resume-*.md`) |
| `data/` | Stored jobs, the tracker database, credit ledger, startups (`startups.json`), interview prep notes, web-app token |
| `outputs/<date>/` | Résumé PDFs, reports, heat maps, apply checklists and each run's working files |
| `resume-runs/` | Runs of the `resume-job-fit` skill done in Claude chats; the web app can show these résumés too |

Paths in the rest of this README like `data/` or `references/` are in your profile folder. `JOBPIPE_DATA_DIR`, `JOBPIPE_OUTPUTS_DIR` and `JOBPIPE_CONFIG` move one part of it somewhere else.


### What each action is called

The app uses one name for each thing it can do to a job, and **What each does** (next to the buttons) explains them:

| Name | Time | What it does |
|---|---|---|
| **Signal score** | ~30 seconds, one Claude call | A quick 1–10 read on how well your impact record fits the posting, with the strongest matches and likely gaps. |
| **Full score** | a few minutes, about four calls | Rates every requirement against your impact record and each résumé: a 1–10 score, a heat map and the gaps to confirm. No résumé is written. |
| **Make résumé** | ~25 minutes, about eleven calls | The full score (reused if there is one), three drafts, the best merged and checked, a PDF and a fit report. While it runs, the job's badge fills with its progress and time left. On the command line it's `tailor`. |

Searches (the **Filters** tab): **Check filters** (≤1 credit per filter), **Search + signal score**, and **Search + make résumés for top N**.

## Set it up for yourself

### The easy way: download the Mac app

1. On this repo's GitHub page, open **Releases** and download the DMG for your Mac: `Job-Search-…-arm64.dmg` for Apple silicon (M1 and later), `Job-Search-…-x86_64.dmg` for Intel. (Apple menu → About This Mac → Chip says which.)
2. Open it and drag **Job Search** into **Applications**.
3. Open **Job Search** from Applications. If macOS says it can't check the app for malicious software, open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Job Search. That's needed once, and only for a build that wasn't notarized.
4. The app opens in your browser on a made-up example profile. Go to **Profile**:
   - **AI:** choose who does the work. With a Claude Pro or Max plan, click **Sign in to Claude…** (it opens Terminal: type `/login`, sign in, close it); if it says Claude Code isn't installed, install the [Claude app](https://claude.ai/download) first. Or pick another AI and paste its key.
   - **About you**, **Contact line** and **Your résumés:** your details, and your résumés as markdown.
5. Write your record of past work in the **Impact record** tab ([step 3 below](#3-add-your-evidence) says what goes in it). This is the part that matters.
6. To search for jobs, get a [JobsPipe](https://jobspipe.dev) key (the free plan gives 1,000 jobs) and paste it under **Profile → Other keys**. Without one you can still add jobs by link and use the Startups tab.

The app keeps running while it's open; quitting it (⌘Q) stops it, and clicking it in the Dock opens the page again. Your files are all in `~/JobSearch`, so a new version of the app (it tells you when there is one) never touches them. Python, the app's packages and the PDF renderer are inside the app; the local [evidence checks](#evidence-checks-local-models) aren't, because their models need PyTorch (about 1 GB), so the app's runs skip them.

### Or run it from the code

The steps below get the app running for a new person on a Mac from a clone of this repo. Steps 3 and 4 are the real work: the pipeline is only as good as the evidence you give it.

### 1. What you need

- **A Mac** (the scripts are written for macOS; Linux may work) with **Python 3.10+** and **git**.
- **An AI to do the work.** The default, and the one the app is tuned on, is **Claude through a Pro or Max subscription** with the **Claude Code CLI** ([install guide](https://docs.claude.com/en/docs/claude-code/setup)): run `claude` once and sign in with `/login`, and calls count toward your plan's usage limits instead of costing anything per call. You can use ChatGPT, Gemini, OpenRouter or a free model on your own Mac (Ollama, LM Studio) instead: see [Which AI does the work](#which-ai-does-the-work).
- **A JobsPipe account** from [jobspipe.dev](https://jobspipe.dev). The free plan gives 1,000 credits once; one credit buys one job.
- **Notion** (optional): a workspace where you can add an integration. Without it the tracker still works, on your Mac only.

### 2. Get the code and start the app

```bash
git clone https://github.com/Alexander-C-Carnes/job-search-app.git job-search && cd job-search
./jobsearch install                  # once: puts `jobsearch` on your PATH
jobsearch run                        # first time: builds .venv, installs packages and the PDF browser, opens the app
```

The first start makes your profile folder, `~/JobSearch`, as a copy of `example-profile/`: a made-up candidate, Jordan Rivera, so you can look around the app before you've added anything. (To keep it somewhere else, set `JOBPIPE_HOME` before the first start, e.g. `export JOBPIPE_HOME=~/Dropbox/JobSearch` in `~/.zshrc`.) The app opens in your browser at `http://127.0.0.1:8765/?token=…`. Bookmark that URL.

You never edit files in the repo itself, so `jobsearch update` can always pull the latest code.

### 3. Add your evidence

Everything Claude knows about you comes from your profile's `references/` folder.

**The impact record** (`references/impact-record.md`). Replace Jordan's with your own. This matters more than anything else in the setup. Write it as a long markdown document, one section per role or major project, covering:

- what the problem was, what you did, and what changed because of it;
- numbers wherever you have them (team sizes, percentages, money, time saved, counts);
- the tools, methods and domains involved, in the words a job posting would use;
- your location, work authorization and anything else postings ask about;
- at the end, what can and can't be claimed: figures you've withdrawn or can't back up, and things not to overstate.

It can be long (10,000 words is fine). Claude only uses what's written down, so detail you leave out can't appear in a résumé. A good way to build one is to ask Claude to interview you about each job, then edit the result. You can write and edit it in the app: the **Impact record** tab shows it formatted, like Typora, and saves it back as markdown.

**Your existing résumés** (`references/resume-<name>.md`, any number). These are scored alongside the impact record and give the writers a format to follow. Add them in the app with **Profile → Add a résumé**: a PDF or Word file (saved from the program you wrote it in, not a scan), Markdown or plain text. Claude sorts it into the markdown shape below using only your file's words, the app checks that word by word, and you see your file beside the result, fix anything it flags, and save; the original is kept in `references/originals/`. Or put the files there yourself. How the PDFs look is a separate choice: **Profile → Résumé format** (Signature, Executive, Modern, Minimal, or Compact on one page). At least one should use the markdown shape the PDF renderer reads:

```markdown
# Your Name
**Headline | Years | Focus areas**
City, ST | +1 555-555-5555 | you@example.com | linkedin.com/in/you

## SUMMARY
Two or three sentences.

## PROFESSIONAL EXPERIENCE

**Company** | Job Title
*Jan 2022–Present | Remote*

- Bullet with a result and a number.

## CORE SKILLS
Hard Skills: Skill | Skill | Skill
Soft Skills: Skill | Skill | Skill
```

Delete Jordan's `resume-platform.md` once yours are in.

**Confirmed facts** (the impact record's `# Confirmed facts` section). Leave this out at first. It's added when you answer a fit report's follow-up questions with **Add a confirmed fact** in the **Impact record** tab: each answer goes at the end of the record, dated and marked user-confirmed. (A `references/user-notes.md` from an older version still counts; move its lines into the record whenever you like.)

**Interview prep** (`data/interview-prep.md`). Created the first time you open the app's **Interview prep** tab: a page for stories you need to find, examples and numbers to dig up, and questions to get ready for. Edit it formatted like the impact record; `- [ ] ` makes a checkbox you can tick. It's a plain markdown file, so you can also ask Claude to add to it, and the open tab shows the change. It isn't used for scoring or résumés.

### 4. Say who you are

Open the app's **Profile** tab, fill in your name, pronouns and contact line, tick the résumés to score against, and click **Save profile**. Until you do, it says you're looking at the example profile.

The tab writes the `candidate:` section at the top of your `searches.yaml`, which you can also edit by hand:

```yaml
candidate:
  name: Your Name
  pronouns: she/her                # he/him, she/her or they/them
  city: Portland, OR               # résumés fail check_resume.py without it on the contact line
  phone: +1 555-555-5555
  email: you@example.com
  linkedin: linkedin.com/in/you
  pdf_prefix: Your-Name-Resume     # PDFs are <prefix>-<Company>-<Title>.pdf (this is the default)
  resumes:                         # your files from step 3: a name (a heat-map column) -> file
    Platform resume: resume-platform.md
    Leadership resume: resume-leadership.md
  evidence: the impact record, every user-confirmed note, and the resume variants
  withdrawn: ["41.2%"]             # figures your impact record withdrew; a résumé showing one fails the check
```

Every prompt, the PDF file names and the contact-line check read it: the method's briefs and rules in `skill/` say `{name}`, `{first}`, `{contact}` and `{city}`, and call the candidate he/him, and those are filled in with your details and pronouns as they're loaded. `evidence` is how the quick triage prompt describes your materials, so name a section there if your impact record has one worth pointing at.

`jobpipe/render.py` (`CSS`) sets the PDF's look: red accent (`#E50815`), font, spacing. Changing it is optional.

`skill/SKILL-*.md` are the skill files for running the same method in a Claude chat. The app only reads the Stage 4 section of `SKILL-resume-job-fit.md` (personalized like the briefs), so you need them only if you also want to use the skill in Claude.

### 5. Add your keys

The first start copied `.env.example` to `~/JobSearch/.env`. Fill in:

| Key | Where to get it |
|---|---|
| `JOBSPIPE_API_KEY` | The jobspipe.dev dashboard. It starts with `jp_live_` |
| `NOTION_TOKEN` | Optional. notion.so/profile/integrations → **New integration** (internal) → copy the secret. Then connect it to your tracker database: open the database → `…` → **Connections** → add the integration |
| `FUNDABLE_API_KEY`, `THEIRSTACK_API_KEY`, `PDL_API_KEY` | Optional, for the Startups tab's **Look up the round**. Any one is enough. [Fundable](https://www.tryfundable.ai): 200 free lookups, then $20/month. [TheirStack](https://theirstack.com): 50 free company lookups a month. [People Data Labs](https://www.peopledatalabs.com): 100 free a month |

Leave `ANTHROPIC_API_KEY` empty unless you switch to the API backend; if it's set, the default backend removes it from Claude Code's environment anyway, so your subscription is used.

### 6. Set up the Notion tracker (optional)

Skip this if you don't use Notion: it's off (`notion.enabled: false`) in a new profile.

The app writes to a Notion database with these properties. Names and types must match exactly:

| Property | Type | Notes |
|---|---|---|
| `Name` | Title | Written as "Job title — Company" |
| `Company` | Text | |
| `Job URL` | URL | Rows are matched by this, so it must be unique per job |
| `Status` | Status | Options: `Not started`, `In progress`, `Blocked`, `Applied`, `Interviewing`, `Offer`, `Denied`, `Done`, `Not Applying`. Notion's API can't add options, so add any that are missing by hand |
| `Type` | Select | The app only reads and writes rows where this is `Apply to Job`, so the database can hold other tasks too |
| `Fit Score` | Number | |
| `Notes` | Text | The app updates its own score line and keeps anything else you write |
| `Priority` | Select | Read only; any options |
| `Due/Submitted` | Date | Read only |
| `Resume Used` | Files & media | The PDF you sent, uploaded from the app's **Sent résumé** tab |
| `Project` | Relation | Optional: links each row to a project page |

Then, in your `searches.yaml` under `notion:`:

- set `data_source_id` to your database's data source ID (in Notion: open the database → `…` → **Manage data sources** → copy the ID);
- set `project_page_id` to the page the `Project` relation should point to, or leave it empty to skip it;
- set `enabled: true`.

### 7. Write your searches

Edit your `searches.yaml`:

- **`defaults`**: country, how recent (`posted_within_days`), salary floor (`min_salary_usd`), the most jobs per search (`limit`), and title words to exclude.
- **`searches`**: one block per search, each with an `id`, a `name`, the `titles` to match, and `remote: true` or `work_arrangement: ["hybrid"]` plus `locations`. The example profile's four (TPM and Engineering Manager, remote and hybrid in Portland) are there to copy from. Replace them.
- **`budget`**: `max_credits_per_run`, and your plan's `allowance` (`{amount: 1000, period: once}` on the free plan; on a paid plan, its monthly credits and `period: monthly`).
- **`pipeline`**: the lowest signal score that gets a résumé (`shortlist_min_fit`) and how many résumés to make per run (`tailor_top`).

You can also edit searches in the web app's **Filters** tab, which writes back to this file.

### 8. First run

Start small, and check each step before spending more credits or Claude usage. From a Terminal window in the repo:

```bash
.venv/bin/python -m jobpipe show-request          # the API request each search sends (free)
.venv/bin/python -m jobpipe preflight             # matches per search (at most 1 credit each); confirms the API accepts the filters
.venv/bin/python -m jobpipe run --no-tailor       # search and signal score only
.venv/bin/python -m jobpipe jobs                  # what it found, with scores
.venv/bin/python -m jobpipe tailor <job id>       # Make résumé for one job
```

Everything here can also be done from the app: run searches in **Filters**, score jobs in **Find jobs**, and watch progress in **Runs**. Read the first fit report closely. Weak scores or thin résumés usually mean the impact record is missing something; add it, or answer the report's questions with **Add a confirmed fact**, and make the résumé again.

### 9. Run the tests

```bash
.venv/bin/python -m pytest -q
```

They run offline (JobsPipe, Notion and Claude are mocked), so they're safe to run any time. They run as the example profile's made-up candidate in a temporary folder, so they never read or change your profile.

### Making a Mac app release

`mac/build.sh` builds `build/Job Search.app` and a DMG on the Mac you run it on: it downloads a standalone Python ([python-build-standalone](https://github.com/astral-sh/python-build-standalone)), installs `requirements.txt` into it (without pytest and sentence-transformers), adds headless Chromium for the PDFs, copies `jobpipe/`, `skill/` and `example-profile/`, and compiles the launcher (`mac/Launcher.swift`), which starts the server and opens the page. With a "Developer ID Application" certificate in your keychain it signs everything; `--notarize` also sends it to Apple, so it opens with no warning (`mac/build.sh --help` lists the options).

Releases go out on their own once a day (07:00 UTC) when the code changed since the last one: the **Mac app** workflow (`.github/workflows/mac-app.yml`) tags the next version (v0.1.0 → v0.1.1), builds the Apple silicon and Intel DMGs on GitHub's Macs, and publishes them as a GitHub Release once both builds pass, which is free for a public repo. Installed apps offer the new version the next time they open. To release sooner, push a tag (`git tag v0.2.0 && git push origin v0.2.0`), or use **Actions → Mac app → Run workflow** and tick *release*; without the tick it's a test build. It signs and notarizes the DMGs when the repo has the secrets listed at the top of that file; without them they're unsigned, and people click **Open Anyway** once.

### Keeping it updated

`jobsearch update` pulls the latest code and reinstalls packages if `requirements.txt` changed; `jobsearch go` does that and restarts the app. Your profile folder isn't in the repo, so updates never conflict with your files.

**Back up your profile folder.** It's the only copy of your evidence and tracker. Keep it in a synced folder (set `JOBPIPE_HOME`), or make it a private git repo of its own: `cd ~/JobSearch && git init`.

**From a checkout made before profile folders,** where your files were in the repo: the first start after updating copies them (`searches.yaml`, `.env`, `skill/references/`, `resume-runs/`, `data/`, `outputs/`) into `~/JobSearch` and points the stored paths at the new folders. It leaves the originals; delete them from the repo once everything looks right. To run it yourself: `.venv/bin/python -m jobpipe.legacy /path/to/old/checkout`.

---

The rest of this file is reference for day-to-day use.

## Commands

```bash
python -m jobpipe show-request                 # the exact API body for each saved search (free)
python -m jobpipe preflight                    # how many jobs match each search (≤ 1 credit each)
python -m jobpipe run                          # everything: search → signal score → make résumés for top 3 → Notion → digest
python -m jobpipe run --search tpm-remote --top 1
python -m jobpipe run --no-tailor              # signal score only (cheap), then make résumés by hand:
python -m jobpipe tailor <job id>              # Make résumé for one stored job
python -m jobpipe tailor --jd-file posting.txt --job-title "Staff TPM" --company Acme --url https://...
python -m jobpipe search --title "Director of Engineering" --hybrid --location "Portland" --limit 5
python -m jobpipe jobs                         # stored jobs with signal scores
python -m jobpipe startups refresh             # funding news + YC directory + VC boards -> data/startups.json, then their
                                               # careers boards: roles matching your filters land in Find jobs (free)
python -m jobpipe startups scan --limit 100    # just the careers boards
python -m jobpipe startups score --limit 30    # signal-score startup roles in Find jobs (one Claude call each)
python -m jobpipe startups track --min-fit 7   # add the scored startup roles at 7+ to the tracker
python -m jobpipe check-postings               # move roles whose posting has closed to Dismissed
python -m jobpipe startups list --stage "Series B" --days 30
python -m jobpipe startups roles <startup id> --add   # its open roles; --add stores the ones matching your filters
python -m jobpipe startups enrich <startup id>  # look up its latest round (FUNDABLE_API_KEY, THEIRSTACK_API_KEY or PDL_API_KEY)
python -m jobpipe credits                      # JobsPipe credit ledger
python -m jobpipe serve                        # local web app (see below)
```

Outputs go to `outputs/<date>/`: the résumé PDFs, `report-*.md`, `heatmap-*.html`, `apply-*.md` and `digest.md`. Each job's working files (`jd.md`, `01-objectives.md` … `resume-final.md`, scorecards, checks) are in `outputs/<date>/runs/<job>/`. Both are in your profile folder, out of git.

## Web app

```bash
./jobsearch install      # once: makes `jobsearch` work from any folder
jobsearch run            # start the app and open it (if it's already running, just open it)
jobsearch update         # get the latest code and packages
jobsearch go             # update, then run (restarting the app if it's running on an older version)
jobsearch restart        # stop the app and start it again, e.g. after merging a change
```

`restart` and `go` won't stop the app while a run is going (they say so); add `--force` to stop it anyway. Restarting from a new Terminal window stops the app in the old one and runs it in the new one.

The app opens at `http://127.0.0.1:8765/?token=…`; keep its Terminal window open (Ctrl+C stops it). The first run sets up `.venv` (Python packages and the PDF browser), and packages are reinstalled whenever `requirements.txt` changes, so nothing needs activating. `./start.sh` is the same as `jobsearch run`. On a Mac, `python` alone isn't a command outside `.venv`; use `python3` or `.venv/bin/python`.

Bookmark the URL it prints; the token in it stays the same until you delete `data/web-token`.

| Tab | What it does |
|---|---|
| **Tracker** | The jobs you're tracking, kept on this Mac and synced with your Notion "Apply to Job" rows (see "The tracker and Notion" below). Search by role, company or location (press `/`); the stage strip counts and filters Not started / In progress / Blocked / Applied / Interviewing / Offer / Denied (you applied and were turned down, e.g. not offered an interview) / Done / Not Applying (jobs you've ruled out: a poor fit, or little chance of an interview. They stay in the tracker so searches don't bring them back, and they aren't counted in the tab's open total); the **Starred**, **Has referral**, **Remote** (fully remote only, not hybrid) and **Has résumé** chips narrow it further. **Group: Company** puts each company's roles together under a heading with their count and stages (click a heading to fold it; the setting and folded companies are remembered); on the board it labels each company within a column. **List** shows a role beside its detail; **Board** shows one column per stage, and dragging a card to another column sets its Status. Star a role with the star (or `s`; `j`/`k` move through the list). **Add referral** saves a link (and optionally a name) for the person referring you. |
| **Dashboard** | Your applications at a glance, from the tracker. **Jobs applied to** counts every job at Applied, Interviewing, Offer, Denied or Done, with how many in the last 7 days and today. **By stage** draws In progress, Applied, Interviewing, Offer and Rejected (the Denied stage) to scale; click one to open those jobs in the Tracker. **Applications per day** charts the last 14 or 30 days, or all of them (hover or tab to a day for its jobs; **Show as a table** lists them). A job's day is its Notion **Due/Submitted** date when that is set and not in the future, else the day its stage first became Applied or later, here or in Notion (moving it back to an earlier stage clears it). Jobs applied to before the dashboard existed got the day their tracker row last changed. Each look dresses it its own way: Sorbet's total is a scoop and the stages candy bars, Transit's a departures board over cased line segments, Bauhaus's a huge count on a yellow field, Arcade's a score counter over pixel HP bars. |
| **Find jobs** | New jobs from your filters that aren't in your tracker yet, with the same search, chips, stars and scoring. Filter New / Fit 7+ / Dismissed. **Track** adds a job to the tracker (Not started) and moves it to the Tracker tab; **Dismiss** hides it (see Dismissed to undo). Make résumé also tracks the job: it moves to In progress as soon as the run starts (from Not started; a later stage stays). Filters don't add jobs to Notion on their own unless you set `notion.log_triaged_min_fit` in `searches.yaml`. **Add a job…** is for roles you find yourself: paste the posting's link and the app reads the title, company, location and description from the page (Greenhouse, Lever, Ashby, Workday, LinkedIn and most careers pages). If the page can't be read, paste the description. A link you already have opens that job instead of adding it twice. The job lands here, to score or tailor. |
| **Startups** | Startups that just raised a round, and which round. **Refresh sources** (free, about a minute, shown in Runs) reads funding news (Google News searches for "raises Series A/B/C/seed/pre-seed", plus the FinSMEs, TechCrunch, Crunchbase News and AlleyWatch feeds; a headline like "Acme raises $20M Series B" becomes the company, the amount and the round), the YC directory (companies that say they're hiring, with their batch), and VC portfolio job boards (General Catalyst, Techstars, Accel, Insight Partners, Khosla Ventures) searched for your filters' titles, each company with its stage. Views: **Raised recently** (a round in the last 90 days), **YC hiring**, **All**, **Dismissed**; round chips (Pre-seed … Series D+, Growth, Unknown) narrow the list. Open roles come on their own: each refresh first stores every matching role it already holds (the VC boards list roles with each company), then reads the startups' careers boards (Greenhouse, Lever or Ashby, found from each website; no JobsPipe credits), raises first and then startups that say they're hiring, up to 300 a refresh. Every role that answers one of your filters (its title, and not a sales, pre-sales, support or junior variant of it; remote or one of the filter's locations; not pinned to another region) is added to Find jobs with its round. With `startups.roles.signal_score: true`, each new one is scored against your impact record as it arrives, so **Fit 7+** filters them by your experience; with `startups.roles.track_min_fit: 7` as well, a role scoring 7 or more goes straight to the tracker (Not started) instead of waiting in Find jobs, and `python -m jobpipe startups track` adds the ones scored before you set it. Each refresh also re-checks that the roles in Find jobs are still open and moves closed ones to Dismissed, tagged Closed. **Hiring for you** lists the startups with such a role. While the app is open it refreshes the sources on its own once a day (`startups.auto_refresh_hours`). A startup's page shows the round, the headline it came from (a headline the app read, so check the article before quoting it), where it was seen, and its open roles; **Find open roles** reads its board again now, and **Add to Find jobs** stores a role that didn't match. **Track company** adds an "Open roles — Acme" card to the tracker with the round while you watch for the right role. **Look up the round** asks Fundable, TheirStack or People Data Labs (a key in `.env`; all have free allowances) for a startup the news didn't cover. **Add a startup…** adds one you heard of by name and website. Settings are the `startups:` section of `searches.yaml`: how recent a raise counts, the feeds and searches, YC batches/industries/regions, the VC boards, keywords, how many boards a refresh reads (`roles`), how often it refreshes on its own, and how many unknown rounds to look up per refresh. Kept in `data/startups.json`. |
| **Posting & score** (inside a job) | The posting, formatted for reading, with two scores beside it. **Signal score** is the quick check: one Claude call rates each requirement in the posting against your impact record and confirmed facts, and the app turns that coverage into a 1–10 score (about 60% is 6, 70% is 7, 80–90% is 8, above that 9). It lists the strongest matches, hard requirements to check and likely gaps; open "Covers N%…" to see each rated requirement. Location, relocation and work authorization are listed as things to check and never lower the score. **Full score** runs stages 1–2 of the Make résumé pipeline (about four calls, a few minutes): every requirement rated against the impact record and each résumé, the ATS scorecard for your existing résumés, a heat map and the gaps to confirm. Make résumé reuses it later. Both work for stored jobs, pasted jobs and jobs that are only in Notion (the posting is read from its page). Scoring a job doesn't track it (click **Track** for that) unless `notion.log_triaged_min_fit` is set (for a startup role, `startups.roles.track_min_fit`), in which case a signal score at or above it does, as a pipeline run would. If Claude can't run, the reason stays on screen (for example, that the CLI needs `/login`). |
| **Batch scoring** (either list) | Tick rows (or the box above the list for everything shown) and choose **Signal score** or **Full score**, or click **Signal-score N unscored**. Jobs are queued on the server, three signal scores at a time, one full score at a time; the list shows progress and **Stop the rest** drops the ones still waiting. The fit tile shows the full score where there is one (marked with a bar under the number), otherwise the signal score. |
| **Résumé** (inside a job) | The PDF, its version history, and **Chat with Claude** (via your subscription): a conversation about this résumé and role that remembers what you've said. Ask a question ("what would a recruiter question here?") and Claude answers without touching the résumé; ask for a change, or say yes to one Claude suggested, and it returns the revised résumé plus a note on what changed, the evidence behind it, and any risk (such as a title you haven't held). Enter sends; **New chat** starts over (versions are kept), and the conversation is saved in the run's `versions/chat.json`. The app re-renders the PDF, runs `check_resume.py` and the keyword score, and shows a highlighted diff. Nothing is saved until you click **Accept**; accepted edits become v2, v3, … and also update `resume-final.md` and the deliverable PDF. **Restore** brings back any earlier version. **Edit on page** (above the PDF) lets you change the wording yourself: the résumé is drawn in the PDF's layout, you click a line and type, and **Save** keeps it as a new version, re-renders the PDF and runs the same checks. Dashed lines show roughly where the pages break. **Edit as text** opens the markdown for changes the page can't make, such as adding a bullet or a job. A résumé made elsewhere can be edited this way too. |
| **Sent résumé** (inside a job) | The exact PDF sent with an application, for every job marked Applied, Interviewing, Offer, Denied or Done (rows without one are tagged **No résumé on file**). Marking a job Applied (or a later stage) keeps the app's current résumé for it (the version is noted) unless one is already on file; **Upload the PDF you sent…** or **Replace…** adds any PDF, and **Use the app's résumé** saves the current version. It's kept in `data/sent/`, so later edits never change it, and sent to the Notion row's **Resume Used** on the next sync, unless that already holds a file, which is never replaced. A file added in Notion's Resume Used shows here too. |
| **Résumé made elsewhere** (inside a job) | A tracked job the app didn't make a résumé for (for example, one you made with the `resume-job-fit` skill in a Claude chat) shows a résumé from `resume-runs/<company>-<role>/` or `references/resume-*.md`. The app picks the one whose file name matches the job's company and title (every word of `acme-staff-tpm` in "Acme · Staff TPM"); use the menu above the PDF to pick another, or none. It's copied into `data/linked/`, so version history and edits never change the repo. A skill run folder can be edited by chatting with Claude; a saved résumé on its own can't, because it has no posting or match brief. |
| **Fit report / Heat map** | The report and interactive heat map from Make résumé. The report ends with **Questions before I finalize**, one per unconfirmed gap: answer them with **Add a confirmed fact** in the **Impact record** tab, then make the résumé again. A full score also makes a heat map. Before either has run, these tabs say so and offer the button that fills them. |
| **Filters** | Your saved JobsPipe searches, called filters in the app. **New filter** adds one (its id is made from the name); **Edit**, **Duplicate** and **Delete** change one at a time. Each change is written to `searches.yaml` at once, comments kept. Tick which to run, then **Preflight**, **Search + score**, or **Search + score + tailor top N**; the bar shows the most credits the run can spend. **Show request** on a card shows the exact request it sends JobsPipe, with the defaults filled in (free). **Search once**, in the New/Edit filter dialog, runs what's in the dialog without saving it: up to its jobs-per-run in credits, plus a quick score of each new job unless you untick **Score what it finds**. Its jobs show in Find jobs as found by `one-off`. |
| **Runs** | Live output of the runs going now and earlier runs. Up to three run at once, so you can make several résumés side by side; searches still go one at a time (they spend credits), and one job's résumé can't be made by two runs at once. A signal or full score shows on the job, not here. The bar at the top shows how many are going. When a run ends, **Results** above its output lists each job it scored or made a résumé for, with buttons that open the job's Fit report, Résumé or posting. |
| **Impact record** | Your impact record (`references/impact-record.md`), with an outline of its sections. **Formatted** shows it like Typora: formatted text you edit in place, where markdown you type (`## `, `- `, `**bold**`) turns into formatting. **Markdown** shows the text, and **Side by side** the text with a preview; ⌘/ switches between Formatted and Markdown. Blocks you didn't touch are saved exactly as they were, so a save changes only what you edited. It saves a moment after you stop typing, on ⌘S and when you switch tabs. If the file was changed elsewhere meanwhile, nothing is overwritten: a banner offers to load that version or save yours over it. The text a save replaces is kept in `data/impact-record-history/`. **Add a confirmed fact** answers a fit report's follow-up question: it saves your edits, then adds the answer, dated and marked user-confirmed, to the record's `# Confirmed facts` section at the end (making the section if there isn't one), and every later score and résumé edit uses it at exactly the scope you wrote. |
| **Profile** | Who the résumés are for: your name, pronouns and contact line, the PDF file-name prefix, and which résumés in `references/` to score against (tick them, name each one, pick the fallback; **Add a résumé** uploads a `.md`). Saved to the `candidate:` section of `searches.yaml`, comments kept; not while a run is going. |

Stars and referral links are kept in `data/marks.json`; they are not written to Notion.

**The tabs** sit in groups: **Find jobs** | **Tracker**, **Startups** | **Filters**, **Runs** | **Impact record**, **Interview prep** | **Dashboard**. **Profile** is the round person button at the top right.

**Looks.** The **Look** card at the top of Profile (or the palette button in the top bar) picks how the app looks on this computer: **Sorbet** (the default: candy colours, round shapes, the stage strip as a ribbon of scoops sized by count; confetti on Applied), **Transit** (the pipeline as a transit line with stations and exits, a departures-board list; a split-flap board on Applied), **Bauhaus** (flat colour fields, huge black counts, a strict grid; a green wipe on Applied), **Arcade** (a daylight 8-bit HUD with the pipeline as an XP bar; "APPLICATION SENT! +100 XP" on Applied) or **Classic** (the original compact grey). Each has its own sad cat for Denied. Every look has the same tabs, buttons and shortcuts; the choice is kept in the browser, not in `searches.yaml`. Each look also has its feedback moments: marking a role **Applied** fires confetti from the Applied scoop and a banner that counts what's out the door, **Interviewing** a smaller burst (Transit's board reads NEXT STOP · INTERVIEW, Arcade's BOSS FIGHT!, Bauhaus wipes violet), **Offer** the biggest one of all (TERMINUS · OFFER, YOU WIN! +1000 XP, a pink OFFER! field), **Done** a smaller one, and **Denied** brings a sad fat cat with how many roles are still in play. A role's header shows where it stands on the line (Not started, In progress, Applied, Interviewing, Offer, Done, and which exit it took), with the usual next move beside the status menu (**Mark applied**; after applying **Interviewing** or **Denied**; then **Offer**, then **Mark done**; **Back to in progress** from an exit), and the Résumé tab draws the fit, résumé, ATS and keyword scores as meters. The looks are stylesheets in `jobpipe/web/static/themes/` (fonts bundled, so nothing loads from outside), their moments live in `static/theme.js`, and `prefers-reduced-motion` turns the confetti off.

**The round chip.** A role whose company is in the Startups tab, by website or by name, shows its funding round on the row, the board card and the job header (`Series B $20M`; `YC W26` when only the batch is known), with the headline it came from a click away. The **Startup** chip filters either list to those roles. Tracking the role puts the round in the tracker's Notes line and the Notion page body, so it reads "Triaged … · Series B · $20M · Oct 2026 (FinSMEs)".

The impact-record editor is [Milkdown](https://milkdown.dev) (MIT), bundled into `jobpipe/web/static/vendor/editor.js` so the app works offline and loads no outside scripts. To change it, edit `tools/editor/editor.js`, then run `npm install && npm run build` in `tools/editor/`.

The job list is served from memory: job files and `state.json` are re-read only when they change on disk, and tracked jobs come from the local tracker, so the list never waits on Notion.

### The tracker and Notion

The tracker lives in `data/tracker.db` (SQLite) on this Mac. That file is the source of truth for which jobs are tracked and their status, so **Track** and status changes are instant and work when Notion can't be reached. Notion is a synced copy:

- A change made in the app, or by a pipeline run, is saved locally and queued. The next sync sends it to Notion. Rows waiting are marked **To sync**, and the header says how many changes are waiting.
- Each sync then reads Notion. Jobs added there (for example by the `resume-job-fit` skill) appear in the app, and a status edited in Notion replaces the local one. If both sides changed the same job's status before a sync, the app's change wins.
- A row deleted in Notion is removed here on the next sync. A job with no URL stays local, because Notion rows are matched by Job URL.
- The app syncs in the background about once a minute while it's open, right after each change, and when you click **Sync**. If Notion is failing, the header says so and nothing is lost.

Without `NOTION_TOKEN` (or with `notion.enabled: false`) the tracker works the same, on this Mac only. On first run it starts from the app's last Notion snapshot (`data/notion-cache.json`), if there is one.

The edit loop follows the same honesty rules as the pipeline: every claim must trace to the impact record, your confirmed facts, or the job's evidence ledger, the do-not-claim list is binding, and Claude declines (and says so) when an instruction asks for something the evidence doesn't support.

Security: the server listens on 127.0.0.1 only, rejects requests that aren't addressed to localhost, and every API call needs the token. Job pages render posting text as plain text, and the fit report escapes any HTML in it.

## Filters (saved searches)

The app calls these filters; the file and the command line call them searches.

Edit your `searches.yaml`. The example profile's four saved searches:

| id | Titles | Where | Pay |
|---|---|---|---|
| `tpm-remote` | Technical Program Manager, Principal Program Manager, Program Manager, Technical | remote | $200k+ |
| `em-remote` | Engineering Manager, Manager, Engineering, Manager, Software Engineering | remote | $200k+ |
| `tpm-hybrid` | same TPM titles | hybrid, Portland | $200k+ |
| `em-hybrid` | same EM titles | hybrid, Portland | $200k+ |

Add a search by copying a block. Anything the file doesn't model can go under `api_filters:` and is sent to the API as-is. Ad-hoc queries (`--title`, `--remote`, `--hybrid`, `--location`, `--min-salary`, `--days`, `--limit`) aren't saved.

**Check these once with `preflight`:** `work_arrangement_or`, `job_location_or` and `min_salary_usd` come from JobsPipe's own integration code, not its Python SDK. A request the API rejects costs 1 credit and is never retried; the error shows in `preflight` and `credits`.

## Startup sources

What the Startups tab reads, and what was looked at and left out (checked October 2026). Everything used is free and needs no key, except the round lookups.

| Source | Gives | How |
|---|---|---|
| Google News RSS searches (`"raises" "Series A"`, …) | Round headlines from every outlet it indexes, including the wires that block scripts (FinSMEs, Business Wire, PR Newswire, Pulse 2.0) | `news.google.com/rss/search?q=…`, 100 newest items a query; the publisher after " - " in the title is kept as the source |
| FinSMEs, TechCrunch (venture), Crunchbase News, AlleyWatch (New York) feeds | FinSMEs has the most regular "Acme Raises $8M in Series A Funding" headlines; AlleyWatch is a daily New York funding report | RSS. FinSMEs answers a feed reader's User-Agent only, which the app sends when a feed refuses it |
| YC directory via [yc-oss/api](https://github.com/yc-oss/api) | Every YC company: batch, hiring flag, team size, industries, regions, website. No round (YC's own label is Early/Growth) | Daily JSON mirror of YC's public index; keyless, unlike YC's own search index, whose key rotates |
| VC portfolio boards on Getro (General Catalyst, Techstars, Accel, Insight Partners, Khosla Ventures) | Roles across each portfolio with the company's stage (pre-seed … series H, IPO, acquired, undisclosed) | `api.getro.com/api/v2/collections/<network>/search/jobs`, 20 a page; the network id is read from the board's page. Add any `jobs.<firm>.com` board that runs on Getro under `startups.vc_boards` |
| Greenhouse, Lever, Ashby public job-board APIs | A startup's open roles, with location, remote flag and the posting text | Found from a link on the company's website or careers page, else by trying the company's name as the board name. Each refresh reads up to 300 boards (newest raise first; a board is re-read after a day, a site with no board after two weeks) and the roles answering your filters go to Find jobs |
| Fundable, TheirStack, People Data Labs (optional, keys) | The latest round of a company the news didn't cover | One lookup a click, or up to `startups.enrich.per_refresh` a refresh |

Looked at and not used: **Crunchbase** (no API for individuals since the Basic API ended; enterprise only), **Harmonic**, **Dealroom's full API**, **PitchBook**, **CB Insights**, **Tracxn**, **Specter** (all sales-gated, thousands a year); **Wellfound**, **Built In** and **Work at a Startup** job pages (no API, and their terms forbid scraping); **Consider**-run VC boards such as jobs.lsvp.com (free but need a session token, and only say Seed / Series A / Growth); **SEC EDGAR Form D** (free and authoritative for US raises, with the amount sold and date, but it never names the round and half the filings are funds; a good later addition); **Hacker News "Who is hiring?"** (free, stage only when the comment says it); **Dealroom's free feed** (a few stale items); **VentureBeat** (blocks scripts), **Axios Pro Rata**, **Term Sheet** and **StrictlyVC** (no deal data in their feeds or dead); **Wikidata** (no funding data). The round in a headline is read by a pattern, so a company named oddly in a headline ("Neocloud PaleBlueDot AI") can land under the wrong name; the headline is kept beside every round so you can check.

## JobsPipe credits

One credit buys one job for the rest of the calendar month; re-running a search only charges for jobs you haven't had this month, and an empty result is free. So the cost is the number of distinct jobs your filters let through, not how often you run. The pipeline:

- caps each search at its `limit` and each run at `budget.max_credits_per_run` (40), lowering `limit` when the budget runs short;
- tracks every call in `data/credits.json` against `budget.allowance` (the free plan's 1,000 credits are one-time; set `period: monthly` on a paid plan). In the app, click the credits count in the header for the ledger: used and left, use by month, and each call with its filter, result, jobs returned, credits charged and the request it sent;
- filters on JobsPipe's side before you pay; the local filters (remote/hybrid, pay floor, closed postings) only drop jobs already paid for.

## Which AI does the work

Pick it on the **Profile** tab, under **AI**: the provider, its key, and a model and effort for each step (signal score, analysis, writing). It's saved in `models:` in your `searches.yaml` and the key in your profile's `.env`. **Check connection** lists the provider's models, which also confirms the key works.

| Provider (`models.backend`) | How you pay | Key in `.env` |
|---|---|---|
| Claude, your subscription (`claude-code`, the default) | Your Pro or Max plan; nothing per call | none: sign in to Claude Code |
| Claude API (`api`) | Per call | `ANTHROPIC_API_KEY` |
| ChatGPT, OpenAI API (`openai`) | Per call (a ChatGPT subscription doesn't include it) | `OPENAI_API_KEY` |
| Gemini, Google AI API (`gemini`) | Per call; check Google for a free allowance | `GEMINI_API_KEY` |
| OpenRouter (`openrouter`): models from many companies | Per call; a few models are free | `OPENROUTER_API_KEY` |
| Ollama or LM Studio on your Mac (`ollama`, `lmstudio`) | Free | none |
| Any other OpenAI-compatible API (`openai-compatible`, with `models.base_url`) | Depends | `OPENAI_COMPATIBLE_API_KEY`, if it needs one |

Things to know before switching from Claude:

- **Quality.** The briefs and rules were tuned on Claude Opus. Every résumé still goes through the same format, honesty-trace and ATS checks, and broken output is asked for again, but a weaker model writes weaker résumés and fit scores.
- **Size.** Every candidate-facing step reads your whole impact record, every résumé and the rules at once, often 30,000 tokens or more. A local model needs a context window that large (Ollama: set `OLLAMA_CONTEXT_LENGTH=65536` and restart it; LM Studio: load the model with a 64k context). If a server cuts the prompt short, the step stops with an error rather than scoring on half your record.
- **Cost.** Make résumé is about 11 calls with all of that material, so on a pay-per-call provider it costs real money per job. The same materials go first in every request, so providers that cache repeated prompts (OpenAI does, automatically) charge less for them.
- **Effort** is sent as `reasoning_effort`; a model that doesn't take it gets the request again without it.

Signing in with a ChatGPT or Google subscription (instead of an API key) isn't supported yet: OpenAI's Codex CLI can't be fully stopped from using its own tools, and Google has retired the Gemini CLI's personal sign-in.

### Claude through your subscription


Every Claude step runs through the Claude Code CLI (`claude -p`), which uses your Claude subscription (Pro/Max) instead of API credits (`models.backend: claude-code`, the default). The pipeline uses the first `claude` that starts: each one on your PATH, then `~/.local/bin/claude`, then the CLI bundled with the Claude desktop app, so an old install that crashes under a newer Node is skipped. Set `CLAUDE_BIN` or `models.claude_bin` to choose one yourself. The CLI must be signed in: run `claude` and use `/login`. Each agent runs with no tools, no MCP servers and no skills; `ANTHROPIC_API_KEY` is removed from its environment so Claude Code can't bill an API key instead of your login. Calls count toward your plan's usage limits: triage is one short call per job (15 jobs took about 2 minutes), and a full tailoring run is about 11 calls. Each command prints its token totals at the end.

All stages use Claude Opus 5.5 (`models:` in `searches.yaml`; triage at low effort, analysis at medium, writing at high). The impact record, résumé variants, rules and rubric form one system prompt shared by every candidate-facing agent. To use the Claude API instead, set `models.backend: api` and put `ANTHROPIC_API_KEY` in your profile's `.env`; that path needs API credits.

## Evidence checks (local models)

Three small open models from Hugging Face run on your Mac, on its GPU (`jobpipe/evidence.py`). They are downloaded once, about 4 GB in all, into `~/.cache/huggingface`, and nothing is sent anywhere. Your impact record, résumé variants and confirmed facts are split into short passages; anything under "Do not claim", the withdrawn metrics and the record's methodology notes are left out. The passages' vectors are cached in `data/evidence/` until the evidence changes.

| Model | Size | What it does here |
|---|---|---|
| [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 0.6B, Apache-2.0 | finds the passages closest to a keyword or a résumé line |
| [Qwen/Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | 0.6B, Apache-2.0 | judges whether a passage shows work a posting keyword directly describes |
| [MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli](https://huggingface.co/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli) | 0.4B, MIT | judges whether the evidence states what a résumé line or a supported keyword claims (natural-language inference) |

- **Honesty check** (`honesty.md` in the run folder). Every figure in a bullet must appear in the ledger entries its trace cites, the passages closest to it, or your confirmed facts. Each bullet's claims (the part after its posting lead phrase, split at semicolons) must be entailed by that evidence. Summary sentences combine several claims, so they are checked for figures only. If a line fails, one Claude pass reviews the flagged lines with your full record: it keeps a line the evidence supports and says where, rescopes one that claims too much, or cuts it. Lines still flagged after that show up in the run's warnings and the report's "Lines to check".
- **Keyword evidence** (`keyword-evidence.md`). Each posting keyword the merged résumé is missing gets the passages that best support it and a verdict: supported, weak or none. Supported needs two things: the reranker finds a relevant passage, and the NLI model finds that a passage states the work ("This work involved mentoring program managers"). Relevant but not stated is weak: a record of mentoring junior analysts is relevant to "mentoring program managers" (1.00) but doesn't state it (0.00). Supported keywords go to the keyword pass, which adds a phrase only to a line that already uses that evidence. The report's "truthful adds vs. don't add" split comes from the verdicts on the final PDF.

How well it works, on three earlier Make résumé runs (Oct 2026): 2 of 69 résumé lines that had been reviewed were flagged, both paraphrases just under the threshold. The review pass is there to keep lines like these. 6 of 7 made-up lines were flagged, such as a "Realized $12 million in savings" line where the record says the savings were only *modeled*. The check that needs no model also caught invented figures. The reranker alone couldn't do the honesty check: it scores whether evidence is on topic, so that $12 million line scored 0.998. On a run these checks add about a minute, plus one Claude call when a line is flagged or a keyword is supported.

Settings are in the `evidence:` section of `searches.yaml`: the three model names, `device`, and `enabled`. With `enabled: false`, or without the `sentence-transformers` package, the pipeline runs as before, and only the figure check runs. That check uses all your evidence, not each line's own.

## How the skill was ported

`skill/` holds the `resume-job-fit` method (the app fills in the `candidate:` from your `searches.yaml` as it loads the briefs): the five agent briefs, `resume-rules.md`, `scoring-and-report.md`, and the three scripts (`check_resume.py`, `ats_score.py`, `heatmap.py`). The Python orchestrator (`jobpipe/tailor.py`) does what the skill's orchestrator does:

| Skill stage | Here |
|---|---|
| 0: fetch posting | `jd.md` from the JobsPipe description, falling back to the employer's page when the listing is a stub; never scored from a title alone |
| 1: agents 01-03 in parallel | same briefs; they see only `jd.md` |
| 2: matcher | same brief; `ratings.json` / `keywords.json` are validated and re-requested once if malformed |
| 3: writers A/B/C in parallel | same brief and lenses; each draft goes through `check_resume.py`; a rater call rates each draft literally for the draft scorecard |
| 4: merge | the skill's Stage 4 text as the merge brief; `check_resume.py` on the result, one fix pass on FAIL; the local [evidence checks](#evidence-checks-local-models), with one honesty review pass for flagged lines; one keyword-restore pass if Total % drops below the best draft or the evidence supports a missing keyword |
| 5: PDF | `jobpipe/render.py` in the format chosen on the Profile tab (`jobpipe/formats.py`); tightens spacing once, then trims (deleting only) if over the format's page limit (two pages; one in Compact); scorecard re-run on the PDF text |
| 6: report | `heatmap.py` + the report template |
| 7: Notion | `jobpipe/tracker.py` records the job locally with the same update rules (never moves Blocked, Applied or any later stage back, keeps your Notes text) and `jobpipe/notion.py` copies it to Notion with the same properties, now or on the next sync |

Agents have no tools: the orchestrator passes each file they are told to read as a named document and parses the files they return.

### References

The matcher and triage score the impact record and every résumé listed under `candidate.resumes`, all from your profile's `references/`. Answers to follow-up questions go in the record's `# Confirmed facts` section (the **Impact record** tab's **Add a confirmed fact** puts them there); every run treats them as user-confirmed evidence. `skill/references/` holds only the method: `resume-rules.md` and `scoring-and-report.md`.

## JobsPipe in Claude

- **Claude Code:** `.mcp.json` registers the JobsPipe MCP server (`https://mcp.jobspipe.dev/mcp`) using `JOBSPIPE_API_KEY` from your environment.
- **claude.ai / Claude desktop:** Settings → Connectors → Add custom connector → URL `https://mcp.jobspipe.dev/mcp`, then sign in.

## Applying

The pipeline stops before submitting. For each tailored job, `apply-*.md` has the link, the PDF name, the posting's hard constraints and a checklist. Submit yourself, or have Claude in Chrome fill the form and stop for your review; answer work authorization, self-identification and certification questions yourself. Then set Status to Applied and Resume Used in Notion.

## How close the signal score is to the full score

`python tools/calibrate_signal.py --repeat 2` runs the signal scorer on the jobs in `data/calibration/` (postings whose full score from Make résumé is known from the tracker) and prints the gap for each. The aim is an average gap within half a point. On 13 tracker jobs in October 2026 the average gap was −0.3 points (it was −1.4 before the scorer was changed to rate requirements the way the matcher does) and every job was within one point; three jobs Make résumé scored 9 came out 8. All 13 score 6–9 there, so weak fits are checked only loosely. It makes real Claude calls, stores nothing and does not touch Notion.

## Tests

```bash
python -m pytest -q
```

They run offline: JobsPipe, Notion and Claude are mocked (a stand-in `claude` executable for the Claude Code runner; the real SDK with a mock transport for the API runner), while the real `check_resume.py`, `heatmap.py` and PDF renderer run. The evidence models are switched off, and `tests/test_evidence.py` uses word-overlap stand-ins for them. They run for the example profile's made-up candidate (`example-profile/`), in a temporary folder, never your profile.
