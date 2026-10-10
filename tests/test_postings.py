"""Closed postings: found once, re-checked later, moved to Dismissed when they've closed."""
import json

import httpx

from jobpipe import postings
from jobpipe.store import Store


class FakeSites:
    def __init__(self):
        self.calls = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url, host = str(request.url), request.url.host
        self.calls.append(url)
        if host == "www.linkedin.com":
            return httpx.Response(200, text='<div class="closed-job">No longer accepting applications</div>' if "/4000000002" in url else "<div>Apply</div>")
        if host == "boards-api.greenhouse.io":
            return httpx.Response(404 if "/jobs/9" in url else 200, json={})
        if host == "api.lever.co":
            return httpx.Response(200, json={})
        if host == "api.ashbyhq.com":
            return httpx.Response(200, json={"jobs": [{"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]})
        if host == "gone.example":
            return httpx.Response(410)
        if host == "site.example":
            return httpx.Response(200, text="<html>This position has been filled.</html>", headers={"content-type": "text/html"})
        if host == "flaky.example":
            return httpx.Response(503)
        return httpx.Response(200, text="<html>Apply now</html>", headers={"content-type": "text/html"})


def test_is_closed_per_site():
    c = httpx.Client(transport=httpx.MockTransport(FakeSites()))
    closed = lambda url: postings.is_closed({"url": url}, c)
    assert closed("https://www.linkedin.com/jobs/view/engineering-manager-at-x-4000000002") is True
    assert closed("https://www.linkedin.com/jobs/view/2222222222") is False
    assert closed("https://boards.greenhouse.io/acme/jobs/9") is True
    assert closed("https://boards.greenhouse.io/acme/jobs/10") is False
    assert closed("https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") is False
    assert closed("https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") is False
    assert closed("https://jobs.ashbyhq.com/acme/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") is True
    assert closed("https://gone.example/jobs/1") is True
    assert closed("https://site.example/jobs/1") is True
    assert closed("https://open.example/jobs/1") is False
    assert closed("https://flaky.example/jobs/1") is None
    assert closed("") is None


def test_check_closed_dismisses_closed_roles_and_leaves_tracked_ones(tmp_dirs):
    store = Store()
    for jid, url in (("a", "https://www.linkedin.com/jobs/view/4000000002"), ("b", "https://open.example/jobs/1"),
                     ("c", "https://flaky.example/jobs/1"), ("t", "https://www.linkedin.com/jobs/view/4000000002")):
        store.save_job({"id": jid, "job_title": "EM", "company": jid.upper(), "url": url, "description": "x" * 700}, "s")
    c = httpx.Client(transport=httpx.MockTransport(FakeSites()))
    lines = []
    counts = postings.check_closed(store, tracked_ids={"t"}, client=c, log=lines.append)
    assert counts == {"checked": 3, "closed": 1, "unknown": 1}
    st = store.state()
    assert st["a"]["dismissed"] and st["a"]["closed_at"] and not st["b"].get("dismissed") and "closed_at" not in st["t"]
    assert all(st[j].get("posting_checked") for j in "abc") and not st["t"].get("posting_checked")
    assert any("closed: EM @ A" in l for l in lines)
    # checked recently: nothing to do again
    assert postings.check_closed(store, tracked_ids={"t"}, client=c, log=lines.append)["checked"] == 0


def test_the_board_tags_closed_roles(tmp_dirs):
    from jobpipe.web.board import JobBoard, Marks, TrackerSync
    from jobpipe.tracker import LocalTracker
    store = Store()
    store.save_job({"id": "a", "job_title": "EM", "company": "A", "url": "https://a/1", "description": "x" * 700}, "s")
    store.update("a", dismissed=True, closed_at="2026-10-06T10:00:00+00:00")
    board = JobBoard(store, TrackerSync(LocalTracker(tmp_dirs / "t.db")), Marks(tmp_dirs / "m.json"), lambda d: {})
    assert board.row("a")["closed"] == "2026-10-06T10:00:00+00:00" and board.row("a")["dismissed"]


def test_postings_you_applied_to_are_kept(tmp_dirs):
    from jobpipe.notion import TrackerEntry
    from jobpipe.tracker import LocalTracker
    store, t = Store(), LocalTracker(tmp_dirs / "t.db")
    store.save_job({"id": "full", "job_title": "EM", "company": "B", "url": "https://b.example/1", "description": "x" * 700}, "s")
    store.save_job({"id": "stub", "job_title": "TPM", "company": "C", "url": "https://c.example/1", "description": "short"}, "s")
    track = lambda title, company, url, status="Applied", jid=None: t.track(
        TrackerEntry(title=title, company=company, url=url, fit_score=None, notes="", status=status, body=[]), job_id=jid)
    track("Staff TPM", "Acme", "https://a.example/1")                 # only in the tracker
    track("EM", "B", "https://b.example/1", jid="full")               # its posting is stored already
    track("TPM", "C", "https://c.example/1?utm_source=x")             # stored, from a search, with a stub of a listing
    track("PM", "Gone", "https://gone.example/1")                     # the page has come down
    track("PM", "Later", "https://later.example/1", status="Not started")
    pages = {"https://a.example/1": {"job_title": "Staff TPM (page)", "location": "Remote", "remote": True,
                                     "description": "Run the release train. " * 30},
             "https://c.example/1?utm_source=x": {"description": "Own the roadmap. " * 30}}
    reads = []

    def read(url):
        reads.append(url)
        return {"url": url, **pages.get(url, {"description": ""})}
    counts = postings.keep_applied(store, t, read=read)
    rows = {r["company"]: r for r in t.rows()}
    assert counts["kept"] == 2 and counts["failed"] == [rows["Gone"]["page_id"]]
    assert sorted(reads) == ["https://a.example/1", "https://c.example/1?utm_source=x", "https://gone.example/1"]
    a = store.job(rows["Acme"]["job_id"])
    assert rows["Acme"]["job_id"] == "notion-" + rows["Acme"]["page_id"]           # the id scoring would give it
    assert (a["job_title"], a["company"], a["url"], a["location"], a["remote"]) == \
        ("Staff TPM", "Acme", "https://a.example/1", "Remote", True)
    assert a["description"].startswith("Run the release train.") and a["posting_kept"] and postings.has_posting(a)
    assert rows["C"]["job_id"] == "stub" and store.job("stub")["description"].startswith("Own the roadmap.")
    assert store.job("full")["description"] == "x" * 700 and rows["Later"]["job_id"] is None
    # kept for good: the next pass reads nothing but the page that couldn't be read
    reads.clear()
    assert postings.keep_applied(store, t, read=read)["kept"] == 0 and reads == ["https://gone.example/1"]
    # the app's keeper doesn't fetch a page that just failed again until RECHECK_HOURS have passed
    keeper = postings.PostingKeeper(store, t, read=read)
    reads.clear()
    keeper.run_once()
    keeper.run_once()
    assert reads == ["https://gone.example/1"]
