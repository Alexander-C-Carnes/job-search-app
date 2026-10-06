#!/usr/bin/env python3
"""Render a resume-vs-job fit heat map as a self-contained Plotly HTML file.

Usage:
    python heatmap.py input.json output.html

input.json:
{
  "title": "Senior TPM, Platform — Acme",
  "sources": ["Impact record", "Platform resume", "Leadership resume"],
  "scores": [8, 7, 6],                      # optional, one per source
  "skills": [
    {"requirement": "Python", "weight": "High",
     "ratings": ["strong", "strong", "partial"],
     "notes": ["120 PRs...", "Listed in core capabilities", "Listed only"]}   # notes optional
  ],
  "experience": [ ...same shape... ]
}
Ratings: "strong" | "partial" | "missing". Weight: "High" | "Med" | "Low".
"""
import json
import sys

try:
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
except ImportError:
    sys.exit("plotly is not installed: run `pip install plotly` (add --break-system-packages if pip requires it)")

RATING_VALUE = {"missing": 0, "partial": 1, "strong": 2}
RATING_LABEL = {0: "Missing", 1: "Partial", 2: "Strong"}
WEIGHT_ORDER = {"high": 0, "med": 1, "medium": 1, "low": 2}
# Discrete 3-step colorscale: red / amber / green
COLORSCALE = [
    [0.0, "#d64545"], [0.333, "#d64545"],
    [0.333, "#f2b134"], [0.667, "#f2b134"],
    [0.667, "#2f9e5b"], [1.0, "#2f9e5b"],
]


def build_matrix(rows, n_sources):
    rows = sorted(rows, key=lambda r: WEIGHT_ORDER.get(str(r.get("weight", "med")).lower(), 1))
    labels, z, text, hover = [], [], [], []
    for r in rows:
        weight = r.get("weight", "")
        labels.append(f"{r['requirement']}  <span style='color:#888'>[{weight}]</span>" if weight else r["requirement"])
        vals = [RATING_VALUE[str(x).lower()] for x in r["ratings"]]
        if len(vals) != n_sources:
            sys.exit(f"Requirement '{r['requirement']}' has {len(vals)} ratings; expected {n_sources}")
        notes = r.get("notes") or [""] * n_sources
        z.append(vals)
        text.append([RATING_LABEL[v] for v in vals])
        hover.append([
            f"<b>{r['requirement']}</b><br>{RATING_LABEL[v]}" + (f"<br>{n}" if n else "")
            for v, n in zip(vals, notes)
        ])
    # Plotly draws heat map rows bottom-up; reverse so the first (highest weight) row is on top
    return labels[::-1], z[::-1], text[::-1], hover[::-1]


def main(inp, out):
    with open(inp) as f:
        data = json.load(f)
    sources = data["sources"]
    scores = data.get("scores")
    cols = [f"{s}<br><b>{sc}/10</b>" if scores else s for s, sc in zip(sources, scores or sources)]

    sections = [(name, data[key]) for name, key in (("Skills", "skills"), ("Experience", "experience")) if data.get(key)]
    counts = [len(rows) for _, rows in sections]
    fig = make_subplots(
        rows=len(sections), cols=1, shared_xaxes=False,
        row_heights=[c / sum(counts) for c in counts],
        vertical_spacing=0.14 if len(sections) > 1 else 0,
    )
    for i, (_, rows) in enumerate(sections, start=1):
        labels, z, text, hover = build_matrix(rows, len(sources))
        fig.add_trace(go.Heatmap(
            z=z, x=cols, y=labels, text=text, texttemplate="%{text}",
            textfont={"color": "white", "size": 13},
            customdata=hover, hovertemplate="%{customdata}<extra></extra>",
            colorscale=COLORSCALE, zmin=0, zmax=2, showscale=False,
            xgap=3, ygap=3,
        ), row=i, col=1)
        # Each panel gets its own column headers on top and its section name on the left
        fig.update_xaxes(side="top", tickfont={"size": 13}, row=i, col=1)
        fig.update_yaxes(title={"text": f"<b>{sections[i-1][0]}</b>", "font": {"size": 15}}, row=i, col=1)

    fig.update_yaxes(tickfont={"size": 12}, automargin=True)
    fig.update_layout(
        title={"text": data.get("title", "Resume fit heat map"), "x": 0.01, "font": {"size": 18}},
        height=max(420, 38 * sum(counts) + 130 * len(sections) + 60),
        margin={"l": 20, "r": 20, "t": 130, "b": 30},
        plot_bgcolor="white", paper_bgcolor="white",
        font={"family": "Inter, Helvetica, Arial, sans-serif"},
    )

    fig.write_html(out, include_plotlyjs=True, full_html=True,
                   config={"displaylogo": False, "responsive": True})
    print(f"Wrote {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
