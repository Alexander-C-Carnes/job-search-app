"""Résumé versions and the chat with Claude about one tailored job.

Layout inside the job's run folder:
  versions/v1.md, v1.pdf      the pipeline's resume-final.md and its PDF
  versions/v2.md, v2.pdf ...  accepted edits
  versions/proposal.md/.pdf   a pending edit, until accepted or discarded
  versions/history.json       {"current": n, "versions": [...], "proposal": {...} | null}
  versions/chat.json          the conversation: [{"role": "user"|"claude"|"note", "text", "at", "proposal"?}]

Each message to Claude carries the conversation so far. Claude always replies, and writes a revised
résumé only when the candidate asks for a change, so questions and discussion cost no edit.
Claude edits the markdown, never the PDF. Every proposal is re-rendered, run through
check_resume.py and scored for posting keywords before the candidate sees it, and nothing
replaces the current version until they accept it.
"""
from __future__ import annotations

import asyncio
import difflib
import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .. import config, render
from ..config import Config
from ..llm import AgentCall, Runner, brief
from ..tailor import exact_title, normalize_keywords, run_script

EDIT_BRIEF = """# Resume chat

You're chatting with {name} about his tailored resume for one job, like a sharp recruiter who knows his record. The current resume, the job posting, and the match brief (evidence ledger, Do-not-claim list, posting keywords) are below; his impact record, user-confirmed notes and the resume rules are in the system prompt. The conversation so far and his new message come last.

Every turn, write `reply.md`: your chat message to him. Talk the way you would in a chat: direct, plain prose, short unless he asks for depth, no headings. Answer questions, give your honest opinion when he asks for it (how a line reads, what a recruiter would question, whether the resume fits the role), suggest changes, and ask a clarifying question when a request is ambiguous enough that guessing would waste an edit.

Only when he asks for a change, or says yes to one you suggested, also write `resume-edited.md`: the complete revised resume. Otherwise don't write it. If a proposed edit is still pending, the resume he's looking at is that proposal; when he's refining it ("shorter", "undo the second bullet"), build on it. In `reply.md` say briefly what you changed, the evidence or ledger IDs behind it where there are any, and any risk worth knowing.

It's his resume, so his instruction is final: make the change he asks for, exactly as he words it, even where it goes past the evidence, the Do-not-claim list, or the resume rules (a title or level in the headline, a broader scope, a number). Never decline, water it down, or swap in a "closest supported" version. If you think a change carries a risk (a claim a recruiter or reference check could question, a title he hasn't held, a failed format check), make it anyway and add a one-line note on the risk in reply.md.

Rules for everything you change on your own (his instruction overrides them):
1. Every claim you add must trace to the impact record, user-confirmed notes, or the evidence ledger in 04-match.md, at exactly the scope the source states ("contributed to" stays "contributed to"). Follow the Do-not-claim list.
2. The headline starts with the posting's exact title, level included, whether or not he held it. Anywhere else, don't add a level or title he hasn't held.
3. Keep the exact markdown shape of the writer brief (headings, job lines, italic date lines, CORE SKILLS with Hard Skills / Soft Skills lines, plain characters only).
4. Keep it to two pages: about 1,000 words at most.
5. Change only what he asks for. Keep the posting's own wording where the evidence supports it.
"""
CHAT_TURNS = 24     # earlier messages sent with each new one


class EditError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class ResumeWorkspace:
    run_dir: Path
    exported_pdf: Optional[Path] = None  # the pipeline's deliverable PDF; kept in sync with the current version

    @property
    def vdir(self) -> Path:
        return self.run_dir / "versions"

    @property
    def history_path(self) -> Path:
        return self.vdir / "history.json"

    # ---- state ---------------------------------------------------------------
    def history(self) -> dict:
        if not self.history_path.exists():
            self._init()
        return json.loads(self.history_path.read_text())

    def _save(self, h: dict) -> None:
        self.history_path.write_text(json.dumps(h, indent=2))

    def _init(self) -> None:
        src = self.run_dir / "resume-final.md"
        if not src.exists():
            raise EditError(f"No resume-final.md in {self.run_dir}")
        self.vdir.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, self.vdir / "v1.md")
        if self.exported_pdf and self.exported_pdf.exists():
            shutil.copy(self.exported_pdf, self.vdir / "v1.pdf")
        else:
            render.render_pdf(src.read_text(), self.vdir / "v1.pdf")
        check = self.check(self.vdir / "v1.md")
        self._save({"current": 1, "proposal": None, "versions": [{
            "n": 1, "created": _now(), "source": "pipeline", "instruction": "", "changes": "",
            "keywords_pct": self.keyword_pct((self.vdir / "v1.md").read_text()), "check": check}]})

    def md(self, n: Optional[int] = None) -> str:
        n = n or self.history()["current"]
        return (self.vdir / f"v{n}.md").read_text()

    @property
    def chat_path(self) -> Path:
        return self.vdir / "chat.json"

    def chat(self) -> list[dict]:
        return json.loads(self.chat_path.read_text()) if self.chat_path.exists() else []

    def _say(self, role: str, text: str, **extra) -> None:
        msgs = self.chat()
        msgs.append({"role": role, "text": text, "at": _now(), **extra})
        self.vdir.mkdir(parents=True, exist_ok=True)
        self.chat_path.write_text(json.dumps(msgs, indent=2))

    def clear_chat(self) -> list[dict]:
        self.chat_path.unlink(missing_ok=True)
        return []

    def pdf_path(self, which: str) -> Path:
        """which: a version number or 'proposal'."""
        self.history()
        p = self.vdir / ("proposal.pdf" if which == "proposal" else f"v{int(which)}.pdf")
        if not p.exists():
            raise EditError(f"No PDF for {which}")
        return p

    # ---- checks ----------------------------------------------------------------
    def title(self) -> str:
        obj = self.run_dir / "01-objectives.md"
        return exact_title(obj.read_text(), "") if obj.exists() else ""

    def keyword_pct(self, text: str) -> Optional[float]:
        kw_path = self.run_dir / "keywords.json"
        if not kw_path.exists():
            return None
        kw = normalize_keywords(json.loads(kw_path.read_text()))[0]
        hits = sum(bool(re.search(p, text, re.I)) for p in kw.values())
        return round(100 * hits / max(1, len(kw)), 1)

    def check(self, md_path: Path) -> dict:
        title = self.title()
        if not title:
            return {"passed": None, "output": "No exact title found; check skipped."}
        code, out = run_script("check_resume.py", str(md_path), "--title", title, cwd=self.run_dir)
        return {"passed": code == 0, "output": out}

    def editable(self) -> bool:
        """Edits need the posting and the match brief; a saved résumé copied on its own has neither."""
        return (self.run_dir / "jd.md").exists() and (self.run_dir / "04-match.md").exists()

    # ---- edit loop ---------------------------------------------------------------
    async def propose(self, instruction: str, runner: Runner, cfg: Config) -> dict:
        """Send one chat message. Returns {"reply": str, "proposal": {...} | None}; a proposal only
        when Claude revised the résumé, which replaces any pending one."""
        if not self.editable():
            raise EditError("This résumé was saved without its posting and match brief, so Claude can't edit it "
                            "here. Tailor the job in the app to get an editable copy.")
        # history() may render v1, and Playwright's sync API can't run on the event loop thread.
        h = await asyncio.to_thread(self.history)
        instruction = instruction.strip()
        if not instruction:
            raise EditError("Type a message first.")
        current = self.md(h["current"])
        cand = config.candidate()
        docs = {"jd.md": (self.run_dir / "jd.md").read_text(),
                "04-match.md": (self.run_dir / "04-match.md").read_text(),
                f"resume-current.md (v{h['current']})": current,
                "writer brief (for the resume shape)": brief("05-resume-writer.md")}
        pending = (self.vdir / "proposal.md").read_text() if h.get("proposal") and (self.vdir / "proposal.md").exists() else ""
        if pending:
            docs["resume-proposed.md (pending, not accepted yet; the PDF on screen)"] = pending
        who = {"user": cand.first_name, "claude": "You", "note": "(app)"}
        convo = "\n\n".join(f"{who.get(m['role'], m['role'])}: {m['text']}" for m in self.chat()[-CHAT_TURNS:])
        convo = convo or f"(this is {cand.first_name}'s first message)"
        tail = (f"The conversation so far:\n{convo}\n\n"
                f"{cand.first_name}'s new message:\n{instruction}"
                + (f"\n\nThe posting's exact job title: {self.title()}" if self.title() else ""))
        call = AgentCall(label="resume-edit", model=cfg.writer_model, instructions=cand.personalize(EDIT_BRIEF),
                         documents=docs, expect=["reply.md"], tail=tail)
        res = await runner.run(call)
        reply = res.files["reply.md"].strip()
        new_md = res.files.get("resume-edited.md", "")
        self._say("user", instruction)
        if not new_md.strip() or new_md.strip() == (pending or current).strip():
            self._say("claude", reply)
            return {"reply": reply, "proposal": None}
        prop_md = self.vdir / "proposal.md"
        prop_md.write_text(new_md)
        pages, _ = await asyncio.to_thread(render.render_pdf, new_md, self.vdir / "proposal.pdf")
        proposal = {"created": _now(), "instruction": instruction, "changes": reply,
                    "pages": pages, "check": await asyncio.to_thread(self.check, prop_md),
                    "keywords_pct": self.keyword_pct(new_md), "base": h["current"]}
        h["proposal"] = proposal
        self._save(h)
        self._say("claude", reply, proposal=True)
        return {"reply": reply, "proposal": {**proposal, "diff": diff(current, new_md)}}

    def accept(self) -> dict:
        h = self.history()
        p = h.get("proposal")
        if not p:
            raise EditError("No pending edit.")
        if p["base"] != h["current"]:
            raise EditError("The current version changed since this edit was proposed; ask again.")
        n = max(v["n"] for v in h["versions"]) + 1
        (self.vdir / "proposal.md").rename(self.vdir / f"v{n}.md")
        (self.vdir / "proposal.pdf").rename(self.vdir / f"v{n}.pdf")
        h["versions"].append({"n": n, "created": _now(), "source": "edit", "instruction": p["instruction"],
                              "changes": p["changes"], "keywords_pct": p["keywords_pct"], "check": p["check"]})
        h["current"], h["proposal"] = n, None
        self._save(h)
        self._export(n)
        self._say("note", f"Accepted the proposed edit as v{n}.")
        return h

    def discard(self) -> dict:
        h = self.history()
        for f in ("proposal.md", "proposal.pdf"):
            (self.vdir / f).unlink(missing_ok=True)
        if h.get("proposal"):
            self._say("note", "Discarded the proposed edit.")
        h["proposal"] = None
        self._save(h)
        return h

    def restore(self, n: int) -> dict:
        """Make an earlier version current again (as a new version, so history stays linear)."""
        h = self.history()
        if not any(v["n"] == n for v in h["versions"]):
            raise EditError(f"No version {n}")
        new = max(v["n"] for v in h["versions"]) + 1
        shutil.copy(self.vdir / f"v{n}.md", self.vdir / f"v{new}.md")
        shutil.copy(self.vdir / f"v{n}.pdf", self.vdir / f"v{new}.pdf")
        old = next(v for v in h["versions"] if v["n"] == n)
        h["versions"].append({**old, "n": new, "created": _now(), "source": f"restored v{n}",
                              "instruction": "", "changes": f"Restored version {n}."})
        h["current"] = new
        self._save(h)
        self._export(new)
        self._say("note", f"Restored v{n} as v{new}.")
        return h

    def _export(self, n: int) -> None:
        """Keep resume-final.md and the deliverable PDF equal to the current version."""
        shutil.copy(self.vdir / f"v{n}.md", self.run_dir / "resume-final.md")
        if self.exported_pdf:
            shutil.copy(self.vdir / f"v{n}.pdf", self.exported_pdf)


def diff(old: str, new: str) -> list[dict]:
    """Line-level diff with word-level detail for changed lines.
    Returns [{"op": "same"|"add"|"del"|"change", "old": str, "new": str, "words": [[op, text], ...]}]."""
    out: list[dict] = []
    a, b = old.splitlines(), new.splitlines()
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            out += [{"op": "same", "old": l, "new": l} for l in a[i1:i2]]
        elif tag == "delete":
            out += [{"op": "del", "old": l, "new": ""} for l in a[i1:i2]]
        elif tag == "insert":
            out += [{"op": "add", "old": "", "new": l} for l in b[j1:j2]]
        else:
            olds, news = a[i1:i2], b[j1:j2]
            for k in range(max(len(olds), len(news))):
                o = olds[k] if k < len(olds) else ""
                n = news[k] if k < len(news) else ""
                if not o:
                    out.append({"op": "add", "old": "", "new": n})
                elif not n:
                    out.append({"op": "del", "old": o, "new": ""})
                else:
                    out.append({"op": "change", "old": o, "new": n, "words": word_diff(o, n)})
    return out


def word_diff(old: str, new: str) -> list[list[str]]:
    a, b = re.findall(r"\S+|\s+", old), re.findall(r"\S+|\s+", new)
    ops: list[list[str]] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            ops.append(["same", "".join(a[i1:i2])])
        else:
            if i2 > i1:
                ops.append(["del", "".join(a[i1:i2])])
            if j2 > j1:
                ops.append(["add", "".join(b[j1:j2])])
    return ops
