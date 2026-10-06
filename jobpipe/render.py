#!/usr/bin/env python3
"""Render a resume markdown (resume-job-fit writer shape) into the two-page
red-accent résumé layout, as HTML and PDF (headless Chromium via Playwright).

Usage: python -m jobpipe.render resume.md out.pdf [--html out.html]
"""
import argparse
import html
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright
from pypdf import PdfReader

# Playwright's own Chromium by default (`playwright install chromium`); set
# PLAYWRIGHT_CHROMIUM_EXECUTABLE to use another build (e.g. /opt/pw-browsers/chromium).
CHROMIUM = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None

CSS = """
@page { size: 8.5in 11in; margin: 0.625in; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
       font-weight: 300; font-size: 10pt; line-height: 12pt; color: #434343; }
.name { font-size: 18pt; line-height: 1.0; font-weight: 700; color: #171717; margin: 0; }
.title { font-size: 10pt; font-weight: 700; color: #E50815; margin-top: 5pt; }
.contact { font-size: 10pt; color: #666666; margin-top: 3pt; }
.contact a { color: #666666; }
.rule-heavy { border-bottom: 1.5pt solid #E50815; height: 0; }
.rule-light { border-bottom: 0.5pt solid #CCCCCC; height: 0; margin: 6pt 0; }
.after-contact { margin-top: 8pt; }
h2 { font-size: 11.5pt; font-weight: 700; color: #E50815; text-transform: uppercase;
     margin: 16pt 0 4pt 0; line-height: 13pt; }
h2.first { margin-top: 11pt; }
h2.skills { margin-top: 6pt; }
p { margin: 0; }
/* A role may run onto the next page, but never leaves its header without its first bullet. */
.jobrow { break-after: avoid; page-break-after: avoid; }
ul.b > li, ul.n > li { break-inside: avoid; page-break-inside: avoid; }
.jobrow { display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; }
.jobline { font-size: 10.5pt; font-weight: 700; color: #171717; }
.dates { font-size: 10pt; font-weight: 700; font-style: italic; color: #999999; white-space: nowrap; }
ul.b { list-style: none; margin: 2pt 0 0 0; padding: 0 0 0 18pt; }
ul.b > li { position: relative; padding-left: 18pt; }
ul.b > li::before { content: "-"; position: absolute; left: 0; color: #000; }
ul.n { list-style: none; margin: 0; padding: 0; }
ul.n > li { position: relative; padding-left: 14pt; }
ul.n > li::before { content: "\\00B7"; position: absolute; left: 0; color: #000; }
.addl-p { margin-top: 2pt; }
.skills-p + .skills-p { margin-top: 3pt; }
code { font-family: Menlo, Consolas, monospace; font-size: 9pt; }
"""


def inline(s):
    s = s.replace("'", "’")
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)  # no bold inside body text
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)\*", r"\1", s)
    return s


def contact_html(s):
    parts = [p.strip() for p in s.split("|")]
    out = []
    for p in parts:
        if p.startswith("linkedin.com/"):
            out.append(f'<a href="https://www.{html.escape(p)}">{html.escape(p)}</a>')
        else:
            out.append(inline(p))
    return " | ".join(out)


# Sections whose `**Company** | Title` lines are job rows. Plain EXPERIENCE is from résumés tailored
# before the heading became PROFESSIONAL EXPERIENCE.
ROLE_SECTIONS = ("PROFESSIONAL EXPERIENCE", "EXPERIENCE", "ADDITIONAL EXPERIENCE")


# The page editor (option `editable`): every piece of text the candidate can change is wrapped in a
# span that names its markdown line and which part of that line it is. Saving maps each changed
# span back onto that line (jobpipe/web/resumes.py, apply_page_edits).
EDIT_CSS = """
html { background: #e6e6e6; }
body { width: 8.5in; margin: 24px auto; padding: 0.625in; background: #fff; position: relative;
       box-shadow: 0 1px 4px rgba(0,0,0,.25); }
[data-ed] { border-radius: 2px; outline: none; cursor: text; }
[data-ed]:hover { background: rgba(229, 8, 21, .07); }
[data-ed]:focus { background: #fff4c2; box-shadow: 0 0 0 1px #e0c25a; }
[data-ed].changed { background: #fff4c2; }
.page-guide { position: absolute; left: 0; right: 0; border-top: 1px dashed #b0b0b0; pointer-events: none; }
.page-guide span { position: absolute; right: 6px; top: -9px; padding: 0 4px; background: #fff;
                   font: 400 8pt -apple-system, Helvetica, sans-serif; color: #888; }
"""


def render(md, editable=False):
    lines = md.splitlines()
    i = 0
    body = []
    name = headline = contact = None
    at = {}

    def ed(text_html, line, field):
        if not editable:
            return text_html
        return f'<span data-ed="{line}:{field}" contenteditable="plaintext-only" spellcheck="true">{text_html}</span>'

    # header
    while i < len(lines):
        ln = lines[i].strip()
        i += 1
        if not ln:
            continue
        if ln.startswith("# ") and name is None:
            name, at["name"] = ln[2:].strip(), i - 1
        elif headline is None and ln.startswith("**"):
            headline, at["headline"] = ln.strip("*").strip(), i - 1
        elif contact is None:
            contact, at["contact"] = ln, i - 1
            break
    body.append(f'<div class="name">{ed(inline(name), at.get("name"), "name")}</div>')
    body.append(f'<div class="title">{ed(inline(headline), at.get("headline"), "headline")}</div>')
    body.append(f'<div class="contact">{ed(contact_html(contact), at.get("contact"), "contact")}</div>')
    body.append('<div class="rule-heavy after-contact"></div>')

    section = None
    first_section = True
    job_open = False
    pending_head = None
    list_open = nested_open = False
    roles_in_section = 0

    def close_lists():
        nonlocal list_open, nested_open
        if nested_open:
            body.append("</ul></li>")
            nested_open = False
        elif list_open:
            body.append("</li>")
        if list_open:
            body.append("</ul>")
            list_open = False

    def close_job():
        nonlocal job_open
        close_lists()
        if job_open:
            body.append("</div>")
            job_open = False

    pending_li = False
    while i < len(lines):
        raw = lines[i]
        ln = raw.strip()
        i += 1
        if not ln or ln == "---":
            continue
        if ln.startswith("## "):
            close_job()
            section = ln[3:].strip().upper()
            roles_in_section = 0
            cls = ""
            if first_section:
                cls = "first"
                first_section = False
            if section == "CORE SKILLS":
                body.append('<div class="rule-heavy" style="margin-top:12pt"></div>')
                cls = "skills"
            head = f'<h2 class="{cls}">{inline(section)}</h2>'
            if section in ROLE_SECTIONS:
                # emitted inside the first entry's block so it can't be orphaned at a page end
                pending_head = head
            else:
                body.append(head)
            continue
        m = re.match(r"^\*\*(.+?)\*\*\s*\|\s*(.+)$", ln)
        if m and section in ROLE_SECTIONS:
            close_job()
            rule = roles_in_section > 0 or section == "ADDITIONAL EXPERIENCE"
            roles_in_section += 1
            jobline = f"{ed(inline(m.group(1)), i - 1, 'company')} | {ed(inline(m.group(2)), i - 1, 'role')}"
            dates = ""
            # the italic date line follows
            while i < len(lines) and not lines[i].strip():
                i += 1
            if i < len(lines) and re.match(r"^\*[^*].*\*$", lines[i].strip()):
                dates = ed(inline(lines[i].strip().strip("*").strip()), i, "dates")
                i += 1
            body.append('<div class="job">')
            job_open = True
            if pending_head:
                body.append(pending_head)
                pending_head = None
            if rule:
                body.append('<div class="rule-light"></div>')
            body.append(f'<div class="jobrow"><div class="jobline">{jobline}</div>'
                        f'<div class="dates">{dates}</div></div>')
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if ln.startswith("- "):
            text = ed(inline(ln[2:]), i - 1, "bullet")
            if indent >= 2 and list_open:
                if not nested_open:
                    body.append('<ul class="n">')
                    nested_open = True
                body.append(f"<li>{text}</li>")
            else:
                if nested_open:
                    body.append("</ul></li>")
                    nested_open = False
                elif list_open:
                    body.append("</li>")
                if not list_open:
                    body.append('<ul class="b">')
                    list_open = True
                body.append(f"<li>{text}")
            continue
        if indent >= 2 and list_open:
            # continuation of the current bullet
            if nested_open:
                body.append("</ul>")
                nested_open = False
                body.append(f" {ed(inline(ln), i - 1, 'line')}</li>")
                # reopen a hidden li so close_lists stays balanced
                body.append('<li style="display:none">')
            else:
                body.append(f" {ed(inline(ln), i - 1, 'line')}")
            continue
        # plain paragraph
        close_lists()
        text = ed(inline(ln), i - 1, "line")
        if section == "ADDITIONAL EXPERIENCE":
            body.append(f'<p class="addl-p">{text}</p>')
        elif section == "CORE SKILLS":
            body.append(f'<p class="skills-p">{text}</p>')
        else:
            body.append(f"<p>{text}</p>")
    close_job()
    title = f"{name} Resume"
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>"
            f"<style>{CSS}{EDIT_CSS if editable else ''}</style></head><body>{''.join(body)}</body></html>")


# The skill's fix for a tight page: cut section-header top margins 16pt -> 12pt
# before touching font sizes (never shrink body text below 10pt).
TIGHTEN = "h2 { margin-top: 12pt; } h2.first { margin-top: 9pt; } .rule-light { margin: 4pt 0; }"


def _print(doc, pdf_path):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROMIUM)
        pg = b.new_page()
        pg.set_content(doc, wait_until="load")
        pg.pdf(path=str(pdf_path), format="Letter", prefer_css_page_size=True,
               display_header_footer=False, print_background=True)
        b.close()


def render_pdf(md_text, pdf_path, html_path=None):
    """Render to PDF. Returns (pages, extracted_text). Tightens spacing once if over 2 pages."""
    doc = render(md_text)
    _print(doc, pdf_path)
    pages = len(PdfReader(str(pdf_path)).pages)
    if pages > 2:
        doc = doc.replace("</style>", TIGHTEN + "</style>")
        _print(doc, pdf_path)
        pages = len(PdfReader(str(pdf_path)).pages)
    if html_path:
        Path(html_path).write_text(doc, encoding="utf-8")
    text = "\n".join(pg.extract_text() or "" for pg in PdfReader(str(pdf_path)).pages)
    return pages, text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("md")
    ap.add_argument("pdf")
    ap.add_argument("--html")
    a = ap.parse_args()
    pages, _ = render_pdf(open(a.md, encoding="utf-8").read(), a.pdf, a.html)
    print(f"wrote {a.pdf} ({pages} pages)")


if __name__ == "__main__":
    main()
