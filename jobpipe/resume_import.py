"""Turn an uploaded résumé (PDF, Word, Markdown or plain text) into the résumé markdown the app reads.

read()      the file's text. A PDF must have real text (a scan is refused with what to do instead); a Word file is
            read from its XML with the standard library, page headers and tables included.
shape()     Claude sorts that text into the markdown shape render.py draws, using only the file's words.
heuristic() a rougher sort, for when Claude can't be reached.
verify()    proves the result word by word against the file, and lists what to look at before saving.

Nothing is saved here: the web app keeps the upload in data/imports/<id>/ until the candidate saves it from the
review screen, then copies the original to references/originals/.
"""
from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree as ET

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from . import render
from .config import ModelCfg
from .llm import AgentCall, Runner

MAX_BYTES = 5 * 1024 * 1024
MAX_XML = 20 * 1024 * 1024            # a Word file's unpacked XML; more is a zip bomb, not a résumé
MIN_PDF_WORDS = 50
KINDS = {".pdf": "PDF", ".docx": "Word file", ".md": "Markdown file", ".markdown": "Markdown file", ".txt": "text file"}
ACCEPT = ", ".join(KINDS)


class UploadError(ValueError):
    """Why a file can't be read, in words the candidate can act on."""


@dataclass
class Source:
    filename: str
    kind: str                         # a KINDS value
    text: str
    notes: list[str] = field(default_factory=list)   # "header", "table", "textbox"

    @property
    def ext(self) -> str:
        return Path(self.filename).suffix.lower()


# ---- reading ------------------------------------------------------------------------------------------
def read(filename: str, data: bytes) -> Source:
    ext = Path(filename).suffix.lower()
    if ext == ".doc":
        raise UploadError("That's an older Word file (.doc). Open it in Word or Pages, save it as .docx, then add that.")
    if ext == ".pages":
        raise UploadError("That's a Pages file. In Pages, choose File › Export To › Word or PDF, then add that.")
    if ext not in KINDS:
        raise UploadError(f"Add a PDF, a Word file (.docx), Markdown or plain text, not {ext or 'a file without an extension'}.")
    if not data:
        raise UploadError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise UploadError(f"That file is {len(data) / 1e6:.1f} MB; a résumé should be under 5 MB.")
    notes: list[str] = []
    if ext == ".pdf":
        text = _pdf(data)
    elif ext == ".docx":
        text, notes = _docx(data)
    else:
        text = data.decode("utf-8-sig", errors="replace")
    text = clean(text)
    if not re.search(r"\w", text):
        raise UploadError("There's no text in that file.")
    return Source(filename=filename, kind=KINDS[ext], text=text, notes=notes)


def clean(text: str) -> str:
    """Ligatures, odd spaces and line ends normalised; trailing spaces and runs of blank lines removed."""
    text = unicodedata.normalize("NFKC", text).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t   ]+\n", "\n", text.replace(" ", " "))
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def _pdf(data: bytes) -> str:
    try:
        pdf = PdfReader(io.BytesIO(data))
        if pdf.is_encrypted and not pdf.decrypt(""):
            raise UploadError("That PDF has a password. Save a copy without one, then add that.")
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    except (PdfReadError, ValueError, KeyError, TypeError) as e:
        if isinstance(e, UploadError):
            raise
        raise UploadError("That PDF can't be opened; it may be damaged. Export it again, or add the Word file.") from None
    if len(re.findall(r"\w+", text)) < MIN_PDF_WORDS:
        raise UploadError("This PDF has almost no text in it: it's a picture of a page, such as a scan or a photo. "
                          "Export it again from Word or Google Docs, or add the Word file.")
    return text


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx(data: bytes) -> tuple[str, list[str]]:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        names = set(z.namelist())
        if "word/document.xml" not in names:
            raise UploadError("That isn't a Word file the app can read. Save it as .docx again, or as a PDF.")
        if sum(i.file_size for i in z.infolist() if i.filename.endswith(".xml")) > MAX_XML:
            raise UploadError("That Word file is too large to be a résumé.")
        xml = lambda n: ET.fromstring(z.read(n))
        notes, lines = [], []
        head = []
        for n in sorted(x for x in names if re.fullmatch(r"word/header\d*\.xml", x)):
            for ln in _paragraphs(xml(n)):
                if ln.strip() and ln not in head:
                    head.append(ln)
        if head:
            notes.append("header")
            lines += head + [""]
        body = xml("word/document.xml").find(f"{W}body")
        for el in (body if body is not None else []):
            if el.tag == f"{W}p":
                lines.append(_para(el))
            elif el.tag == f"{W}tbl":
                if "table" not in notes:
                    notes.append("table")
                for tr in el.iter(f"{W}tr"):
                    cells = [" ".join(t for t in (_para(p) for p in tc.iter(f"{W}p")) if t.strip())
                             for tc in tr.findall(f"{W}tc")]
                    lines.append(" | ".join(c for c in cells if c.strip()))
        if body is not None and body.find(f".//{W}txbxContent") is not None:
            notes.append("textbox")
        return "\n".join(lines), notes
    except (zipfile.BadZipFile, ET.ParseError, KeyError):
        raise UploadError("That Word file can't be opened; it may be damaged. Save it again, or as a PDF.") from None


def _paragraphs(root) -> list[str]:
    return [_para(p) for p in root.iter(f"{W}p")]


def _para(p) -> str:
    out = []
    for el in p.iter():
        if el.tag == f"{W}t" and el.text:
            out.append(el.text)
        elif el.tag == f"{W}tab":
            out.append("\t")
        elif el.tag in (f"{W}br", f"{W}cr"):
            out.append("\n")
    text = "".join(out)
    ppr = p.find(f"{W}pPr")
    style = ppr.find(f"{W}pStyle") if ppr is not None else None
    listed = ppr is not None and (ppr.find(f"{W}numPr") is not None
                                  or (style is not None and "list" in (style.get(f"{W}val") or "").lower()))
    return f"• {text}" if listed and text.strip() else text


# ---- sorting into the markdown shape ------------------------------------------------------------------
SHAPE = """# Your Name
**Headline | Years | Focus areas**
City, ST | +1 555-555-5555 | you@example.com | linkedin.com/in/you

## SUMMARY
Two or three sentences.

## PROFESSIONAL EXPERIENCE

**Company** | Job Title
*Jan 2022–Present | Remote*

- Bullet with a result and a number.

## ADDITIONAL EXPERIENCE

**Company** | Job Title
*Jun 2015–Jul 2017*

One line about it.

## CORE SKILLS
Hard Skills: Skill | Skill | Skill
Soft Skills: Skill | Skill | Skill

## EDUCATION
Degree, Subject, School

## INTERESTS
Interest | Interest
"""

SHAPE_BRIEF = """# Sort a résumé into sections

The document `resume.txt` is a résumé read from a {kind}. Write `resume.md`: the same résumé in the markdown shape below, so the app can draw it and score jobs against it.

Use only the words in the file. Keep every line of content word for word and in its order within its section: don't rewrite, shorten, merge, reword, add anything, or fix spelling. The only changes you may make:
- Put the content under these headings: ## SUMMARY, ## PROFESSIONAL EXPERIENCE, ## ADDITIONAL EXPERIENCE (only if the file separates older or other roles), ## CORE SKILLS, ## EDUCATION, ## INTERESTS. A section the file has that fits none of them keeps its own heading in capitals (for example ## CERTIFICATIONS).
- Write each role as `**Company** | Job title`, then its dates on the next line in italics: `*Mon YYYY–Mon YYYY | Location*`, with Present for a current role. Rewrite dates like 01/2021 or January 2021 as Jan 2021. Leave out the location if the file has none for that role.
- Start every bullet with `- `, whatever character the file used. A line under a role that isn't a bullet in the file stays a plain line.
- Join a line the file broke in the middle of a sentence.
- Separate skills with ` | `, one line per group the file has, keeping its group names (`Hard Skills: A | B | C`).
- Leave out page numbers, "Page 2 of 2", a name and contact header repeated on later pages, and "References available on request".

The first three lines are `# Full Name`, then `**headline**` (the title line under the name in the file; if it has none, the most recent job title), then the contact details on one line separated by ` | `.

Also write `notes.md`: one short line for each thing you couldn't place or had to guess (a date you couldn't read, a section you weren't sure of), or just "None."

The shape:

```markdown
{shape}```
"""


def looks_shaped(text: str) -> bool:
    """Already the app's markdown (a .md made for it): a # name, a **headline**, ## sections."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return (len(lines) > 3 and lines[0].startswith("# ") and lines[1].startswith("**")
            and any(l.startswith("## ") for l in lines))


async def shape(src: Source, runner: Runner, model: ModelCfg) -> tuple[str, list[str]]:
    """Claude's markdown for the file, and its notes (things it couldn't place or guessed)."""
    res = await runner.run(AgentCall(
        label="resume-import", model=model, candidate=False,
        instructions=SHAPE_BRIEF.format(kind=src.kind, shape=SHAPE),
        documents={"resume.txt": src.text}, expect=["resume.md", "notes.md"]))
    md = res.files["resume.md"].strip()
    md = re.sub(r"^```(?:markdown)?\n|\n```$", "", md).strip() + "\n"
    notes = [l.strip("-• ").strip() for l in res.files.get("notes.md", "").splitlines()
             if l.strip("-• ").strip() and l.strip("-• .").strip().lower() != "none"]
    return md, notes


PHONE = r"(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}"
# The file's own headings, as the shape names them.
SAME_AS = {"PROFESSIONAL EXPERIENCE": {"EXPERIENCE", "WORK EXPERIENCE", "WORK HISTORY", "EMPLOYMENT", "EMPLOYMENT HISTORY",
                                       "CAREER HISTORY", "RELEVANT EXPERIENCE"},
           "CORE SKILLS": {"SKILLS", "TECHNICAL SKILLS", "KEY SKILLS", "CORE COMPETENCIES", "COMPETENCIES", "SKILLS & TOOLS"},
           "SUMMARY": {"PROFILE", "PROFESSIONAL SUMMARY", "ABOUT", "ABOUT ME", "PROFESSIONAL PROFILE", "OVERVIEW"}}
HEADING_WORDS = {"summary", "profile", "professional", "experience", "work", "history", "employment", "additional",
                 "core", "skills", "technical", "education", "interests", "certifications", "awards", "projects",
                 "publications", "volunteer", "languages", "competencies", "capabilities"}
BULLETS = "•●▪◦‣∙·–—*-"


MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
WHEN = rf"(?:{MONTH} \d{{4}}|\d{{1,2}}/\d{{4}}|\d{{4}})"
RANGE = re.compile(rf"({WHEN})\s*(?:[–—-]|to)\s*({WHEN}|Present|Current|Now|Today)\b\s*(.*)$", re.I)


def _when(w: str) -> str:
    """01/2021, January 2021 or 2021 as the shape writes it: Jan 2021 (or just 2021)."""
    if m := re.fullmatch(r"(\d{1,2})/(\d{4})", w):
        names = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
        return f"{names[int(m.group(1)) - 1]} {m.group(2)}" if 1 <= int(m.group(1)) <= 12 else m.group(2)
    if m := re.fullmatch(rf"({MONTH}) (\d{{4}})", w, re.I):
        return f"{m.group(1)[:3].title()} {m.group(2)}"
    return "Present" if w.lower() in ("present", "current", "now", "today") else w


def _role(line: str, prev: str) -> Optional[tuple[str, str, bool]]:
    """A line that ends in a date range: (role line, date line, whether the role line is the previous line)."""
    m = RANGE.search(line)
    if not m or m.start() and not re.search(r"[|,–—-]\s*$|\s$", line[:m.start()]):
        return None
    before = line[:m.start()].strip(" |,–—-\t")
    where = m.group(3).strip(" |,()\t")
    dates = f"{_when(m.group(1))}–{_when(m.group(2))}" + (f" | {where}" if where else "")
    split = lambda t: re.split(r"\s+\|\s+|\s+[–—]\s+|,\s+(?=[A-Z])|\s+at\s+", t, maxsplit=1)
    if before and len(split(before)) == 2:
        company, title = split(before)
        return f"**{company.strip()}** | {title.strip()}", f"*{dates}*", False
    if before and prev:                    # the company on the line above, the title on this one
        return f"**{prev}** | {before}", f"*{dates}*", True
    if prev and len(split(prev)) == 2:     # the role on the line above, the dates on this one
        company, title = split(prev)
        return f"**{company.strip()}** | {title.strip()}", f"*{dates}*", True
    return None


def heuristic(text: str) -> str:
    """A rough sort without the AI: name, headline and contact line, capitalised headings, bullets."""
    lines = [l.strip() for l in text.splitlines()]
    lines = [l for l in lines if not re.fullmatch(r"(page\s*)?\d+(\s*(of|/)\s*\d+)?", l, re.I)]
    rest = [l for l in lines if l]
    out: list[str] = []
    contact = [l for l in rest[:8] if re.search(r"@|linkedin\.com|" + PHONE, l)]
    head = [l for l in rest[:8] if l not in contact]
    name = head[0] if head else "Your Name"
    headline = head[1] if len(head) > 1 and not _is_heading(head[1]) else ""
    out += [f"# {name}", f"**{headline or 'Headline'}**", " | ".join(re.sub(r"\s*[|•·]\s*", " | ", c) for c in contact), ""]
    used = {name, headline, *contact}
    for l in lines:
        if l in used and l:
            used.discard(l)
            continue
        prev = next((x for x in reversed(out) if x.strip()), "")
        role = _role(l, prev if prev and not prev.startswith(("#", "*", "-")) else "") if l else None
        if not l:
            out.append("")
        elif l.strip() in BULLETS:
            continue                       # a bullet glyph on a line of its own
        elif role:
            if role[2]:
                out.pop(len(out) - 1 - [x.strip() for x in reversed(out)].index(prev))
            out += ["", role[0], role[1], ""]
        elif _is_heading(l):
            h = l.upper().rstrip(":").strip()
            out += ["", "## " + next((k for k, v in SAME_AS.items() if h in v), h)]
        elif l[0] in BULLETS and len(l) > 2:
            out.append("- " + l.lstrip(BULLETS).strip())
        elif out and _plain(l) and (_plain(out[-1]) or out[-1].startswith("- ")) and len(out[-1]) >= WRAPPED:
            out[-1] += " " + l             # the file wrapped this line: join it back
        else:
            out.append(l)
    return clean("\n".join(out))


WRAPPED = 70        # a line this long ran to the margin, so the next plain line continues it


def _plain(line: str) -> bool:
    return bool(line.strip()) and not line.startswith(("#", "*", "- ")) and not line.rstrip().endswith(":")


def _is_heading(line: str) -> bool:
    words = re.findall(r"[A-Za-z]+", line)
    if not words or len(line) > 40 or len(words) > 4:
        return False
    return line.rstrip(":").isupper() or all(w.lower() in HEADING_WORDS or w.lower() in ("and", "of", "&") for w in words)


# ---- checking ------------------------------------------------------------------------------------------
MONTHS = {"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "present"}
DATE_WORDS = {"january", "february", "march", "april", "june", "july", "august", "september", "october", "november",
              "december", "to", "current", "now", "today", "present"}     # dates rewritten as Mon YYYY–Mon YYYY
DATE_LINE = re.compile(r"^(?:[A-Z][a-z]{2} )?\d{4}[–-](?:(?:[A-Z][a-z]{2} )?\d{4}|Present)\b")


def words(text: str) -> list[str]:
    return re.findall(r"\w+", unicodedata.normalize("NFKC", text).lower().replace("_", " "))


def verify(source: str, md: str, notes: tuple[str, ...] = (), ai_notes: tuple[str, ...] = (),
           heuristic_reason: Optional[str] = None) -> dict:
    """What the review screen shows: the counts, and flags for anything to look at before saving."""
    src, out = Counter(words(source)), Counter(words(md))
    added = sorted({w for w in out if w not in src and w not in HEADING_WORDS and w not in MONTHS
                    and not (w.isdigit() and len(w) <= 2)})
    missing = Counter({w: n for w, n in (src - out).items()
                       if w not in DATE_WORDS and w not in HEADING_WORDS and not (w.isdigit() and len(w) <= 2)})
    total = sum(src.values()) or 1
    kept = 1 - sum(missing.values()) / total
    seen, dropped = set(), []
    for w in words(source):
        if missing.get(w) and w not in seen and not w.isdigit():
            seen.add(w)
            dropped.append(w)
    flags = []
    lines = md.splitlines()
    heads = [l[3:].strip().upper() for l in lines if l.startswith("## ")]
    roles = [(i, m.group(1)) for i, l in enumerate(lines) if (m := re.match(r"^\*\*(.+?)\*\*\s*\|\s*.+$", l.strip()))]
    bullets = sum(1 for l in lines if l.lstrip().startswith("- "))
    try:
        render.render(md)
        drawable = True
    except Exception:  # noqa: BLE001 - any parse failure means the shape is broken
        drawable = False
        flags.append(("warn", "The app can't draw this yet: keep the first three lines as # Name, **headline** and "
                              "the contact line."))
    summary = f"{len(heads)} sections, {len(roles)} roles, {bullets} bullets."
    flags.insert(0, ("ok" if not added and kept >= 0.97 and roles else "info",
                     summary + (" Every word is from your file." if not added else "")))
    if added:
        flags.append(("warn", "Words that aren't in your file: " + ", ".join(added[:12])
                      + (" and more" if len(added) > 12 else "") + ". Edit them out unless they're right."))
    if kept < 0.97:
        flags.append(("warn", f"About {sum(missing.values())} words from your file aren't here, such as "
                      + ", ".join(dropped[:10]) + ". Check nothing you need is missing."))
    if lines and not lines[0].startswith("# "):
        flags.append(("warn", "The first line should be your name, as # Your Name."))
    contact = next((l for l in lines[1:4] if l.strip() and not l.startswith("**")), "")
    if contact and "@" not in contact:
        flags.append(("warn", "No email address in the contact line (the third line)."))
    if not any(h in ("PROFESSIONAL EXPERIENCE", "EXPERIENCE") for h in heads):
        flags.append(("warn", "No ## PROFESSIONAL EXPERIENCE section, so there are no roles for the writers to build on."))
    elif not roles:
        flags.append(("warn", "No roles found: start each one with a **Company** | Job title line, then its dates."))
    for i, company in roles:
        nxt = next((l.strip() for l in lines[i + 1:i + 3] if l.strip()), "")
        if not (nxt.startswith("*") and not nxt.startswith("**")):
            flags.append(("warn", f"{company}: no dates. Add them on the line under it, as *Mon YYYY–Mon YYYY*."))
        elif not DATE_LINE.match(nxt.strip("*").strip()):
            flags.append(("warn", f"{company}: the dates “{nxt.strip('*').strip()}” aren't in the Mon YYYY–Mon YYYY "
                                  "form parsers read."))
    if "header" in notes:
        flags.append(("info", "Your name or contact details were in the page header, where ATS systems often miss "
                              "them. They're in the body now."))
    if "table" in notes:
        flags.append(("info", "Your file has a table. It's plain lines now, which ATS systems read in order."))
    if "textbox" in notes:
        flags.append(("info", "Your file has text boxes; check their text landed in the right section."))
    if heuristic_reason:
        flags.append(("warn", f"Claude couldn't sort it ({heuristic_reason}), so the app did a rougher sort. "
                              "Check each section and the dates."))
    flags += [("info", f"Claude: {n}") for n in ai_notes]
    return {"flags": [{"level": lv, "text": t} for lv, t in flags], "kept": round(kept * 100, 1),
            "added": added, "dropped": dropped[:30], "words": sum(src.values()), "drawable": drawable}
