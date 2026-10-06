"""Uploading a résumé: reading PDF, Word and text, sorting it into the markdown shape, checking every word."""
import asyncio
import io
import zipfile

import pytest
from pypdf import PdfWriter

from conftest import EXAMPLE_REFS
from jobpipe import render, resume_import as ri
from jobpipe.config import ModelCfg
from jobpipe.llm import AgentResult

EXAMPLE = (EXAMPLE_REFS / "resume-platform.md").read_text()
NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def para(text, listed=False):
    ppr = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' if listed else ""
    return f"<w:p>{ppr}<w:r><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>"


def docx(body, header=""):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", f"<w:document {NS}><w:body>{body}</w:body></w:document>")
        if header:
            z.writestr("word/header1.xml", f"<w:hdr {NS}>{header}</w:hdr>")
    return buf.getvalue()


WORD_BODY = (para("Senior Program Manager") + para("WORK HISTORY") + para("Northwind Cloud, Program Manager")
             + para("March 2023 – Present") + para("Moved 31 payment services onto a new ledger platform", True)
             + para("Cut on-call pages by 35%", True)
             + "<w:tbl><w:tr><w:tc>" + para("Skills") + "</w:tc><w:tc>" + para("SQL, Jira") + "</w:tc></w:tr></w:tbl>")


def test_a_word_file_reads_its_header_bullets_and_tables():
    src = ri.read("Jordan.docx", docx(WORD_BODY, para("Jordan Rivera") + para("jordan@example.com | Portland, OR")))
    lines = src.text.splitlines()
    assert lines[:2] == ["Jordan Rivera", "jordan@example.com | Portland, OR"]
    assert "• Moved 31 payment services onto a new ledger platform" in lines and "Skills | SQL, Jira" in lines
    assert src.kind == "Word file" and src.notes == ["header", "table"]


def test_a_pdf_is_read_and_a_scan_is_refused(tmp_path):
    pdf = tmp_path / "r.pdf"
    render.render_pdf(EXAMPLE, pdf)
    src = ri.read("Resume.pdf", pdf.read_bytes())
    assert "Northwind Cloud" in src.text and "ﬁ" not in src.text and src.kind == "PDF"
    blank = io.BytesIO()
    w = PdfWriter()
    w.add_blank_page(612, 792)
    w.write(blank)
    with pytest.raises(ri.UploadError, match="picture of a page"):
        ri.read("scan.pdf", blank.getvalue())


@pytest.mark.parametrize("name,data,match", [
    ("old.doc", b"x", "save it as .docx"), ("cv.pages", b"x", "Export To"), ("cv.png", b"x", "Add a PDF"),
    ("cv.txt", b"", "empty"), ("cv.txt", b"a" * (ri.MAX_BYTES + 1), "under 5 MB"),
    ("cv.docx", b"not a zip", "can't be opened"), ("cv.pdf", b"%PDF-1.4 garbage", "can't be opened")])
def test_files_that_cant_be_read_say_what_to_do(name, data, match):
    with pytest.raises(ri.UploadError, match=match):
        ri.read(name, data)


def test_verify_passes_a_faithful_sort_and_flags_what_isnt():
    clean = ri.verify(EXAMPLE, EXAMPLE)
    assert clean["kept"] == 100 and clean["added"] == [] and clean["drawable"]
    assert [f["level"] for f in clean["flags"]] == ["ok"] and "Every word is from your file" in clean["flags"][0]["text"]
    md = (EXAMPLE.replace("Ran the ledger migration program end to end", "Spearheaded the ledger migration")
          .replace("*Mar 2023–Sep 2026 | Remote*", "*Spring 2023 onward*")
          .replace("*Jan 2021–Mar 2023 | Remote*\n", ""))
    out = ri.verify(EXAMPLE, md, notes=("header",), ai_notes=("Couldn't read one date.",))
    text = " ".join(f["text"] for f in out["flags"])
    assert out["added"] == ["onward", "spearheaded", "spring"]
    assert "Words that aren't in your file: onward, spearheaded, spring" in text
    assert "Northwind Cloud: the dates “Spring 2023 onward”" in text and "Fabrikam Games: no dates" in text
    assert "page header" in text and "Claude: Couldn't read one date." in text
    cut = ri.verify(EXAMPLE, EXAMPLE.split("## CORE SKILLS")[0])
    assert cut["kept"] < 97 and any("aren't here, such as" in f["text"] for f in cut["flags"])


def test_dates_and_headings_rewritten_into_the_shape_dont_count_as_added():
    src = "Jordan Rivera\nWork History\nNorthwind | PM\n03/2023 - present\n"
    md = "# Jordan Rivera\n**PM**\njordan@example.com\n\n## PROFESSIONAL EXPERIENCE\n\n**Northwind** | PM\n*Mar 2023–Present*\n"
    out = ri.verify(src, md)
    assert out["added"] == ["com", "example"]    # only the email it made up, not Mar, Present or the headings


def test_shape_asks_for_the_files_words_only_and_reads_notes():
    class Runner:
        async def run(self, call):
            self.call = call
            return AgentResult(files={"resume.md": "```markdown\n" + EXAMPLE + "```", "notes.md": "- None."}, summary="")
    r = Runner()
    src = ri.Source("cv.txt", "text file", "Jordan Rivera ...")
    md, notes = asyncio.run(ri.shape(src, r, ModelCfg()))
    assert md.startswith("# Jordan Rivera") and "```" not in md and notes == []
    assert r.call.candidate is False and r.call.documents == {"resume.txt": "Jordan Rivera ..."}
    assert "Use only the words in the file" in r.call.instructions and "text file" in r.call.instructions


def test_heuristic_sort_and_already_shaped_markdown():
    text = ("Jordan Rivera\nSenior Program Manager\njordan@example.com • +1 555-010-0199\n\nEXPERIENCE\n"
            "Northwind Cloud\n• Moved 31 services\nPage 1 of 2\nEDUCATION\nBA Economics\n")
    md = ri.heuristic(text)
    assert md.startswith("# Jordan Rivera\n**Senior Program Manager**\njordan@example.com | +1 555-010-0199")
    assert "## PROFESSIONAL EXPERIENCE" in md and "- Moved 31 services" in md and "Page 1" not in md and "## EDUCATION" in md
    render.render(md)
    assert ri.looks_shaped(EXAMPLE) and not ri.looks_shaped(text)


def test_heuristic_finds_roles_and_their_dates_however_the_file_writes_them():
    text = ("Jordan Rivera\nSenior Program Manager\njordan@example.com | +1 555-010-0199\nWORK HISTORY\n"
            "Northwind Cloud | Senior TPM, Payments Mar 2023–Sep 2026 | Remote\n• Moved 31 services\n"
            "Fabrikam Games\nTechnical Program Manager, 01/2021 - 03/2023\n• Raised build success\n"
            "Contoso Health, Business Systems Analyst  July 2017 to Present (Seattle)\nEDUCATION\nBA Economics, 2015\n")
    md = ri.heuristic(text)
    for line in ("**Northwind Cloud** | Senior TPM, Payments\n*Mar 2023–Sep 2026 | Remote*",
                 "**Fabrikam Games** | Technical Program Manager\n*Jan 2021–Mar 2023*",
                 "**Contoso Health** | Business Systems Analyst\n*Jul 2017–Present | Seattle*"):
        assert line in md
    assert "01/2021" not in md.split("\n")[2]               # a date isn't taken for a phone number
    out = ri.verify(text, md)
    assert out["kept"] >= 97 and not any("aren't here" in f["text"] or "no dates" in f["text"] for f in out["flags"])


def test_heuristic_joins_lines_the_file_wrapped_but_not_short_ones():
    text = ("Jordan Rivera\nProgram Manager\njordan@example.com\nSUMMARY\n"
            "Technical Program Manager with 9+ years across payments, game development and healthcare at\n"
            "Northwind Cloud and Fabrikam Games.\nEDUCATION\nBachelor of Arts, Economics\nProject Management Professional\n")
    md = ri.heuristic(text)
    assert "healthcare at Northwind Cloud and Fabrikam Games." in md
    assert "Bachelor of Arts, Economics\nProject Management Professional" in md
