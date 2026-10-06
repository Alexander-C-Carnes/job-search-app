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
