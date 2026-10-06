"""The local tracker: source of truth on disk, Notion as a synced copy."""
import json

import httpx
import pytest

from jobpipe.notion import NotionTracker, TrackerEntry
from jobpipe.tracker import LocalTracker
from conftest import FakeNotion, notion_row

URL = "https://boards.greenhouse.io/acme/jobs/1"


def entry(url=URL, status="Not started", fit=8.0, notes="Triaged 2026-10-01 · Quick fit 8/10 · good"):
    return TrackerEntry(title="Staff TPM", company="Acme", url=url, fit_score=fit, notes=notes, status=status, body=["b"])


def make(tmp_path, rows=None, seed=None):
    fake = FakeNotion(rows)
    notion = NotionTracker("ds", "proj", token="t", client=httpx.Client(transport=httpx.MockTransport(fake)))
    notion.backoff = (0, 0)
    return LocalTracker(tmp_path / "tracker.db", notion=notion, seed=seed), fake, notion


def status_in_notion(fake, pid):
    return fake.rows[pid]["properties"]["Status"]["status"]["name"]


def test_changes_are_local_first_and_queued_while_notion_is_down(tmp_path, monkeypatch):
    t, fake, notion = make(tmp_path, [notion_row("p1", "https://x.example/jobs/9", status="Applied", fit=7)])
    t.sync()
    assert [(r["page_id"], r["status"], r["pending"]) for r in t.rows()] == [("p1", "Applied", False)]

    def down(*a, **k):
        raise RuntimeError("Notion's servers returned an error (500).")
    for name in ("upsert_page", "set_status", "list_jobs"):
        monkeypatch.setattr(notion, name, down)
    assert t.upsert(entry(), job_id="j1") == ("created", "")           # tracked here even though Notion failed
    t.set_status("p1", "Done")
    rows = {r["page_id"]: r for r in t.rows()}
    new = next(r for r in rows.values() if r["job_id"] == "j1")
    assert rows["p1"]["status"] == "Done" and rows["p1"]["pending"] and new["pending"] and new["notion_page_id"] is None
    assert t.state()["pending"] == 2 and "500" in t.state()["error"]
    assert status_in_notion(fake, "p1") == "Applied" and len(fake.rows) == 1
    with pytest.raises(ValueError):
        t.set_status("p1", "Bogus")
    with pytest.raises(KeyError):
        t.set_status("nope", "Done")

    monkeypatch.undo()                                                   # Notion is back: the queue is sent
    t.sync()
    assert t.state() == {"notion": True, "synced": t.state()["synced"], "error": "", "pending": 0}
    assert status_in_notion(fake, "p1") == "Done" and len(fake.rows) == 2
    sent = next(r for r in t.rows() if r["job_id"] == "j1")
    assert sent["notion_page_id"] and sent["page_url"].startswith("https://notion.so/") and not sent["pending"]
    assert sent["page_id"] == new["page_id"]                             # its id here never changes
    assert t.version() == LocalTracker(tmp_path / "tracker.db").version()   # another process sees the same state


def test_pull_brings_in_notion_changes_but_unsent_local_ones_win(tmp_path, monkeypatch):
    t, fake, notion = make(tmp_path, [notion_row("p1", URL, status="Not started", fit=7, notes="mine")])
    t.sync()
    # edited in Notion, and a row added there (as the resume-job-fit skill does)
    fake.rows["p1"]["properties"]["Status"]["status"]["name"] = "In progress"
    fake.rows["p2"] = notion_row("p2", "https://y.example/jobs/2", status="Applied", fit=9)
    t.sync()
    assert {r["page_id"]: r["status"] for r in t.rows()} == {"p1": "In progress", "p2": "Applied"}
    assert t.known_urls() == {URL: "In progress", "https://y.example/jobs/2": "Applied"}

    # both sides change p1 before a sync: the change made here wins and is sent
    monkeypatch.setattr(notion, "set_status", lambda *a: (_ for _ in ()).throw(RuntimeError("down")))
    t.set_status("p1", "Blocked")
    fake.rows["p1"]["properties"]["Status"]["status"]["name"] = "Done"
    with pytest.raises(RuntimeError):
        t.sync()
    monkeypatch.undo()
    t.sync()
    assert {r["page_id"]: r["status"] for r in t.rows()}["p1"] == "Blocked" and status_in_notion(fake, "p1") == "Blocked"

    # tracking a job whose row already exists updates it by the old rules: status only moves Not started -> In progress
    assert t.track(entry(status="In progress", fit=9.0, notes="Scored 2026-10-01 · Tailored resume 9/10")) == "updated"
    p1 = next(r for r in t.rows() if r["page_id"] == "p1")
    assert p1["status"] == "Blocked" and p1["fit"] == 9.0 and p1["notes"].endswith("mine") and p1["pending"]
    t.sync()
    assert fake.rows["p1"]["properties"]["Fit Score"]["number"] == 9.0 and len(fake.rows) == 2   # no duplicate page

    # deleted in Notion: gone here too. An empty answer is not taken to mean everything was deleted.
    del fake.rows["p2"]
    t.sync()
    assert [r["page_id"] for r in t.rows()] == ["p1"]
    fake.rows.clear()
    t.sync()
    assert [r["page_id"] for r in t.rows()] == ["p1"]


def test_seed_from_the_old_snapshot_and_working_without_notion(tmp_path):
    snap = tmp_path / "notion-cache.json"
    snap.write_text(json.dumps({"rows": [{"page_id": "p1", "page_url": "https://notion.so/p1", "name": "Staff TPM — Acme",
                                          "company": "Acme", "job_url": URL, "status": "Applied", "fit": 8, "notes": "n",
                                          "priority": "", "due": ""}]}))
    t = LocalTracker(tmp_path / "tracker.db", notion=None, seed=snap)
    assert [(r["page_id"], r["notion_page_id"], r["status"]) for r in t.rows()] == [("p1", "p1", "Applied")]
    LocalTracker(tmp_path / "tracker.db", notion=None, seed=snap)        # seeding happens once
    assert len(t.rows()) == 1

    # no Notion at all: tracking still works, nothing waits, sync is a no-op
    assert t.upsert(entry(url="https://z.example/jobs/3"), job_id="j3") == ("created", "")
    assert t.track(entry(url=""), job_id="pasted-1") == "created"        # no URL: kept here, never sent
    t.set_status("p1", "Done")
    t.sync()
    assert t.state() == {"notion": False, "synced": None, "error": "", "pending": 0}
    assert {r["job_id"]: r["status"] for r in t.rows()} == {None: "Done", "j3": "Not started", "pasted-1": "Not started"}


@pytest.mark.parametrize("status", ["Denied", "Not Applying"])
def test_denied_and_not_applying_are_kept(tmp_path, status):
    t, fake, notion = make(tmp_path, [notion_row("p1", URL, status="Applied")])
    t.sync()
    t.set_status("p1", status)
    t.sync()
    assert status_in_notion(fake, "p1") == status
    # tailoring it later doesn't pull it back to In progress, and searches skip it
    t.track(entry(status="In progress", fit=5.0))
    t.sync()
    assert {r["page_id"]: r["status"] for r in t.rows()}["p1"] == status == status_in_notion(fake, "p1")
    assert t.known_urls() == {URL: status}


def test_not_applying_is_kept_and_a_missing_notion_option_is_explained(tmp_path):
    t, fake, notion = make(tmp_path, [notion_row("p1", URL, status="Not started")])
    t.sync()
    t.set_status("p1", "Not Applying")
    t.sync()
    assert status_in_notion(fake, "p1") == "Not Applying"
    # tailoring it later doesn't pull it back to In progress
    t.track(entry(status="In progress", fit=5.0))
    t.sync()
    assert {r["page_id"]: r["status"] for r in t.rows()}["p1"] == "Not Applying" == status_in_notion(fake, "p1")

    # a Notion database without the option: the error says what to add, and the change stays queued
    def no_option(request):
        if request.method == "PATCH":
            return httpx.Response(400, json={"object": "error", "status": 400, "code": "validation_error",
                                             "message": "Invalid status option."})
        return fake(request)
    notion.http = httpx.Client(transport=httpx.MockTransport(no_option))
    t.set_status("p1", "Not started")
    t.set_status("p1", "Not Applying")
    with pytest.raises(RuntimeError, match=r'add one in Notion'):
        t.sync()
    assert next(r for r in t.rows() if r["page_id"] == "p1")["pending"]


def test_applied_day_is_kept_for_the_dashboard(tmp_path, monkeypatch):
    import jobpipe.tracker as tracker_mod
    day = {"v": "2026-10-03"}
    monkeypatch.setattr(tracker_mod, "_today", lambda: day["v"])
    t, fake, notion = make(tmp_path, [notion_row("p1", URL), notion_row("p2", "https://x.example/jobs/2")])
    t.sync()
    applied_on = lambda: {r["page_id"]: r["applied_on"] for r in t.rows()}
    assert applied_on() == {"p1": "", "p2": ""}

    t.set_status("p1", "Applied")
    day["v"] = "2026-10-05"
    t.set_status("p1", "Interviewing")                 # a later stage keeps the day it was applied to
    assert applied_on()["p1"] == "2026-10-03"
    t.set_status("p1", "In progress")                  # moved back: not applied any more
    assert applied_on()["p1"] == ""

    # a status changed in Notion counts from the sync that sees it
    fake.rows["p2"]["properties"]["Status"]["status"]["name"] = "Offer"
    t.sync()
    assert applied_on()["p2"] == "2026-10-05"
    # Notion's Due/Submitted wins once it's set, unless it's still in the future
    fake.rows["p2"]["properties"]["Due/Submitted"] = {"date": {"start": "2026-09-30"}}
    t.sync()
    assert applied_on()["p2"] == "2026-09-30"
    fake.rows["p2"]["properties"]["Due/Submitted"] = {"date": {"start": "2026-10-20"}}
    t.sync()
    assert applied_on()["p2"] == "2026-10-05"


def test_a_tracker_from_before_the_applied_day_is_backfilled(tmp_path):
    import sqlite3
    db = tmp_path / "tracker.db"
    con = sqlite3.connect(db)
    con.executescript("""CREATE TABLE tracker (id TEXT PRIMARY KEY, notion_page_id TEXT UNIQUE, page_url TEXT NOT NULL DEFAULT '',
        job_id TEXT, name TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', job_url TEXT NOT NULL DEFAULT '',
        url_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', fit REAL, notes TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT '', due TEXT NOT NULL DEFAULT '', entry TEXT, dirty_status INTEGER NOT NULL DEFAULT 0,
        updated TEXT NOT NULL DEFAULT '');
        INSERT INTO tracker(id, status, updated) VALUES ('a', 'Applied', '2026-09-20T12:00:00+00:00'),
                                                      ('b', 'In progress', '2026-09-21T12:00:00+00:00');""")
    con.commit()
    con.close()
    t = LocalTracker(db)
    assert {r["page_id"]: r["applied_on"] for r in t.rows()} == {"a": "2026-09-20", "b": ""}
