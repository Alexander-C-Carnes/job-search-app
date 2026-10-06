"""Is a posting still open? Roles in Find jobs are found once and otherwise never looked at again, so a role that
closed after it was found stays in the list. check_closed() asks the posting's page (or its applicant-tracking
system) and moves closed roles to Dismissed, tagged Closed.
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

import httpx

from .jd import linkedin_job_id, posting_url
from .store import now_iso

UA = "Mozilla/5.0 (jobpipe; checks whether a posting is still open)"
RECHECK_HOURS = 20
CLOSED_TEXT = re.compile(r"no longer accepting applications|this job is no longer available|job is no longer available|"
                         r"position has been filled|this position has been closed|job has been closed|posting has closed|"
                         r"this job has expired|job posting has expired|this job is closed|no longer open|has been filled|"
                         r"the job you are looking for is no longer|this role has been filled|this opening is closed", re.I)
LINKEDIN_CLOSED = re.compile(r'closed-job|"applicationStatus"\s*:\s*"closed"|No longer accepting applications', re.I)


def is_closed(job: dict, client: httpx.Client) -> Optional[bool]:
    """True if the posting is closed, False if it's open, None if that can't be told (don't touch it)."""
    url = posting_url(job)
    if not url:
        return None
    p = urlsplit(url)
    host = p.netloc.lower().removeprefix("www.")
    try:
        if host.endswith("linkedin.com"):
            jid = linkedin_job_id(url)
            if not jid:
                return None
            r = client.get(f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jid}")
            if r.status_code == 404:
                return True
            if r.status_code != 200:
                return None
            return bool(LINKEDIN_CLOSED.search(r.text))
        m = re.search(r"greenhouse\.io/(?:embed/job_app\?for=)?([^/?&]+)/jobs/(\d+)", url) or re.search(r"[?&]gh_jid=(\d+)()", url)
        if m and m.group(1) and m.group(2):
            r = client.get(f"https://boards-api.greenhouse.io/v1/boards/{m.group(1)}/jobs/{m.group(2)}")
            return True if r.status_code == 404 else False if r.status_code == 200 else None
        m = re.search(r"jobs\.lever\.co/([^/?#]+)/([0-9a-f-]{36})", url)
        if m:
            r = client.get(f"https://api.lever.co/v0/postings/{m.group(1)}/{m.group(2)}")
            return True if r.status_code == 404 else False if r.status_code == 200 else None
        m = re.search(r"jobs\.ashbyhq\.com/([^/?#]+)/([0-9a-f-]{36})", url)
        if m:
            r = client.get(f"https://api.ashbyhq.com/posting-api/job-board/{m.group(1)}")
            if r.status_code != 200:
                return None
            return not any(str(j.get("id")) == m.group(2) for j in r.json().get("jobs") or [])
        r = client.get(url)
        if r.status_code in (404, 410):
            return True
        if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
            return None
        return bool(CLOSED_TEXT.search(r.text))
    except (httpx.HTTPError, ValueError):
        return None


def check_closed(jobs_store: Any, *, tracked_ids: Optional[set[str]] = None, limit: int = 200, workers: int = 8,
                 client: Optional[httpx.Client] = None, log: Callable[[str], None] = lambda s: None) -> dict:
    """Re-check the untracked, undismissed roles in Find jobs that weren't checked in the last RECHECK_HOURS, oldest
    first. A closed one is dismissed and marked closed_at. Returns counts: checked, closed, unknown."""
    state = jobs_store.state()
    since = (datetime.now(timezone.utc) - timedelta(hours=RECHECK_HOURS)).isoformat(timespec="seconds")
    todo = [jid for jid, st in state.items() if not st.get("dismissed") and jid not in (tracked_ids or set())
            and (st.get("posting_checked") or "") < since]
    todo.sort(key=lambda j: state[j].get("posting_checked") or state[j].get("first_seen") or "")
    todo = todo[:limit]
    counts = {"checked": 0, "closed": 0, "unknown": 0}
    if not todo:
        log("Postings: every role in Find jobs was checked recently")
        return counts
    log(f"Postings: checking whether {len(todo)} role(s) in Find jobs are still open")
    c = client or httpx.Client(timeout=15, follow_redirects=True, headers={"User-Agent": UA})

    def one(jid: str) -> tuple[str, Optional[bool]]:
        job = jobs_store.job(jid)
        return jid, (is_closed(job, c) if job else None)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for jid, closed in pool.map(one, todo):
            counts["checked"] += 1
            if closed is None:
                counts["unknown"] += 1
                jobs_store.update(jid, posting_checked=now_iso())
                continue
            if closed:
                counts["closed"] += 1
                job = jobs_store.job(jid)
                jobs_store.update(jid, posting_checked=now_iso(), dismissed=True, closed_at=now_iso())
                log(f"  closed: {job.get('job_title')} @ {job.get('company')}")
            else:
                jobs_store.update(jid, posting_checked=now_iso())
    log(f"Postings: {counts['closed']} closed of {counts['checked']} checked"
        + (f" ({counts['unknown']} couldn't be told)" if counts["unknown"] else ""))
    return counts
