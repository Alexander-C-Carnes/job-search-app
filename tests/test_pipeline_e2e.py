import asyncio
import json

import httpx
from pypdf import PdfReader

from jobpipe import config
from jobpipe.jobs_api import JobsClient
from jobpipe.notion import NotionTracker
from jobpipe.pipeline import Pipeline
from jobpipe.store import Store
from conftest import TITLE, FakeJobsAPI, FakeNotion, FakeRunner, jobspipe_client, make_job, notion_row


def build(tmp_dirs, jobs, fits, notion_rows=None):
    cfg = config.load()
    cfg.tailor_top = 1
    cfg.notion_log_triaged_min_fit = 7  # exercise auto-logging of triaged jobs
    fake_api = FakeJobsAPI(jobs)
    store = Store()
    fake_notion = FakeNotion(notion_rows)
    tracker = NotionTracker(cfg.notion_data_source_id, cfg.notion_project_page_id, token="t",
                            client=httpx.Client(transport=httpx.MockTransport(fake_notion)))
    runner = FakeRunner(fits)
    p = Pipeline(cfg, store=store, jobs=JobsClient(cfg, store, client=jobspipe_client(fake_api)),
                 runner=runner, tracker=tracker, log=lambda s: None, fetch_pages=False)
    return p, runner, fake_notion


def test_full_run(tmp_dirs):
    jobs = {"Technical Program Manager": [make_job("best"), make_job("ok", company="Beta"),
                                          make_job("weak", company="Gamma"),
                                          make_job("cheap", company="Delta", lo=100000, hi=150000),
                                          make_job("stub", company="Eps", description="tiny")],
            "Engineering Manager": [make_job("applied", title="Engineering Manager", company="Zeta"),
                                    make_job("passed", title="Engineering Manager", company="Theta"),
                                    make_job("turned-down", title="Engineering Manager", company="Iota")]}
    applied_url = "https://boards.greenhouse.io/acme/jobs/applied"
    p, runner, notion = build(tmp_dirs, jobs, {"best": 9, "ok": 7, "weak": 4},
                              notion_rows=[notion_row("p0", applied_url, status="Applied"),
                                           notion_row("p9", "https://boards.greenhouse.io/acme/jobs/passed",
                                                      status="Not Applying"),
                                           notion_row("p8", "https://boards.greenhouse.io/acme/jobs/turned-down",
                                                      status="Denied")])
    digest = asyncio.run(p.run([p.cfg.search("tpm-remote"), p.cfg.search("em-remote")]))

    labels = [c.label for c in runner.calls]
    # triage ran for usable, unknown jobs only (not the underpaid, stub, already-applied, denied or ruled-out ones)
    assert sorted(l for l in labels if l.startswith("triage:")) == ["triage:best", "triage:ok", "triage:weak"]
    # the full skill ran once, for the best job, in stage order
    stages = [l for l in labels if not l.startswith("triage:")]
    assert stages[:3] == ["01-objectives", "02-skills", "03-experience"]
    assert stages[3:] == ["04-matcher", "05-writer-A", "05-writer-B", "05-writer-C", "rate-drafts",
                          "merge", "rate-final", "report"]
    # stage 1 agents never see the candidate materials; writers share a cached prefix with a lens tail
    assert all(not c.candidate for c in runner.calls if c.label in ("01-objectives", "02-skills", "03-experience"))
    assert all(c.tail.startswith("Your lens:") for c in runner.calls if c.label.startswith("05-writer"))
    merge = next(c for c in runner.calls if c.label == "merge")
    assert "Pool the issues" in merge.instructions      # the skill's Stage 4 text is the merge brief

    out = config.OUTPUTS
    day = next(out.iterdir())
    pdf = day / f"Jordan-Rivera-Resume-Acme-{TITLE.replace(' ', '-')}.pdf"
    assert pdf.exists() and len(PdfReader(str(pdf)).pages) == 2
    assert (day / f"heatmap-Acme-{TITLE.replace(' ', '-')}.html").exists()
    run_dir = next((day / "runs").iterdir())
    for f in ("jd.md", "04-match.md", "ratings.json", "resume-draft-A.md", "checks-drafts.md",
              "scorecard-baseline.md", "scorecard-final.md", "resume-final.md", "report.md"):
        assert (run_dir / f).exists(), f
    assert "RESULT: PASS" in (run_dir / "checks-final.md").read_text()
    assert "Tailored resume" in (run_dir / "scorecard-final.md").read_text()
    assert list(day.glob("apply-*.md"))

    # Notion: tailored job In progress, 7/10 triaged job Not started, 4/10 job not logged
    created = {r["_create"]["properties"]["Name"]["title"][0]["text"]["content"]:
               r["_create"]["properties"] for r in notion.rows.values() if "_create" in r}
    assert created[f"{TITLE} — Acme"]["Status"]["status"]["name"] == "In progress"
    assert created[f"{TITLE} — Acme"]["Fit Score"]["number"] == 9.0      # impact-record score
    assert "Tailored resume 9.0/10" in created[f"{TITLE} — Acme"]["Notes"]["rich_text"][0]["text"]["content"]
    assert created[f"{TITLE} — Beta"]["Status"]["status"]["name"] == "Not started"
    assert not any("Gamma" in n for n in created)

    text = digest.read_text()
    assert "Delta" not in text.split("## Skipped")[0]
    assert "already Applied in Notion" in text and "already Not Applying in Notion" in text and "already Denied in Notion" in text and "pay tops out" in text
    assert "no posting text" in text

    # a second run doesn't re-triage (jobs already paid for this month are free)
    runner.calls.clear()
    p2, runner2, _ = build(tmp_dirs, jobs, {})
    asyncio.run(p2.run([p2.cfg.search("tpm-remote")], tailor=False))
    assert not [c for c in runner2.calls if c.label.startswith("triage:")]


def test_tailor_pasted_posting_logs_to_notion(tmp_dirs):
    p, runner, notion = build(tmp_dirs, {}, {})
    job = {"id": "manual", "job_title": TITLE, "company": "Acme", "url": "https://acme.com/jobs/9",
           "description": make_job()["description"]}
    c = asyncio.run(p.tailor_job(job))
    assert c.tailored and c.tailored.pdf.exists()
    assert not [x for x in runner.calls if x.label.startswith("triage:")]
    row = next(r for r in notion.rows.values() if "_create" in r)
    assert row["_create"]["properties"]["Status"]["status"]["name"] == "In progress"


def test_retailoring_archives_web_edit_history(tmp_dirs):
    p, runner, notion = build(tmp_dirs, {}, {})
    job = {"id": "manual", "job_title": TITLE, "company": "Acme", "url": "https://acme.com/jobs/9",
           "description": make_job()["description"]}
    c = asyncio.run(p.tailor_job(job))
    (c.tailored.run_dir / "versions").mkdir()
    (c.tailored.run_dir / "versions" / "history.json").write_text("{}")
    c2 = asyncio.run(p.tailor_job(job))
    assert c2.tailored.run_dir == c.tailored.run_dir
    assert not (c2.tailored.run_dir / "versions").exists()
    assert list(c2.tailored.run_dir.glob("versions-before-*"))


def test_resume_over_two_pages_is_trimmed(tmp_dirs, monkeypatch):
    from jobpipe import render
    real, calls = render.render_pdf, []

    def render_pdf(md, pdf, html=None):         # the merged resume runs to three pages; the trimmed one fits
        pages, text = real(md, pdf, html)
        calls.append(md)
        return (3 if len(calls) == 1 else pages), text

    monkeypatch.setattr(render, "render_pdf", render_pdf)
    p, runner, _ = build(tmp_dirs, {"Technical Program Manager": [make_job("best")]}, {"best": 9})
    c = asyncio.run(p.tailor_job(make_job("best")))
    labels = [x.label for x in runner.calls]
    assert labels[labels.index("merge"):] == ["merge", "rate-final", "trim", "rate-final", "report"]
    trim = next(x for x in runner.calls if x.label == "trim")
    assert "renders to 3 pages" in trim.instructions and "deleting only" in trim.instructions
    assert c.tailored.pages == 2 and not any("page" in w for w in c.tailored.warnings)
    merge = next(x for x in runner.calls if x.label == "merge")
    assert "Hard length limit" in merge.instructions
