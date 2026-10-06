"use strict";

// ---- token & API ------------------------------------------------------------------
const TOKEN = (() => {
  const url = new URL(location.href);
  let t = url.searchParams.get("token");
  try {
    if (t) localStorage.setItem("jobpipe-token", t);
    else t = localStorage.getItem("jobpipe-token");
  } catch (_) { /* storage blocked: keep the token in the URL */ }
  if (url.searchParams.has("token")) {
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search);
  }
  return t || "";
})();

async function request(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "X-Jobpipe-Token": TOKEN, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) { $("#auth-error").classList.remove("hidden"); throw new Error("Not authorized"); }
  return res;
}
async function api(path, opts = {}) {
  const res = await request(path, opts);
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.detail) || res.statusText);
  return data;
}
const send = (method) => (path, body) => api(path, { method, body: JSON.stringify(body || {}) });
const post = send("POST"), put = send("PUT"), patch = send("PATCH");
const fileUrl = (path) => `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(TOKEN)}`;

// ---- tiny DOM helpers ------------------------------------------------------------------
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const ICONS = {
  star: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.4l2.35 4.76 5.25.77-3.8 3.7.9 5.23L10 14.39l-4.7 2.47.9-5.23-3.8-3.7 5.25-.77z"/></svg>',
  person: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.1"/><path d="M3.8 16.8c.7-3 3.2-4.6 6.2-4.6s5.5 1.6 6.2 4.6"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>',
  palette: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a7.5 7.5 0 1 0 0 15c1.3 0 1.9-.8 1.9-1.6 0-.9-.6-1.2-.6-2 0-.9.7-1.4 1.6-1.4h1.4c1.8 0 3.2-1.3 3.2-3.1C17.5 5.6 14.1 2.5 10 2.5z"/><circle cx="6.5" cy="9" r="1.1"/><circle cx="9" cy="5.8" r="1.1"/><circle cx="13" cy="6.2" r="1.1"/></svg>',
};
function icon(name) {
  const s = h("span", { class: "ico" });
  s.innerHTML = ICONS[name];
  return s;
}
const spinner = () => h("span", { class: "spinner" });
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), error ? 7000 : 3500);
}
const pct = (v) => (v == null ? "n/a" : `${Math.round(v)}%`);
const fitClass = (f) => (f == null ? "" : f >= 7 ? "hi" : f >= 5 ? "mid" : "lo");
const known = (v) => (v && !/^not stated$/i.test(v) ? v : "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const safeHref = (url) => (/^https?:\/\//i.test(url || "") ? url : null);
const extLink = (url, label) => safeHref(url) && h("a", { href: url, target: "_blank", rel: "noopener" }, label, " ↗");
function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return "Referral"; }
}
const fmtDate = (v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function formError(form, msg) {
  const p = $(".form-error", form);
  p.textContent = msg || "";
  p.classList.toggle("hidden", !msg);
}

// ---- app state -------------------------------------------------------------------------
const STAGES = ["Not started", "In progress", "Blocked", "Applied", "Denied", "Done", "Not Applying"];
// The main line, in order, and the exits off it: how the stage strip and a role's stage path draw them.
const PATH = ["Not started", "In progress", "Applied", "Done"];
const EXITS = ["Blocked", "Denied", "Not Applying"];
const STAGE_BLURB = { "Not started": "Tracked, nothing done yet", "In progress": "Scoring or tailoring the résumé", Blocked: "Waiting on something",
                      Applied: "Application sent", Denied: "They said no", Done: "Interviews finished or closed out", "Not Applying": "Ruled out" };
// The two job lists: what's in the tracker, and what the searches found that isn't tracked yet.
// The tracker is kept on this Mac (tracker_id); Notion is its synced copy (notion_page_id, once the row is there).
const SCOPES = {
  tracker: { has: (j) => !!j.tracker_id },
  find: { has: (j) => j.local && !j.tracker_id },
};
const FIND_FILTERS = [["new", "New", (j) => !j.dismissed], ["fit7", "Fit 7+", (j) => !j.dismissed && (score(j) ?? 0) >= 7],
                      ["dismissed", "Dismissed", (j) => j.dismissed]];
const BOARD_CAP = 40;  // cards drawn per column until "Show more"
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem("jobpipe-ui") || "{}"); } catch (_) { return {}; }
})();
function savePrefs() {
  try { localStorage.setItem("jobpipe-ui", JSON.stringify({ view: S.view, sort: S.sort, group: S.group, collapsed: [...S.collapsed], docViews: S.docViews })); }
  catch (_) { /* optional */ }
}
const S = { jobs: [], byId: new Map(), etag: null, notion: false, syncing: false, notionError: "",
            query: "", tokens: [], stages: new Set(), flags: new Set(), visible: [],
            sort: ["fit", "newest", "company"].includes(prefs.sort) ? prefs.sort : "fit",
            view: prefs.view === "board" ? "board" : "list", boardAll: new Set(),
            group: prefs.group === "company" ? "company" : "", collapsed: new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed : []),
            scope: "tracker", sel: { tracker: null, find: null }, findFilter: "new",
            selected: null, drawer: false, detailTab: "resume", detailTabJob: null, details: new Map(), scoring: new Map(), scoreErrors: new Map(), scoreFinished: null, picks: new Set(),
            summary: null, searches: [], defaults: {}, picked: null, runId: null, runSince: 0, tab: "tracker",
            docViews: Object.fromEntries(["impact", "prep"].map((k) => {
              const v = prefs.docViews?.[k] ?? (k === "impact" ? prefs.impactView : null);   // impactView: before Interview prep
              return [k, ["formatted", "edit", "split"].includes(v) ? v : "formatted"];
            })) };

// ---- tabs --------------------------------------------------------------------------------
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  if (S.tab in DOCS && name !== S.tab) DOCS[S.tab].save();
  S.tab = name;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  const panel = name in SCOPES ? "jobs" : name;
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${panel}`));
  if (name in SCOPES) setScope(name);
  if (name === "searches") loadSearches();
  if (name === "startups") loadStartups();
  if (name === "runs") loadRuns();
  if (name === "notes") loadNotes();
  if (name in DOCS) DOCS[name].load();
  if (name === "profile") { loadProfile(); loadAI(); }
}

// ---- summary ------------------------------------------------------------------------------
async function loadSummary() {
  const was = S.summary?.active_runs || [];
  try {
    S.summary = await api("/api/summary");
    $("#offline").classList.add("hidden");
  } catch (e) {
    if (e instanceof TypeError) $("#offline").classList.remove("hidden");   // fetch couldn't connect
    return;
  }
  applyScoring(S.summary.scoring);
  const c = S.summary.credits;
  $("#credits").textContent = `${c.used} / ${c.allowance} credits`;
  $("#backend").textContent = "AI: " + (S.summary.backend_label || S.summary.backend);
  const ind = $("#run-indicator");
  const going = S.summary.active_runs;
  ind.classList.toggle("hidden", !going.length);
  if (going.length) {
    ind.replaceChildren(spinner(), " ", going.length === 1 ? going[0].label : `${going.length} runs`);
    ind.title = going.map((r) => r.label).join("\n");
    ind.onclick = () => { showTab("runs"); selectRun(going[0].id); };
  }
  // A run this page wasn't following (started before a reload, or beside the one shown) just ended: pick up what it wrote.
  const ids = new Set(going.map((r) => r.id));
  const ended = was.filter((r) => !ids.has(r.id));
  if (ended.length && S.tab === "runs") loadRuns();
  $("#count-startups").textContent = S.summary.startups?.recent || "";
  renderStartupState();
  if (ended.some((r) => r.label === "Startup search")) loadStartups({ quiet: true });
  if (ended.some((r) => S.runId !== r.id)) { S.details.clear(); loadJobs({ refresh: true }); }
}

// ---- jobs: data ---------------------------------------------------------------------------
const stageOf = (j) => j.status || "Not started";
// How the search stands, for the feedback moments: applications out the door, roles still in play.
function stageCounts() {
  const tracked = S.jobs.filter((j) => SCOPES.tracker.has(j));
  const n = (...st) => tracked.filter((j) => st.includes(stageOf(j))).length;
  return { out: n("Applied", "Denied", "Done"), inPlay: n("Not started", "In progress", "Blocked", "Applied"),
           applied: n("Applied"), done: n("Done"), denied: n("Denied") };
}
function indexJob(j) {
  j._hay = [j.title, j.company, j.location, j.mode, j.status, j.one_line, j.referral_name, j.funding?.line, j.funding?.stage, ...j.searches].join(" ").toLowerCase();
  j._el = j._card = null;
}
async function loadJobs({ refresh = false, wait = false, announce = false } = {}) {
  try {
    const res = await request(`/api/jobs${refresh ? "?refresh=1" : wait ? "?wait=1" : ""}`,
      { headers: S.etag ? { "If-None-Match": S.etag } : {} });
    if (res.status === 304) {       // nothing changed since the copy on screen
      if (wait) S.syncing = false;
    } else {
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.statusText);
      S.etag = res.headers.get("etag");
      applyJobs(data);
    }
    renderSync();
    if (announce) toast(S.notion ? "Synced with Notion." : "Notion isn't connected, so the tracker is kept on this Mac only.");
    // The server answered from the local tracker and is syncing with Notion behind it: collect the result.
    if (S.syncing && !wait) loadJobs({ wait: true });
  } catch (e) {
    toast(e.message, true);
    if (refresh) loadJobs();     // a failed sync still leaves the last synced rows to show, with the warning
  }
}
function applyJobs(data) {
  const prev = S.byId.get(S.selected);
  S.jobs = data.jobs;
  S.loaded = true;
  S.byId = new Map(S.jobs.map((j) => [j.id, j]));
  S.jobs.forEach(indexJob);
  S.notion = data.notion; S.syncing = data.syncing; S.notionError = data.notion_error; S.notionSynced = data.notion_synced;
  S.pending = data.pending || 0;
  renderJobs();
  const cur = S.byId.get(S.selected);
  if (S.selected && !cur) { S.selected = null; renderDetail(); }
  else if (cur && prev && (prev.local !== cur.local || prev.tailored !== cur.tailored || prev.fit !== cur.fit
                           || prev.impact_score !== cur.impact_score)) {
    S.details.delete(cur.id);       // scored or tailored since: the panel below the header changed too
    renderDetail();
    if (cur.local) loadDetail(cur.id);
  } else if (cur && prev && (showsSent(prev) !== showsSent(cur) || prev.sent_resume !== cur.sent_resume)) {
    if (!showsSent(prev)) S.detailTabJob = null;   // just marked Applied: open the résumé sent
    renderDetail();
  } else if (cur) renderDetailHead();
  if (S.tab === "searches") renderSearches();
}
function renderSync() {
  const el = $("#sync-state");
  // While Notion isn't answering, ask again every minute so the list recovers without a click.
  clearTimeout(renderSync._t);
  if (S.notionError) renderSync._t = setTimeout(() => { if (!document.hidden) loadJobs(); else renderSync(); }, 60000);
  if (S.syncing) el.replaceChildren(spinner(), " Syncing with Notion…");
  else if (S.notionError) {
    const at = S.notionSynced && new Date(S.notionSynced * 1000);
    const when = at && (at.toDateString() === new Date().toDateString()
      ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : fmtDate(at));
    // The tracker itself is local, so everything still works; this only says the Notion copy is behind.
    const waiting = S.pending ? ` ${plural(S.pending, "change")} here will be sent when it's back.` : "";
    el.replaceChildren(h("span", { class: "warn", title: S.notionError },
      `Notion isn't answering${when ? ` (last synced ${when})` : ""}.${waiting}`));
  }
  else if (S.pending) el.replaceChildren(`${plural(S.pending, "change")} waiting to sync to Notion`);
  else el.replaceChildren();
}

// ---- jobs: filters --------------------------------------------------------------------------
const FLAGS = { starred: (j) => j.starred, referral: (j) => !!j.referral_url, remote: (j) => j.remote, tailored: (j) => j.tailored, startup: (j) => !!j.funding };
function matches(j, { stages = true, flags = true } = {}) {
  if (!SCOPES[S.scope].has(j)) return false;
  for (const t of S.tokens) if (!j._hay.includes(t)) return false;
  if (flags) for (const f of S.flags) if (!FLAGS[f](j)) return false;
  if (!stages) return true;
  if (S.scope === "find") return FIND_FILTERS.find(([k]) => k === S.findFilter)[2](j);
  return !(S.stages.size && !S.stages.has(stageOf(j)));
}
const SORTS = {
  newest: (a, b) => (b.posted || b.first_seen).localeCompare(a.posted || a.first_seen),
  company: (a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title),
};
function visibleJobs() {
  const list = S.jobs.filter((j) => matches(j));   // the server already sorts by fit
  if (SORTS[S.sort]) list.sort(SORTS[S.sort]);
  return S.group ? grouped(list) : list;
}

// ---- jobs: grouped by company ------------------------------------------------------------------
// "Booking.com" and "booking.com, Inc." are one company; a job with no company is grouped as such.
const companyKey = (j) => (j.company || "").toLowerCase().replace(/[,.]?\s+(inc|llc|ltd|corp|corporation|co)\.?$/, "").trim() || "~";
// Each company's jobs together, in the chosen sort; companies in the order of their first job
// (so by best fit, or newest, first), or A–Z when sorting by company.
function grouped(list) {
  const groups = new Map();
  for (const j of list) {
    const k = companyKey(j);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  const keys = [...groups.keys()];
  if (S.sort === "company") keys.sort((a, b) => (a === "~") - (b === "~") || a.localeCompare(b));
  return keys.flatMap((k) => groups.get(k));
}
const collapsed = (j) => S.group === "company" && S.collapsed.has(companyKey(j));
function toggleGroup(key) {
  S.collapsed.has(key) ? S.collapsed.delete(key) : S.collapsed.add(key);
  savePrefs();
  renderJobs();
}
function groupHead(key, jobs) {
  const stages = STAGES.map((st) => [st, jobs.filter((j) => stageOf(j) === st).length]).filter(([, n]) => n);
  const open = !S.collapsed.has(key);
  return h("li", { class: "group-head", "data-group": key },
    h("button", { class: "group-toggle", "aria-expanded": String(open), onclick: () => toggleGroup(key) },
      h("span", { class: "caret" }, open ? "▾" : "▸"),
      h("span", { class: "group-name" }, key === "~" ? "No company" : jobs[0].company),
      h("span", { class: "n" }, jobs.length)),
    S.scope === "tracker" && h("span", { class: "group-stages" },
      ...stages.map(([st, n]) => h("span", { class: "tag stage-tag", "data-stage": st, title: st }, `${n} ${st}`))));
}
const filtersOn = () => S.tokens.length || S.flags.size || (S.scope === "find" ? S.findFilter !== "new" : S.stages.size);
function clearFilters() {
  S.query = ""; $("#job-filter").value = "";
  S.stages.clear(); S.flags.clear(); S.findFilter = "new";
  renderJobs();
}
const boardMode = () => S.scope === "tracker" && S.view === "board";
function applyLayout() {
  const body = $("#jobs-body");
  body.classList.toggle("view-list", !boardMode());
  body.classList.toggle("view-board", boardMode());
  body.classList.toggle("detail-open", S.drawer);
}
function setScope(scope) {
  S.scope = scope; S.drawer = false;
  S.picks.clear();
  for (const [sel, on] of [["#stage-wrap", "tracker"], ["#view-seg", "tracker"], ["#refresh-jobs", "tracker"],
                           ["#find-seg", "find"], ["#run-searches", "find"]]) $(sel).classList.toggle("hidden", scope !== on);
  $("#job-filter").placeholder = scope === "find" ? "Search new roles, companies, locations" : "Search tracked roles, companies, locations";
  applyLayout();
  renderJobs();
  // Keep this list's own selection if it's still shown; otherwise open its first role.
  const keep = S.visible.find((j) => j.id === S.sel[scope]);
  const next = keep || (boardMode() ? null : S.visible.find((j) => j.tailored) || S.visible[0]);
  if (next) { selectJob(next.id); next._el?.scrollIntoView({ block: "nearest" }); }
  else { S.selected = null; renderDetail(); }
}
function renderCounts() {
  const open = S.jobs.filter((j) => SCOPES.tracker.has(j) && ["Not started", "In progress", "Blocked"].includes(stageOf(j))).length;
  const found = S.jobs.filter((j) => SCOPES.find.has(j) && !j.dismissed).length;
  $("#count-tracker").textContent = open || "";
  $("#count-find").textContent = found || "";
}
function renderFindFilters() {
  $("#find-seg").replaceChildren(...FIND_FILTERS.map(([k, label, test]) => h("button", {
    class: S.findFilter === k ? "active" : "", onclick: () => { S.findFilter = k; renderJobs(); } },
    label, " ", h("b", {}, S.jobs.filter((j) => matches(j, { stages: false }) && test(j)).length))));
}

function renderStages() {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const j of S.jobs) if (matches(j, { stages: false })) counts[stageOf(j)]++;
  $("#stages").replaceChildren(...STAGES.map((s) => {
    const b = h("button", {
      class: "stage", "data-stage": s, "data-kind": PATH.includes(s) ? "path" : "side", "aria-pressed": String(S.stages.has(s)),
      title: `${STAGE_BLURB[s]}. Click to show only these roles.`,
      onclick: () => { S.stages.has(s) ? S.stages.delete(s) : S.stages.add(s); renderJobs(); } },
      h("span", { class: "n" }, counts[s]), h("span", { class: "l" }, s));
    b.style.setProperty("--n", counts[s]);      // a look can size the main line's stages by their count
    return b;
  }));
  // The strip under the stages is the same counts drawn to scale: where the pipeline's weight sits.
  $("#stage-meter").replaceChildren(...STAGES.filter((s) => counts[s]).map((s) => {
    const seg = h("span", { "data-stage": s });
    seg.style.flexGrow = counts[s];
    return seg;
  }));
}
function renderFlags() {
  $$("#flags .chip").forEach((b) => {
    const f = b.dataset.flag;
    b.setAttribute("aria-pressed", String(S.flags.has(f)));
    $("b", b).textContent = S.jobs.reduce((n, j) => n + (matches(j) && FLAGS[f](j) ? 1 : 0), 0);
  });
}
$$("#flags .chip").forEach((b) => b.addEventListener("click", () => {
  const f = b.dataset.flag;
  S.flags.has(f) ? S.flags.delete(f) : S.flags.add(f);
  renderJobs();
}));
$("#job-filter").addEventListener("input", (e) => {
  S.query = e.target.value;
  clearTimeout(renderJobs._t);
  renderJobs._t = setTimeout(renderJobs, 60);
});
$("#job-sort").addEventListener("change", (e) => { S.sort = e.target.value; savePrefs(); renderJobs(); });
$("#job-group").addEventListener("change", (e) => { S.group = e.target.value; savePrefs(); renderJobs(); });
$$("#view-seg button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
function setView(view) {
  S.view = view; S.drawer = false;
  savePrefs();
  $$("#view-seg button").forEach((x) => x.classList.toggle("active", x.dataset.view === view));
  applyLayout();
  renderJobs();
}
$("#run-searches").addEventListener("click", () => showTab("searches"));
$("#refresh-jobs").addEventListener("click", () => loadJobs({ refresh: true, announce: true }));

// ---- jobs: list and board ----------------------------------------------------------------------
function renderJobs() {
  S.tokens = S.query.toLowerCase().split(/\s+/).filter(Boolean);
  renderCounts();
  if (S.scope === "tracker") renderStages();
  else renderFindFilters();
  renderFlags();
  const list = S.visible = visibleJobs();
  $("#list-count").replaceChildren(...(filtersOn()
    ? [`${list.length} of ${plural(S.jobs.length, "role")}`, h("button", { class: "link-btn", onclick: clearFilters }, "Clear filters")]
    : [plural(list.length, "role")]));
  if (boardMode()) renderBoard(list);
  else renderList(list);
  renderBatch();
}

// ---- jobs: scoring (signal = one quick call; full = every requirement rated) ---------------------
const score = (j) => j.impact_score ?? j.fit;             // the full score where there is one
const canScore = (j) => j.local || !!j.url;                 // a Notion-only row needs a posting page to read
function applyScoring(sc) {
  const before = S.scoring;
  S.scoring = new Map(Object.entries(sc.active));
  S.scoreErrors = new Map(Object.entries(sc.errors));
  const changed = [...new Set([...before.keys(), ...S.scoring.keys()])]
    .filter((id) => before.get(id)?.state !== S.scoring.get(id)?.state);
  for (const id of changed) {
    const j = S.byId.get(id);
    if (j) j._el = j._card = null;
  }
  const finished = S.scoreFinished != null && sc.finished !== S.scoreFinished;
  S.scoreFinished = sc.finished;
  if (changed.length) {
    renderJobs();
    if (changed.includes(S.selected)) renderDetail();
  }
  if (finished) {            // some jobs left the queue: fetch their scores
    const done = changed.filter((id) => !S.scoring.has(id));
    done.forEach((id) => S.details.delete(id));
    loadJobs().then(() => { if (done.includes(S.selected) && S.byId.get(S.selected)?.local) loadDetail(S.selected); });
  }
  clearTimeout(applyScoring._t);
  if (S.scoring.size) applyScoring._t = setTimeout(loadSummary, 1500);   // follow the queue closely while it runs
}
async function scoreJobs(ids, kind = "signal") {
  ids = ids.filter((id) => !S.scoring.has(id));
  if (!ids.length) return;
  try {
    applyScoring(await post("/api/score", { job_ids: ids, kind }));
    S.picks.clear();
    renderJobs();
    if (ids.length > 1) toast(`${kind === "full" ? "Full" : "Signal"} scoring ${plural(ids.length, "job")}.`);
  } catch (e) { toast(e.message, true); }
}
function renderBatch() {
  const box = $("#batch");
  const picked = S.visible.filter((j) => S.picks.has(j.id));
  const all = $("#pick-all");
  all.checked = picked.length > 0 && picked.length === S.visible.length;
  all.indeterminate = picked.length > 0 && picked.length < S.visible.length;
  const running = [...S.scoring.values()].filter((x) => x.state === "running").length;
  const queued = S.scoring.size - running;
  const parts = [];
  if (S.scoring.size) parts.push(h("span", { class: "batch-status" }, spinner(), ` Scoring ${plural(S.scoring.size, "job")}`,
    queued ? ` (${queued} waiting)` : "", queued ? h("button", { class: "link-btn", title: "Jobs already being scored will finish",
      onclick: async () => { try { applyScoring(await post("/api/score/cancel")); } catch (e) { toast(e.message, true); } } }, "Stop the rest") : null));
  if (picked.length) {
    const ok = picked.filter(canScore), full = ok.filter((j) => !j.tailored);
    parts.push(h("span", {}, h("b", {}, picked.length), " selected"),
      h("button", { class: "ghost small", disabled: !ok.length, title: "One quick Claude call per job",
        onclick: () => scoreJobs(ok.map((j) => j.id), "signal") }, "Signal score"),
      h("button", { class: "ghost small", disabled: !full.length, title: "Rates every requirement: about four Claude calls and a few minutes per job",
        onclick: () => scoreJobs(full.map((j) => j.id), "full") }, "Full score"),
      h("button", { class: "link-btn", onclick: () => { S.picks.clear(); renderJobs(); } }, "Clear"));
  } else {
    const todo = S.visible.filter((j) => score(j) == null && canScore(j) && !S.scoring.has(j.id));
    if (todo.length) parts.push(h("button", { class: "ghost small", title: "One quick Claude call per job, three at a time",
      onclick: () => scoreJobs(todo.map((j) => j.id), "signal") }, `Signal-score ${todo.length} unscored`));
  }
  box.replaceChildren(...parts);
  box.classList.toggle("hidden", !parts.length);
}
$("#pick-all").addEventListener("change", (e) => {
  S.visible.forEach((j) => (e.target.checked ? S.picks.add(j.id) : S.picks.delete(j.id)));
  renderJobs();
});
function emptyState() {
  if (!S.loaded) return h("div", { class: "list-empty" }, spinner(), " Loading roles…");
  if (filtersOn()) return h("div", { class: "list-empty" }, "No roles match these filters.", h("button", { class: "ghost", onclick: clearFilters }, "Clear filters"));
  return S.scope === "find"
    ? h("div", { class: "list-empty" }, "No new roles here. Run your filters, or add a job you found yourself.",
        h("button", { class: "primary", onclick: () => showTab("searches") }, "Run your filters"))
    : h("div", { class: "list-empty" }, "Nothing tracked yet. Track roles from Find jobs.",
        h("button", { class: "ghost", onclick: () => showTab("find") }, "Go to Find jobs"));
}
function starButton(j, label = false) {
  return h("button", { class: "star" + (label ? " labeled" : ""), "aria-pressed": String(j.starred),
    title: j.starred ? "Remove star" : "Star this role",
    onclick: (e) => { e.stopPropagation(); toggleStar(j, e.currentTarget); } }, icon("star"), label ? (j.starred ? "Starred" : "Star") : null);
}
const fitTile = (j, cls = "") => h("div", { class: `fit ${fitClass(score(j))} ${j.impact_score != null ? "full" : ""} ${cls}`,
  title: S.scoring.has(j.id) ? "Scoring…" : j.impact_score != null ? "Full score, out of 10" : j.fit != null ? "Signal score, out of 10" : "Not scored yet" },
  S.scoring.has(j.id) ? spinner() : score(j) ?? "–");
// Applied to, with no record of the résumé that was sent.
const SENT_STAGES = ["Applied", "Denied", "Done"];
const showsSent = (j) => !!j.tracker_id && (SENT_STAGES.includes(j.status) || !!j.sent_resume);
const noSent = (j) => !!j.tracker_id && SENT_STAGES.includes(j.status) && !j.sent_resume;
const noSentTag = (j) => noSent(j) && h("span", { class: "tag warn-tag", title: "Add the résumé you sent in its Sent résumé tab." }, "No résumé on file");
const referralTag = (j) => j.referral_url && h("span", { class: "tag ref", title: `Referral: ${j.referral_name || j.referral_url}` },
  icon("person"), j.referral_name || "Referral");
// The company's funding round: "Series B", or "YC W26" when only the batch is known. See the Startups tab.
const roundLabel = (f) => (f.stage && f.stage !== "Unknown" ? f.stage : f.batch ? `YC ${f.batch}` : f.round || "Raised");
const fundingTag = (j) => j.funding && h("span", { class: "tag round-tag", "data-round": j.funding.stage || "Unknown", title: j.funding.line },
  roundLabel(j.funding), j.funding.amount && h("b", {}, ` ${j.funding.amount}`));

function rowEl(j) {
  if (!j._el) {
    j._el = h("li", { "data-id": j.id, tabindex: "0" },
      h("input", { type: "checkbox", class: "pick", "aria-label": `Select ${j.title}` }),
      fitTile(j),
      h("div", { class: "row-main" },
        h("div", { class: "t" }, j.title || "(untitled)"),
        h("div", { class: "s" }, [j.company, known(j.mode), known(j.pay)].filter(Boolean).join(" · ")),
        h("div", { class: "tags" },
          j.status && h("span", { class: "tag stage-tag", "data-stage": j.status }, j.status),
          fundingTag(j),
          j.tailored && h("span", { class: "tag ok" }, `Résumé${j.ats_total != null ? " " + pct(j.ats_total) : ""}`),
          noSentTag(j),
          referralTag(j),
          !j.tracker_id && j.posted && h("span", { class: "tag" }, `Posted ${fmtDate(j.posted.length === 10 ? j.posted + "T12:00" : j.posted)}`),
          j.pending && h("span", { class: "tag", title: "Saved here. It will be sent to Notion on the next sync." }, "To sync"),
          j.closed ? h("span", { class: "tag warn-tag", title: `Its posting had closed when the app checked on ${fmtDate(j.closed)}` }, "Closed")
            : j.dismissed && h("span", { class: "tag" }, "Dismissed"),
          !j.local && h("span", { class: "tag", title: "None of your filters found it. Paste its description on the role, or Signal score reads it from its page." }, "No posting stored"))),
      starButton(j));
  }
  j._el.classList.toggle("selected", j.id === S.selected);
  j._el.firstChild.checked = S.picks.has(j.id);
  return j._el;
}
function renderList(list) {
  let items = list.map(rowEl);
  if (S.group) {
    items = [];
    for (let i = 0; i < list.length;) {
      const key = companyKey(list[i]);
      let n = i;
      while (n < list.length && companyKey(list[n]) === key) n++;
      const jobs = list.slice(i, n);
      items.push(groupHead(key, jobs), ...(S.collapsed.has(key) ? [] : jobs.map(rowEl)));
      i = n;
    }
  }
  $("#jobs").replaceChildren(...items, ...(list.length ? [] : [emptyState()]));
}
function pick(e) {
  const el = e.target.closest("[data-id]");
  if (!el || e.target.matches(".pick")) return;     // the checkbox selects for a batch, not for viewing
  if (e.type === "click" || (e.key === "Enter" && !e.target.closest("button"))) selectJob(el.dataset.id, true);
}
$("#jobs").addEventListener("change", (e) => {
  if (!e.target.matches(".pick")) return;
  const id = e.target.closest("[data-id]").dataset.id;
  e.target.checked ? S.picks.add(id) : S.picks.delete(id);
  renderBatch();
});
$("#jobs").addEventListener("click", pick);
$("#jobs").addEventListener("keydown", pick);

function cardEl(j) {
  if (!j._card) {
    j._card = h("div", { class: "kcard", "data-id": j.id, tabindex: "0", draggable: j.tracker_id ? "true" : null },
      fitTile(j),
      h("div", { class: "row-main" },
        h("div", { class: "t" }, j.title || "(untitled)"),
        h("div", { class: "s" }, j.company),
        (j.tailored || j.referral_url || noSent(j) || j.funding) && h("div", { class: "tags" },
          fundingTag(j),
          j.tailored && h("span", { class: "tag ok" }, `Résumé${j.ats_total != null ? " " + pct(j.ats_total) : ""}`),
          noSentTag(j),
          referralTag(j))),
      starButton(j));
  }
  j._card.classList.toggle("selected", j.id === S.selected);
  return j._card;
}
function renderBoard(list) {
  const by = new Map(STAGES.map((s) => [s, []]));
  for (const j of list) by.get(stageOf(j)).push(j);
  const cols = STAGES.filter((s) => !S.stages.size || S.stages.has(s));
  $("#board").replaceChildren(...cols.map((stage) => {
    const jobs = by.get(stage);
    const shown = S.boardAll.has(stage) ? jobs : jobs.slice(0, BOARD_CAP);
    return h("section", { class: "col", "data-stage": stage },
      h("header", {}, h("span", { class: "dot" }), stage, h("span", { class: "n" }, jobs.length)),
      h("div", { class: "col-cards" }, ...(S.group ? withCompanyHeads(shown) : shown.map(cardEl)),
        jobs.length > shown.length && h("button", { class: "ghost", onclick: () => { S.boardAll.add(stage); renderJobs(); } },
          `Show ${jobs.length - shown.length} more`),
        !jobs.length && h("div", { class: "col-empty" },
          "Drag a role here.")));
  }));
}
// On the board, grouping adds a company line above each company's cards in a column.
function withCompanyHeads(jobs) {
  return jobs.flatMap((j, i) => i && companyKey(jobs[i - 1]) === companyKey(j) ? [cardEl(j)]
    : [h("div", { class: "col-group" }, j.company || "No company"), cardEl(j)]);
}
const board = $("#board");
board.addEventListener("click", pick);
board.addEventListener("keydown", pick);
board.addEventListener("dragstart", (e) => {
  const card = e.target.closest(".kcard");
  if (!card) return;
  e.dataTransfer.setData("text/plain", card.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  board.classList.add("dragging");
});
board.addEventListener("dragend", () => { board.classList.remove("dragging"); $$(".col.over", board).forEach((c) => c.classList.remove("over")); });
board.addEventListener("dragover", (e) => {
  const col = e.target.closest(".col");
  if (!col) return;
  e.preventDefault();
  $$(".col.over", board).forEach((c) => c !== col && c.classList.remove("over"));
  col.classList.add("over");
});
board.addEventListener("drop", (e) => {
  const col = e.target.closest(".col");
  const j = S.byId.get(e.dataTransfer.getData("text/plain"));
  if (!col || !j) return;
  e.preventDefault();
  setStatus(j, col.dataset.stage);
});

// ---- jobs: star, status, referral, score ------------------------------------------------------
function repaint(j) {
  indexJob(j);
  renderJobs();
  if (j.id === S.selected) renderDetailHead();
}
async function toggleStar(j, btn) {
  j.starred = !j.starred;
  if (j.starred) window.Look?.sparkle(btn || $("#job-detail .star"));
  repaint(j);
  try { await patch(`/api/jobs/${encodeURIComponent(j.id)}`, { starred: j.starred }); }
  catch (e) { j.starred = !j.starred; repaint(j); toast(e.message, true); }
}
async function setStatus(j, status) {
  const prev = j.status;
  if (!j.tracker_id || status === prev) return;
  j.status = status;
  repaint(j);
  try {
    await post(`/api/tracker/${encodeURIComponent(j.tracker_id)}/status`, { status });
    // Applied, Done and Denied get the look's moment (confetti, the cat); the other statuses a plain toast.
    const shown = window.Look?.status({ job: j, status, prev, counts: stageCounts() });
    const notion = S.notionError ? "Notion will get it when it's back." : "";
    if (!shown) toast(`Status set to ${status}.${notion ? " " + notion : ""}`);
    else if (notion) toast(notion);
    loadJobs({ wait: true });         // once the background sync has run, show whether Notion has it
  } catch (e) { j.status = prev; repaint(j); toast(e.message, true); }
}

const refDialog = $("#referral-dialog"), refForm = $("#referral-form");
function openReferral(j) {
  refDialog._job = j;
  refForm.reset();
  formError(refForm);
  refForm.elements.namedItem("url").value = j.referral_url;
  refForm.elements.namedItem("name").value = j.referral_name;
  $("#referral-for").textContent = `${j.title}${j.company ? " at " + j.company : ""}. Link the person referring you, or the referral page they sent.`;
  $("[data-act=remove]", refForm).classList.toggle("hidden", !j.referral_url);
  refDialog.showModal();
}
async function saveReferral(url, name) {
  const j = refDialog._job;
  try {
    const r = await patch(`/api/jobs/${encodeURIComponent(j.id)}`, { referral_url: url, referral_name: name });
    j.referral_url = r.referral_url; j.referral_name = r.referral_name;
    repaint(j);
    refDialog.close();
    toast(url ? "Referral saved." : "Referral removed.");
  } catch (e) { formError(refForm, e.message); }
}
refForm.addEventListener("submit", (e) => {
  e.preventDefault();
  saveReferral(refForm.elements.namedItem("url").value.trim(), refForm.elements.namedItem("name").value.trim());
});
$("[data-act=remove]", refForm).addEventListener("click", () => saveReferral("", ""));
$("[data-act=cancel]", refForm).addEventListener("click", () => refDialog.close());

// ---- jobs: detail ------------------------------------------------------------------------------
function selectJob(id, open = false) {
  const prev = S.byId.get(S.selected);
  S.selected = S.sel[S.scope] = id;
  if (open) S.drawer = true;
  for (const j of [prev, S.byId.get(id)]) {
    if (!j) continue;
    j._el?.classList.toggle("selected", j.id === id);
    j._card?.classList.toggle("selected", j.id === id);
  }
  $("#jobs-body").classList.toggle("detail-open", S.drawer);
  renderDetail();
  if (S.byId.get(id)?.local) loadDetail(id);
}
function closeDrawer() {
  S.drawer = false;
  $("#jobs-body").classList.remove("detail-open");
}
$("#drawer-backdrop").addEventListener("click", closeDrawer);

async function loadDetail(id) {
  try {
    const d = await api(`/api/jobs/${encodeURIComponent(id)}`);
    // Re-render only when what's below the header changed, so a revisit doesn't reload the PDF.
    const sig = JSON.stringify([d.triage, d.triaged_at, d.full_score, d.full_scored_at, d.description.length, d.resume, d.has_report, d.has_heatmap]);
    const old = S.details.get(id);
    S.details.set(id, { d, sig });
    if (S.selected === id && (!old || old.sig !== sig)) renderDetail();
  } catch (e) {
    if (S.selected === id && !S.details.has(id)) $("#job-detail").append(h("div", { class: "pad muted" }, e.message));
  }
}

async function trackJob(j) {
  window.Look?.fly(j._el || j._card, $(".tabs [data-tab=tracker]"), getComputedStyle(document.documentElement).getPropertyValue("--st-not-started"));
  try {
    const r = await post(`/api/jobs/${encodeURIComponent(j.id)}/track`);
    toast((r.action === "created" ? "Added to your tracker." : "Updated in your tracker.")
      + (S.notionError ? " Notion will get it when it's back." : ""));
    S.sel.tracker = j.id;
    await loadJobs();
    showTab("tracker");
    loadJobs({ wait: true });
  } catch (e) { toast(e.message, true); }
}
async function dismissJob(j, dismissed) {
  j.dismissed = dismissed;
  try {
    await post(`/api/jobs/${encodeURIComponent(j.id)}/dismiss`, { dismissed });
    toast(dismissed ? "Dismissed. It's under Dismissed if you change your mind." : "Back in New.");
  } catch (e) { j.dismissed = !dismissed; toast(e.message, true); }
  if (!dismissed) S.findFilter = "new";
  j._el = j._card = null;
  setScope("find");       // moves on to the next role when this one left the list
}
function statusControl(j) {
  if (!j.tracker_id) {
    return h("span", { class: "actions-inline" },
      h("button", { class: "primary", onclick: () => trackJob(j) }, "Track"),
      h("button", { class: "ghost", onclick: () => dismissJob(j, !j.dismissed) }, j.dismissed ? "Restore" : "Dismiss"));
  }
  const sel = h("select", { class: "status-select", "data-stage": j.status, "aria-label": "Status" },
    ...(S.summary?.statuses || [j.status]).map((s) => h("option", { value: s, selected: s === j.status }, s)));
  sel.addEventListener("change", () => setStatus(j, sel.value));
  return h("span", { class: "status-ctl" }, sel, ...quickStatus(j));
}
// The move that usually comes next, as a button beside the status menu (which still offers every status).
function quickStatus(j) {
  const go = (label, status, cls = "ghost small") => h("button", { class: `quick ${cls}`, "data-to": status, onclick: () => setStatus(j, status) }, label);
  switch (stageOf(j)) {
    case "Not started": case "In progress": case "Blocked": return [go("Mark applied", "Applied", "primary small")];
    case "Applied": return [go("Mark done", "Done"), go("Denied", "Denied")];
    default: return [go("Back to in progress", "In progress")];
  }
}
function referralControl(j) {
  if (!j.referral_url) return h("button", { class: "ghost small", onclick: () => openReferral(j) }, icon("person"), "Add referral");
  return h("span", { class: "ref-chip" }, icon("person"),
    h("a", { href: safeHref(j.referral_url), target: "_blank", rel: "noopener", title: j.referral_url }, j.referral_name || host(j.referral_url), " ↗"),
    h("button", { class: "link-btn", onclick: () => openReferral(j) }, "Edit"));
}
function detailHead(j) {
  return h("div", { class: "dhead" },
    h("div", { class: "dhead-top" },
      fitTile(j, "big"),
      h("div", { class: "dhead-title" },
        h("h2", {}, j.title || "(untitled)"),
        h("div", { class: "sub" }, fundingTag(j), [j.company, j.location, known(j.mode), known(j.pay)].filter(Boolean).join(" · "),
          j.funding && h("span", { class: "funding-note" }, " · ", j.funding.line,
            j.funding.url && [" ", h("a", { href: safeHref(j.funding.url), target: "_blank", rel: "noopener", title: j.funding.headline }, "news ↗")],
            " · ", h("button", { class: "link-btn", onclick: () => openStartup(j.funding.startup_id, j.company) }, "Startups tab")))),
      h("div", { class: "dhead-actions" },
        starButton(j, true),
        // Full score first (a few minutes), then tailoring, which reuses it.
        j.local && !j.tailored && j.impact_score == null && scoreButton(j.id, "full", false, true),
        j.local && !j.tailored && h("button", { class: j.tracker_id && j.impact_score != null ? "primary" : "ghost",
          onclick: () => startRun({ kind: "tailor", job_id: j.id }) }, "Tailor résumé"),
        h("button", { class: "icon-btn drawer-close", title: "Close", "aria-label": "Close", onclick: closeDrawer }, icon("close")))),
    h("div", { class: "bar" },
      statusControl(j),
      referralControl(j),
      extLink(j.url, "Posting"),
      extLink(j.notion_url, "Notion"),
      j.tailored ? h("span", { class: "score" }, "Impact record ", h("b", {}, j.impact_score ?? "–"), "/10 · Résumé ",
        h("b", {}, j.resume_score ?? "–"), "/10 · ATS ", h("b", {}, pct(j.ats_total)))
        : j.impact_score != null && h("span", { class: "score" }, "Full score ", h("b", {}, j.impact_score), "/10")),
    j.tracker_id && stagePath(j));
}
// Where a tracked role stands: the main line with the steps reached so far, and the exits, with the one taken.
function stagePath(j) {
  const cur = stageOf(j);
  const exit = EXITS.includes(cur) ? cur : null;
  // An exit is taken from somewhere on the line: Denied after applying, the other two before.
  const at = exit ? PATH.indexOf(exit === "Denied" ? "Applied" : "In progress") : PATH.indexOf(cur);
  return h("div", { class: "stage-path", "aria-label": `Status: ${cur}` },
    h("ol", { class: "path-line" }, ...PATH.map((s, i) => h("li", {
      class: ["step", i < at && "reached", i === at && (exit ? "reached" : "current")].filter(Boolean).join(" "),
      "data-stage": s, "aria-current": i === at && !exit ? "step" : null },
      h("span", { class: "dot" }), h("span", { class: "step-name" }, s)))),
    h("div", { class: "exits-line" }, h("span", { class: "lead" }, "Exits"),
      ...EXITS.map((s) => h("span", { class: "xstep" + (s === exit ? " taken" : ""), "data-stage": s }, h("i"), s))));
}
function renderDetailHead() {
  const j = S.byId.get(S.selected);
  const old = $("#job-detail .dhead");
  if (j && old) old.replaceWith(detailHead(j));
}
function scoreButton(id, kind, scored, primary = false) {
  const busy = S.scoring.get(id);
  const label = kind === "full" ? (scored ? "Run full score again" : "Run full score") : scored ? "Run again" : "Signal score";
  return h("button", { class: primary || !(scored || kind === "full") ? "primary" : "ghost", disabled: !!busy,
    title: kind === "full" && !scored ? "Rates every requirement against your impact record and each résumé, with a heat map. About four Claude calls and a few minutes." : null,
    onclick: () => scoreJobs([id], kind) },
    busy?.kind === kind ? [spinner(), busy.state === "queued" ? " Waiting its turn…" : kind === "full" ? " Scoring… a few minutes" : " Scoring… about half a minute"] : label);
}
function renderDetail() {
  const box = $("#job-detail");
  const j = S.byId.get(S.selected);
  if (!j) {
    box.replaceChildren(h("div", { class: "empty" }, S.visible.length || !S.loaded ? "Select a role to see its score, posting and résumé."
      : S.scope === "find" ? "No new roles here." : "Nothing tracked here yet."));
    return;
  }
  const head = detailHead(j);
  if (!j.local) {
    // Only in the tracker: no posting stored, but a résumé made outside the app may be.
    const tab = S.detailTabJob !== j.id && showsSent(j) ? "sent"
      : S.detailTab === "posting" ? "posting" : S.detailTab === "sent" && showsSent(j) ? "sent" : "resume";
    const tabs = [...(showsSent(j) ? [["sent", "Sent résumé"]] : []), ["resume", "Résumé"], ["posting", "Posting & score"]];
    const sub = h("div", { class: "subtabs" }, ...tabs.map(([k, label]) =>
      h("button", { class: k === tab ? "active" : "", onclick: () => { S.detailTab = k; S.detailTabJob = j.id; renderDetail(); } }, label)));
    const panel = h("div", { class: "subpanel active" });
    box.replaceChildren(head, sub, panel);
    if (tab === "sent") renderSent(j, panel);
    else if (tab === "resume") renderOutside(j, panel);
    else {
      const read = scoreButton(j.id, "signal", false);
      read.className = "ghost";
      read.title = "Reads the posting from its page, when the page can be read";
      panel.append(h("div", { class: "pad" },
        h("div", { class: "notice" },
          h("p", {}, "This role is in your tracker but none of your filters found it, so its posting isn't stored yet. ",
            "Paste the description from the posting's page: it's kept with this role, and the scores and tailoring compare your impact record against it."),
          scoreError(j.id),
          h("div", { class: "actions-inline" },
            h("button", { class: "primary", onclick: () => openDescribe(j) }, "Paste the description…"), read)),
        j.one_line && h("p", { class: "muted" }, j.one_line)));
    }
    return;
  }
  const d = S.details.get(j.id)?.d;
  if (!d) { box.replaceChildren(head, h("div", { class: "pad muted" }, spinner(), " Loading…")); return; }
  const off = (k) => (k === "heatmap" ? !d.has_heatmap : ["resume", "report"].includes(k) && !j.tailored);
  const tabs = [...(showsSent(j) ? [["sent", "Sent résumé"]] : []),
                ["resume", "Résumé"], ["report", "Fit report"], ["heatmap", "Heat map"], ["posting", "Posting & score"]];
  // A tab with nothing in it yet still opens (to say how to fill it), but only when clicked for this job:
  // moving to another job falls back to the posting, or for a job applied to, to the résumé sent.
  const fresh = S.detailTabJob !== j.id;
  const tab = fresh && showsSent(j) ? "sent"
    : (S.detailTab === "sent" && !showsSent(j)) || (off(S.detailTab) && fresh) ? "posting" : S.detailTab;
  const sub = h("div", { class: "subtabs" }, ...tabs.map(([k, label]) => h("button", {
    class: [k === tab && "active", off(k) && "empty"].filter(Boolean).join(" "),
    onclick: () => { S.detailTab = k; S.detailTabJob = j.id; renderDetail(); } }, label)));
  const panel = h("div", { class: "subpanel active" });
  box.replaceChildren(head, sub, panel);
  if (tab === "sent") renderSent(j, panel);
  else if (off(tab) && tab === "resume") renderOutside(j, panel);
  else if (off(tab)) panel.append(emptyTab(j, d, tab));
  else if (tab === "resume") renderResume(d, panel);
  else if (tab === "report") renderReport(d, panel);
  else if (tab === "heatmap") panel.append(
    h("iframe", { class: "heatmap", sandbox: "allow-scripts", src: fileUrl(`/api/jobs/${encodeURIComponent(d.id)}/heatmap`) }));
  if (tab === "posting") panel.append(h("div", { class: "posting-split" },
    h("div", { class: "posting-pane" }, postingMeta(j, d), postingBody(d.description)),
    h("aside", { class: "score-pane" }, scoreBlock(j, d))));
}

// What a Résumé, Fit report or Heat map tab says before the run that fills it.
function emptyTab(j, d, tab) {
  const tailor = h("button", { class: "primary", onclick: () => startRun({ kind: "tailor", job_id: j.id }) }, "Tailor résumé");
  const what = {
    resume: ["No tailored résumé yet",
      "Tailoring writes a résumé for this posting from your impact record, along with the Fit report and the heat map. It makes a series of Claude calls and takes several minutes; you can follow it in Runs."],
    report: ["No fit report yet",
      "The fit report comes from tailoring a résumé: the scores, the ATS scorecard, the gaps, and at the end, the follow-up questions to answer. Put your answers in Confirmed facts, then tailor again."],
    heatmap: ["No heat map yet",
      "The heat map rates every requirement in the posting against your impact record and each résumé. A full score makes one in a few minutes without writing a résumé; tailoring makes one too."],
  }[tab];
  return h("div", { class: "pad" }, h("div", { class: "notice" },
    h("h3", {}, what[0]), h("p", {}, what[1]), scoreError(d.id),
    h("div", { class: "actions-inline" }, tab === "heatmap" && scoreButton(d.id, "full", !!d.full_score), tailor)));
}

// The résumé sent with the application: the exact PDF, kept here and in Notion's Resume Used.
const SENT_SOURCE = {
  app: (x) => `The app's résumé (${x.note}), saved ${fmtDate(x.recorded)}`,
  upload: (x) => `Uploaded ${fmtDate(x.recorded)}`,
  notion: () => "From the Notion row's Resume Used",
};
async function renderSent(j, panel) {
  const id = encodeURIComponent(j.id);
  panel.replaceChildren(h("div", { class: "pad muted" }, spinner(), " Loading…"));
  let o;
  try { o = await api(`/api/jobs/${id}/sent`); }
  catch (e) { panel.replaceChildren(h("div", { class: "pad" }, h("p", { class: "form-error" }, e.message))); return; }
  if (S.selected !== j.id || !panel.isConnected) return;
  const done = (msg) => { toast(msg); loadJobs(); renderSent(j, panel); };
  const file = h("input", { type: "file", accept: "application/pdf,.pdf", class: "hidden" });
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      await api(`/api/jobs/${id}/sent`, { method: "PUT", body: f,
        headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(f.name) } });
      done(o.notion && !o.in_notion ? "Saved. It goes to Notion's Resume Used on the next sync." : "Saved.");
    } catch (e) { toast(e.message, true); }
  });
  const upload = (label, cls = "ghost") => h("button", { class: cls, onclick: () => file.click() }, label);
  const useCurrent = o.current_version && h("button", { class: o.sent ? "ghost" : "primary", onclick: async () => {
    try { await post(`/api/jobs/${id}/sent/current`); done(`Saved v${o.current_version} as the résumé sent.`); }
    catch (e) { toast(e.message, true); } } }, `Use the app's résumé (v${o.current_version})`);
  if (!o.sent) {
    panel.replaceChildren(h("div", { class: "pad" }, h("div", { class: "notice" },
      h("h3", {}, "No résumé on file for this application"),
      h("p", {}, "Add the PDF you sent, so you can see it here later. ",
        o.notion ? "It's also saved to the Notion row's Resume Used." : ""),
      h("div", { class: "actions-inline" }, upload("Upload the PDF you sent…", "primary"), useCurrent), file)));
    return;
  }
  const x = o.sent;
  const where = x.source === "notion" ? "" : o.in_notion ? " · In Notion" : o.notion ? " · Goes to Notion on the next sync" : "";
  const src = fileUrl(`/api/jobs/${id}/sent.pdf`) + `&n=${encodeURIComponent(x.recorded || x.name)}`;
  const forget = x.source !== "notion" && h("button", { class: "ghost danger", onclick: async () => {
    if (!confirm("Remove the copy kept here? Notion's Resume Used isn't changed.")) return;
    try { await api(`/api/jobs/${id}/sent`, { method: "DELETE" }); done("Removed."); }
    catch (e) { toast(e.message, true); } } }, "Remove");
  panel.replaceChildren(h("div", { class: "outside" },
    h("div", { class: "outside-bar" },
      h("span", {}, h("b", {}, x.name), h("span", { class: "muted" }, ` · ${SENT_SOURCE[x.source](x)}${where}`)),
      h("a", { href: src, target: "_blank" }, "Open PDF ↗"),
      upload("Replace…"), x.source !== "app" && useCurrent, forget, file),
    h("iframe", { class: "sent-pdf", src, title: "The résumé sent" })));
}

// A résumé made outside the app (the resume-job-fit skill's run folder, or a saved résumé in
// the profile's references/) for a job the app didn't tailor: the one picked for it, or the one named for it.
async function renderOutside(j, panel) {
  const box = h("div", { class: "pad muted" }, spinner(), " Looking for a résumé…");
  panel.replaceChildren(box);
  let o;
  try { o = await api(`/api/jobs/${encodeURIComponent(j.id)}/outside-resume`); }
  catch (e) { box.replaceChildren(h("p", { class: "form-error" }, e.message)); return; }
  if (S.selected !== j.id || !panel.isConnected) return;
  const pick = h("select", { "aria-label": "Résumé to show" },
    h("option", { value: "" }, o.source ? "Choose another résumé…" : "Choose a résumé…"),
    ...o.options.map((x) => h("option", { value: x.key, selected: o.source?.key === x.key },
      x.headline ? `${x.label}: ${x.headline}` : x.label)),
    o.source && h("option", { value: "none" }, "None for this role"));
  pick.addEventListener("change", async () => {
    if (!pick.value) return;
    pick.disabled = true;
    try { await post(`/api/jobs/${encodeURIComponent(j.id)}/outside-resume`, { source: pick.value }); renderOutside(j, panel); }
    catch (e) { toast(e.message, true); pick.disabled = false; }
  });
  if (!o.resume) {
    panel.replaceChildren(h("div", { class: "pad" }, h("div", { class: "notice" },
      h("h3", {}, "No résumé for this role yet"),
      h("p", {}, j.local
        ? "Tailor one here, or pick a résumé you made with the résumé skill in a Claude chat. Tailoring also writes the Fit report and the heat map."
        : "Pick a résumé you made with the résumé skill in a Claude chat. To tailor one here, the app needs the posting: paste its description."),
      o.options.length ? pick : h("p", { class: "muted" }, "No résumé runs (resume-runs/) or saved résumés (references/resume-*.md) in your profile folder."),
      j.local ? h("button", { class: "primary", onclick: () => startRun({ kind: "tailor", job_id: j.id }) }, "Tailor résumé")
        : h("button", { class: "ghost", onclick: () => openDescribe(j) }, "Paste the description…"))));
    return;
  }
  const wrap = h("div", { class: "outside" }, h("div", { class: "outside-bar" },
    h("span", {}, o.matched ? "Matched by name: " : "Showing ", h("b", {}, o.source.label)), pick));
  panel.replaceChildren(wrap);
  renderResume({ id: j.id, resume: o.resume }, wrap);
}

// The posting, read beside its score. JobsPipe stores postings as plain text: blank-line paragraphs,
// "- " bullets, and section titles on their own short line.
const BULLET = /^\s*(?:[-*•·–]|\d+[.)])\s+/;
function postingBody(text) {
  const lines = (text || "").split("\n").map((l) => l.trim());
  const box = h("div", { class: "posting-body" });
  if (!lines.some(Boolean)) { box.append(h("p", { class: "muted" }, "No posting text is stored for this job. Paste the description from its page to score and tailor against it.")); return box; }
  const next = (i) => lines.slice(i + 1).find(Boolean) || "";
  let list = null;
  lines.forEach((line, i) => {
    if (!line) return;
    if (BULLET.test(line)) {
      if (!list) box.append(list = h("ul"));
      list.append(h("li", {}, line.replace(BULLET, "")));
      return;
    }
    list = null;
    // A short line with no sentence ending, followed by a paragraph or a list, is a section title.
    const n = next(i);
    const title = line.length < 70 && !/[.,;!]$/.test(line) && (BULLET.test(n) || n.length >= 70);
    box.append(h(title ? "h4" : "p", {}, line));
  });
  return box;
}
function postingMeta(j, d) {
  const found = j.searches.filter((s) => s !== "manual");      // "manual": pasted or scored here, not found by a filter
  const posted = j.posted && new Date(j.posted.length === 10 ? j.posted + "T12:00" : j.posted);
  return h("div", { class: "posting-meta" },
    posted && !isNaN(posted) && h("span", {}, "Posted ", posted.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })),
    found.length ? h("span", {}, "Found by ", found.join(", ")) : null,
    extLink(j.url, "Open the original"),
    d.description_pasted && h("span", {}, d.description_read ? "Added from its link " : "Pasted by you ", fmtDate(d.description_pasted)),
    h("button", { class: "link-btn", onclick: () => openDescribe(j, d.description_pasted ? d.description : "") },
      d.description_pasted ? "Replace the pasted text…" : "Paste the description…"));
}

// The posting text pasted onto a role, for one whose stored text is missing, cut short or wrong.
const descDialog = $("#describe-dialog"), descForm = $("#describe-form");
function openDescribe(j, text = "") {
  descDialog._job = j;
  descForm.reset();
  formError(descForm);
  descForm.elements.namedItem("description").value = text;
  $("#describe-for").textContent = `${j.title}${j.company ? " at " + j.company : ""}. Copy the whole posting from its page. `
    + "It's kept with this role and used in place of any stored text when scoring and tailoring.";
  descDialog.showModal();
}
descForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const j = descDialog._job, save = $("button.primary", descForm);
  save.disabled = true;
  try {
    await put(`/api/jobs/${encodeURIComponent(j.id)}/description`, { description: descForm.elements.namedItem("description").value });
    descDialog.close();
    S.details.delete(j.id);
    await loadJobs();
    if (S.selected === j.id) { S.detailTab = "posting"; S.detailTabJob = j.id; renderDetail(); loadDetail(j.id); }
    scoreJobs([j.id], "signal");
    toast("Posting saved. Signal scoring it against your impact record now.");
  } catch (err) { formError(descForm, err.message); }
  finally { save.disabled = false; }
});
$("[data-act=cancel]", descForm).addEventListener("click", () => descDialog.close());
function scoreError(id) {
  const msg = S.scoreErrors.get(id);
  return msg && h("p", { class: "form-error", role: "alert" }, msg);
}

// The rubric's bands (skill/references/scoring-and-report.md), lowest score of each band first.
const BANDS = [[10, "Exact match on skills, experience and level"], [9, "Significant match, missing at most one skill"],
               [8, "Covers most of the role"], [6, "Relevant skills and experience for about 60–70% of the role"],
               [4, "Relevant skills or relevant experience, not both"], [1, "Little relevant overlap"]];
function scoreBlock(j, d) {
  return h("div", { class: "scorecard" }, scoreError(d.id), fullBlock(j, d), signalBlock(j, d));
}
function fullBlock(j, d) {
  const f = d.full_score;
  if (j.tailored) {
    return h("div", { class: "card" }, h("h3", {}, "Full score"),
      h("p", {}, "The tailoring run rated every requirement: impact record ", h("b", {}, j.impact_score ?? "–"), "/10, tailored résumé ",
        h("b", {}, j.resume_score ?? "–"), "/10, ATS ", h("b", {}, pct(j.ats_total)), ". See Fit report and Heat map."));
  }
  if (!f) {
    return h("div", { class: "notice" }, h("h3", {}, "Full score"),
      h("p", {}, "Rates every requirement in the posting against your impact record and each résumé, with a heat map and the gaps to confirm. About four Claude calls and a few minutes. Tailoring this role later reuses it."),
      scoreButton(d.id, "full", false));
  }
  const impact = f.scores["Impact record"];
  const resumes = Object.entries(f.scores).filter(([src]) => src !== "Impact record");
  const best = resumes.reduce((a, b) => ((b[1] ?? 0) > (a[1] ?? 0) ? b : a), resumes[0] || ["", null]);
  const row = ([src, n]) => {
    const b = f.baseline[src] || {};
    return h("tr", { class: src === f.recommended_base ? "rec" : "" },
      h("td", {}, src, src === f.recommended_base ? h("span", { class: "tag" }, "best base") : null),
      h("td", {}, n ?? "–"), h("td", {}, pct(b.skills)), h("td", {}, pct(b.experience)), h("td", {}, b.total == null ? "–" : pct(b.total)));
  };
  return h("div", { class: "card full-score" },
    h("div", { class: "score-head" },
      h("div", { class: `fit huge full ${fitClass(impact)}` }, impact ?? "–", h("small", {}, "/10")),
      h("div", {},
        h("h3", {}, "Full score"),
        h("div", { class: "band" }, impact == null ? "" : BANDS.find(([min]) => impact >= min)[1]),
        best[1] != null && impact != null && impact - best[1] >= 1 && h("p", { class: "muted" },
          `Your best existing résumé scores ${best[1]}/10, so tailoring can gain about ${impact - best[1]} ${impact - best[1] === 1 ? "point" : "points"}.`))),
    h("table", { class: "sources" },
      h("thead", {}, h("tr", {}, ...["Source", "/10", "Skills", "Exp.", "ATS"].map((x) => h("th", {}, x)))),
      h("tbody", {}, row(["Impact record", impact]), ...resumes.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(row))),
    f.gaps?.length ? h("div", {}, h("h3", {}, "Gaps to confirm"), h("ul", {}, ...f.gaps.map((x) => h("li", {}, x)))) : null,
    h("div", { class: "score-foot" },
      h("span", { class: "muted" }, d.full_scored_at ? `Scored ${fmtDate(d.full_scored_at + "T12:00")}.` : ""),
      d.has_heatmap && h("button", { class: "ghost", onclick: () => { S.detailTab = "heatmap"; renderDetail(); } }, "Heat map"),
      scoreButton(d.id, "full", true)));
}
function signalBlock(j, d) {
  const t = d.triage;
  const rec = S.summary?.impact_record;
  const basis = ["From your ", h("button", { class: "link-btn inline-link", onclick: () => showTab("impact") }, "impact record"),
                 rec?.updated ? ` (last edited ${fmtDate(rec.updated * 1000)})` : "", " and confirmed facts"];
  if (!t) {
    return h("div", { class: "notice" },
      h("h3", {}, "Signal score"),
      h("p", {}, "A quick read on fit: one Claude call scores this posting against your impact record from 1 to 10, with the strongest matches, the hard requirements to check and the likely gaps."),
      scoreButton(d.id, "signal", false));
  }
  const list = (title, items, cls = "") => h("div", { class: `card ${cls}` }, h("h3", {}, title),
    items?.length ? h("ul", {}, ...items.map((x) => h("li", {}, x))) : h("p", { class: "muted" }, "None found."));
  return h("div", { class: "signal" },
    h("div", { class: "score-head" },
      h("div", { class: `fit huge ${fitClass(t.fit_score)}` }, t.fit_score, h("small", {}, "/10")),
      h("div", {},
        h("h3", {}, "Signal score"),
        h("div", { class: "band" }, BANDS.find(([min]) => t.fit_score >= min)[1]),
        h("p", {}, t.one_line),
        h("p", { class: "muted" }, t.band_reason, " Level: ", t.level_match, ". Suggested base résumé: ", t.recommended_base, "."))),
    t.coverage_pct != null && t.requirements?.length ? h("details", { class: "rows" },
      h("summary", {}, `Covers ${Math.round(t.coverage_pct)}% of what the posting asks, weighted (${plural(t.requirements.length, "requirement")})`),
      h("table", { class: "sources" }, h("tbody", {}, ...t.requirements.map((r) => h("tr", {},
        h("td", {}, r.req), h("td", {}, r.weight), h("td", { class: `rate-${r.rating}` }, r.rating)))))) : null,
    h("div", { class: "score-lists" },
      list("Strongest matches", t.strongest_matches, "is-good"),
      list("Hard requirements to check", t.hard_requirement_issues, "is-warn"),
      list("Likely gaps (unconfirmed)", t.likely_gaps)),
    h("div", { class: "score-foot" },
      h("span", { class: "muted" }, basis, d.triaged_at ? ` on ${fmtDate(d.triaged_at + "T12:00")}.` : "."),
      scoreButton(d.id, "signal", true)));
}

async function renderReport(d, panel) {
  const box = h("div", { class: "pad" }, spinner());
  panel.append(box);
  try {
    const r = await api(`/api/jobs/${encodeURIComponent(d.id)}/report`);
    box.replaceChildren(h("div", { class: "markdown", html: r.html }));
  } catch (e) { box.replaceChildren(h("div", { class: "muted" }, e.message)); }
}

// ---- résumé workspace ---------------------------------------------------------------------------
function reloadResume(id) {
  const j = S.byId.get(id);
  if (!j?.local || !j.tailored) { renderDetail(); return; }   // an outside résumé: renderOutside reloads it
  S.details.delete(id);
  loadDetail(id);
  loadJobs();
}
function renderResume(d, panel) {
  const r = d.resume;
  const id = encodeURIComponent(d.id);
  const versionSel = h("select", {}, ...r.versions.slice().reverse().map((v) =>
    h("option", { value: v.n, selected: v.n === r.current }, `v${v.n}${v.n === r.current ? " (current)" : ""}`)));
  const frame = h("iframe", { src: fileUrl(`/api/jobs/${id}/resume/${r.current}.pdf`), title: "Résumé PDF" });
  versionSel.addEventListener("change", () => { frame.src = fileUrl(`/api/jobs/${id}/resume/${versionSel.value}.pdf`); });
  const pdfLink = h("a", { href: fileUrl(`/api/jobs/${id}/resume/${r.current}.pdf`), target: "_blank" }, "Open PDF ↗");
  const pdfpane = h("div", { class: "pdfpane" }, h("div", { class: "pdfbar" }, "Version", versionSel, pdfLink), frame);

  const editpane = h("div", { class: "editpane" });
  const cur = r.versions.find((v) => v.n === r.current);
  // Chat with Claude about this résumé: questions get answers; a change you ask for comes back as a proposal.
  const thread = h("div", { class: "chat-thread", "aria-live": "polite" });
  const instr = h("textarea", { rows: 2, placeholder: "Ask about this résumé, or tell Claude what to change…" });
  const askBtn = h("button", { class: "primary" }, "Send");
  const newBtn = h("button", { class: "ghost small", title: "Clear this conversation (versions are kept)" }, "New chat");
  const askCard = h("div", { class: "card chat" },
    h("div", { class: "chat-head" }, h("h3", {}, "Chat with Claude"), newBtn),
    thread,
    h("div", { class: "chat-input" }, instr, askBtn),
    h("p", { class: "muted chat-hint" }, "Enter sends, Shift+Enter adds a line. Claude only changes the résumé when you ask, and you see every change before it's saved."));
  const proposalBox = h("div");
  const metrics = h("div", { class: "card" }, h("h3", {}, `Current version: v${r.current}`),
    scoreMeters(S.byId.get(d.id), cur),
    h("div", { class: "metrics" },
      h("span", {}, "Keywords ", h("b", {}, pct(cur?.keywords_pct))),
      h("span", {}, "Format check ", checkBadge(cur?.check))));
  const hist = h("div", { class: "card" }, h("h3", {}, "History"), h("ul", { class: "history" },
    ...r.versions.slice().reverse().map((v) => h("li", {},
      h("span", { class: "v" }, `v${v.n}`),
      h("span", { class: "what" }, v.instruction ? `“${v.instruction}”` : v.source === "pipeline" ? "From the pipeline" : v.changes || v.source),
      v.n === r.current ? h("span", { class: "cur" }, "current")
        : h("button", { class: "ghost small", onclick: async () => {
            try { await post(`/api/jobs/${id}/restore`, { n: v.n }); toast(`Restored v${v.n} as a new version.`); reloadResume(d.id); }
            catch (e) { toast(e.message, true); } } }, "Restore")))));
  const readOnly = r.editable === false && h("div", { class: "card" }, h("h3", {}, "Editing isn't available"),
    h("p", { class: "muted" }, "This résumé was saved without its posting and match brief, which Claude needs to check edits against. Tailor the job in the app to get an editable copy."));
  editpane.append(readOnly || askCard, proposalBox, metrics, hist);
  panel.append(h("div", { class: "resume" }, pdfpane, editpane));

  const starters = ["What's the weakest part of this résumé for this role?", "What would a recruiter question here?",
                    "Which posting keywords am I missing?"];
  const bubble = (m) => m.role === "note" ? h("div", { class: "msg note" }, m.text)
    : m.role === "user" ? h("div", { class: "msg me" }, m.text)
    : h("div", { class: "msg claude" }, h("div", { class: "markdown", html: m.html || "" }),
        m.proposal && h("div", { class: "msg-tag" }, "Proposed an edit"));
  const showChat = (msgs, pending) => {
    thread.replaceChildren(...(msgs.length ? msgs.map(bubble) : [h("div", { class: "msg claude intro" },
      h("p", {}, "Ask me anything about this résumé and the role, or tell me what to change. When you ask for a change I'll propose it, and the PDF shows it before anything is saved."),
      h("div", { class: "starters" }, ...starters.map((q) => h("button", { class: "ghost small", onclick: () => { instr.value = q; send(); } }, q))))]),
      pending || "");
    thread.scrollTop = thread.scrollHeight;
  };
  let msgs = r.chat || [];
  showChat(msgs);
  async function send() {
    const text = instr.value.trim();
    if (!text || askBtn.disabled) { instr.focus(); return; }
    askBtn.disabled = newBtn.disabled = true;
    instr.value = "";
    showChat([...msgs, { role: "user", text }], h("div", { class: "msg claude pending" }, spinner(), " Claude is thinking…"));
    try {
      const res = await post(`/api/jobs/${id}/edit`, { instruction: text });
      msgs = res.chat;
      showChat(msgs);
      if (res.proposal) renderProposal(d, res.proposal, proposalBox, frame, cur);
    } catch (e) { showChat(msgs); instr.value = text; toast(e.message, true); }
    finally { askBtn.disabled = newBtn.disabled = false; instr.focus(); }
  }
  askBtn.addEventListener("click", send);
  instr.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  newBtn.addEventListener("click", async () => {
    if (!msgs.length) return;
    try { msgs = (await post(`/api/jobs/${id}/chat/clear`)).chat; showChat(msgs); }
    catch (e) { toast(e.message, true); }
  });
  if (r.proposal) api(`/api/jobs/${id}/edit`).then((res) => res.proposal && renderProposal(d, res.proposal, proposalBox, frame, cur));
}

// The résumé's numbers drawn to scale: fit and résumé out of 10, ATS and keywords out of 100.
function scoreMeters(j, cur) {
  const pctBand = (v) => (v >= 80 ? "hi" : v >= 60 ? "mid" : "lo");
  const rows = [["Fit", j && score(j), 10, "/10", fitClass], ["Résumé", j?.resume_score, 10, "/10", fitClass],
                ["ATS", j?.ats_total, 100, "%", pctBand], ["Keywords", cur?.keywords_pct, 100, "%", pctBand]]
    .filter(([, v]) => v != null);
  if (!rows.length) return null;
  return h("div", { class: "meters" }, ...rows.map(([label, v, max, unit, band]) => h("div", { class: `meter ${band(v)}` },
    h("span", { class: "lbl" }, label), h("span", { class: "val" }, Math.round(v), h("small", {}, unit)),
    h("span", { class: "track" }, h("i", { style: `width:${Math.max(2, Math.min(100, (v / max) * 100))}%` })))));
}
function checkBadge(check) {
  if (!check || check.passed == null) return h("b", {}, "n/a");
  return h("span", { class: check.passed ? "pass" : "fail", title: check.output }, check.passed ? "PASS" : "FAIL");
}

function renderProposal(d, p, box, frame, cur) {
  const id = encodeURIComponent(d.id);
  frame.src = fileUrl(`/api/jobs/${id}/resume/proposal.pdf`) + `&n=${Date.now()}`;
  const kwDelta = p.keywords_pct != null && cur?.keywords_pct != null ? p.keywords_pct - cur.keywords_pct : null;
  const accept = h("button", { class: "primary" }, "Accept");
  const discard = h("button", { class: "ghost danger" }, "Discard");
  box.replaceChildren(h("div", { class: "card" },
    h("h3", {}, "Proposed edit (PDF on the left shows it)"),
    h("p", { class: "muted" }, `“${p.instruction}”`),
    h("div", { class: "metrics" },
      h("span", {}, "Keywords ", h("b", {}, pct(p.keywords_pct)),
        kwDelta != null && kwDelta !== 0 ? ` (${kwDelta > 0 ? "+" : ""}${Math.round(kwDelta)})` : ""),
      h("span", {}, "Format check ", checkBadge(p.check)),
      h("span", {}, "Pages ", h("b", { class: p.pages === 2 ? "" : "fail" }, p.pages))),
    h("h3", {}, "Claude's note"),
    h("div", { class: "changes markdown", html: p.changes_html }),
    h("h3", {}, "Diff"),
    renderDiff(p.diff),
    h("div", { class: "actions" }, discard, accept)));
  accept.addEventListener("click", async () => {
    accept.disabled = discard.disabled = true;
    try { const hst = await post(`/api/jobs/${id}/edit/accept`); toast(`Saved as v${hst.current}. The deliverable PDF now matches it.`); reloadResume(d.id); }
    catch (e) { toast(e.message, true); accept.disabled = discard.disabled = false; }
  });
  discard.addEventListener("click", async () => {
    try { await post(`/api/jobs/${id}/edit/discard`); toast("Edit discarded."); reloadResume(d.id); }
    catch (e) { toast(e.message, true); }
  });
}

function renderDiff(ops) {
  const box = h("div", { class: "diff" });
  let sameRun = [];
  const flush = () => {
    if (!sameRun.length) return;
    if (sameRun.length > 4) {
      box.append(h("div", { class: "ctx" }, sameRun[0].new));
      box.append(h("div", { class: "ctx" }, `… ${sameRun.length - 2} unchanged lines …`));
      box.append(h("div", { class: "ctx" }, sameRun[sameRun.length - 1].new));
    } else sameRun.forEach((o) => box.append(h("div", { class: "ctx" }, o.new || " ")));
    sameRun = [];
  };
  for (const o of ops) {
    if (o.op === "same") { sameRun.push(o); continue; }
    flush();
    if (o.op === "add") box.append(h("div", { class: "add" }, "+ " + o.new));
    else if (o.op === "del") box.append(h("div", { class: "del" }, "- " + o.old));
    else box.append(h("div", { class: "chg" }, "~ ", ...o.words.map(([op, t]) =>
      op === "same" ? document.createTextNode(t) : h(op === "add" ? "ins" : "del", {}, t))));
  }
  flush();
  if (!ops.some((o) => o.op !== "same")) box.append(h("div", { class: "ctx" }, "No changes."));
  return box;
}

// ---- add a job ------------------------------------------------------------------------------------
// A role found outside the filters: paste its link and the posting is read from the page into the form.
// Fields you typed are never overwritten; ones the last read filled in are replaced (or cleared) by the next.
const addDialog = $("#paste-dialog"), addForm = $("#paste-form");
const addField = (name) => addForm.elements.namedItem(name);
const add = { url: "", filled: {}, seq: 0 };
function resetAdd() {
  addForm.reset();
  Object.assign(add, { url: "", filled: {} });
  add.seq++;
  lookupMsg();
  formError(addForm);
}
function lookupMsg(...parts) {
  const p = $(".lookup-msg", addForm);
  const warn = parts[0] === "warn";
  if (warn) parts.shift();
  p.replaceChildren(...parts);
  p.classList.toggle("warn", warn);
  p.classList.toggle("hidden", !parts.length);
}
async function readPosting({ force = false } = {}) {
  const url = addField("url").value.trim();
  if (!url || (url === add.url && !force)) return;
  add.url = url;
  const seq = ++add.seq, btn = $("[data-act=read]", addForm);
  formError(addForm);
  lookupMsg(spinner(), "Reading the posting…");
  btn.disabled = true;
  try {
    const d = await post("/api/jobs/lookup", { url });
    if (seq !== add.seq) return;
    addField("url").value = add.url = d.url;
    const got = { title: d.job_title || "", company: d.company || "", location: d.location || "",
                  description: d.readable ? d.description : "" };
    for (const [name, v] of Object.entries(got)) {
      const f = addField(name);
      if (!f.value.trim() || f.value === add.filled[name]) f.value = v;
    }
    add.filled = got;
    addField("remote").value = d.remote ? "true" : "";
    const e = d.existing;
    if (e) lookupMsg("warn", `Already in your jobs: ${e.title}${e.company ? " at " + e.company : ""}${e.status ? ` (${e.status})` : ""}.`,
      h("button", { type: "button", class: "link-btn", onclick: () => { addDialog.close(); openJob(e.id); } }, "Open it"));
    else if (d.readable) lookupMsg("Read from the posting. Check the details, then add it.");
    else lookupMsg("warn", (got.title ? "Found the title, but not" : "Couldn't read") + " the description on this page. "
      + "It may need a sign-in or a browser. Copy the posting from the page and paste it below.");
    if (!d.readable) addField("description").focus();
  } catch (err) {
    if (seq !== add.seq) return;
    add.url = "";
    lookupMsg("warn", err.message);
  } finally { if (seq === add.seq) btn.disabled = false; }
}
$("#paste-job").addEventListener("click", () => { addDialog.showModal(); addField("url").focus(); });
$("[data-act=read]", addForm).addEventListener("click", () => readPosting({ force: true }));
$("[data-act=cancel]", addForm).addEventListener("click", () => addDialog.close());
addField("url").addEventListener("paste", () => setTimeout(readPosting));
addField("url").addEventListener("change", () => readPosting());
addField("url").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); readPosting({ force: true }); } });
addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const action = e.submitter?.value || "score";
  const body = Object.fromEntries(new FormData(addForm).entries());
  const text = body.description.trim();
  if (!text && !body.url.trim()) { formError(addForm, "Paste the posting's link, or its full description."); return; }
  body.description_read = !!text && text === (add.filled.description || "").trim();
  const buttons = $$(".actions button", addForm);
  buttons.forEach((b) => (b.disabled = true));
  formError(addForm);
  try {
    if (action === "tailor") {
      const r = await post("/api/runs", { kind: "tailor-pasted", ...body });
      addDialog.close(); resetAdd();
      runStarted(r);
      return;
    }
    const { id, existing } = await post("/api/jobs", body);
    addDialog.close(); resetAdd();
    await loadJobs();
    if (existing) { toast("That job is already here. Opening it."); openJob(id); return; }
    S.sel.find = id;                 // an added job is untracked, so it lands in Find jobs
    S.query = ""; $("#job-filter").value = ""; S.flags.clear(); S.findFilter = "new";
    showTab("find");
    selectJob(id, true);
    scoreJobs([id], "signal");
  } catch (err) { formError(addForm, err.message); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
});

// ---- searches ---------------------------------------------------------------------------------------
async function loadSearches() {
  try { applySearches(await api("/api/searches")); }
  catch (e) { toast(e.message, true); }
}
function applySearches(d) {
  S.searches = d.searches;
  S.defaults = d.defaults;
  const ids = S.searches.map((s) => s.id);
  S.picked = new Set(S.picked ? ids.filter((id) => S.picked.has(id) || id === d.id) : ids);
  renderSearches();
}
const money = (n) => `$${Math.round(n / 1000)}k+`;
function searchFacts(s) {
  const df = S.defaults, eff = (k) => s[k] ?? df[k];
  const wa = s.work_arrangement || [];
  return [s.remote ? "Remote" : wa.length ? wa.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Any arrangement",
          (s.locations || []).join(", "), eff("country"),
          eff("min_salary_usd") ? money(eff("min_salary_usd")) : "", eff("posted_within_days") != null ? `posted in the last ${plural(eff("posted_within_days"), "day")}` : "",
          `up to ${plural(eff("limit") ?? 10, "job")} per run`].filter(Boolean).join(" · ");
}
function renderSearches() {
  const df = S.defaults;
  $("#search-defaults").textContent = `Defaults: ${df.country || "any country"}, posted within ${df.posted_within_days ?? "any"} days, ${df.min_salary_usd ? money(df.min_salary_usd) : "any"} pay, ${df.limit ?? 10} jobs per search.`;
  $("#searches").replaceChildren(...S.searches.map(searchCard),
    ...(S.searches.length ? [] : [h("div", { class: "notice" }, "No saved filters yet. Add one to start finding roles.")]));
  const picked = S.searches.filter((s) => S.picked.has(s.id));
  const cap = S.summary?.credits.per_run;
  const max = picked.reduce((n, s) => n + (s.limit ?? df.limit ?? 10), 0);
  $("#run-summary").replaceChildren(h("b", {}, `${picked.length} of ${S.searches.length}`), " selected · at most ",
    h("b", {}, plural(cap != null ? Math.min(max, cap) : max, "credit")), cap != null && max > cap ? ` (run cap ${cap})` : "");
}
function searchCard(s) {
  const pickBox = h("input", { type: "checkbox", checked: S.picked.has(s.id) });
  pickBox.addEventListener("change", () => { pickBox.checked ? S.picked.add(s.id) : S.picked.delete(s.id); renderSearches(); });
  const found = S.jobs.filter((j) => j.searches.includes(s.id)).length;
  const remove = h("button", { class: "ghost small danger" }, "Delete");
  remove.addEventListener("click", async () => {
    if (!remove.dataset.armed) {       // first click arms the button, the second deletes
      remove.dataset.armed = "1"; remove.textContent = "Confirm delete";
      setTimeout(() => { delete remove.dataset.armed; remove.textContent = "Delete"; }, 3000);
      return;
    }
    try { applySearches(await api(`/api/searches/${s.id}`, { method: "DELETE" })); toast(`Deleted “${s.name || s.id}”.`); }
    catch (e) { toast(e.message, true); }
  });
  return h("div", { class: "scard" + (S.picked.has(s.id) ? " picked" : "") },
    h("label", { class: "check", title: "Include in the next run" }, pickBox, h("span", { class: "nm" }, s.name || s.id)),
    h("div", { class: "tags" }, ...(s.titles || []).map((t) => h("span", { class: "tag" }, t))),
    h("div", { class: "facts" }, searchFacts(s)),
    (s.exclude_titles || []).length ? h("div", { class: "muted" }, "Excludes: ", s.exclude_titles.join(", ")) : null,
    h("footer", {},
      h("span", { class: "muted" }, h("code", {}, s.id), ` · ${plural(found, "role")} found so far`),
      h("button", { class: "ghost small", onclick: () => openSearch(s, "edit") }, "Edit"),
      h("button", { class: "ghost small", onclick: () => openSearch({ ...s, name: `${s.name || s.id} (copy)` }, "new") }, "Duplicate"),
      remove));
}

const searchDialog = $("#search-dialog"), searchForm = $("#search-form");
const sField = (name) => searchForm.elements.namedItem(name);
const lines = (v) => v.split("\n").map((x) => x.trim()).filter(Boolean);
function openSearch(s, mode) {
  const df = S.defaults;
  searchDialog._base = s || {};
  searchDialog._edit = mode === "edit" ? s.id : null;
  searchForm.reset();
  formError(searchForm);
  $("h2", searchForm).textContent = mode === "edit" ? "Edit filter" : "New filter";
  s = s || { remote: true };
  sField("name").value = s.name || "";
  for (const k of ["titles", "locations", "exclude_titles"]) sField(k).value = (s[k] || []).join("\n");
  for (const k of ["min_salary_usd", "posted_within_days", "limit"]) {
    sField(k).value = s[k] ?? "";
    sField(k).placeholder = df[k] ?? "";
  }
  sField("exclude_titles").placeholder = (df.exclude_titles || []).join("\n");
  const wa = s.work_arrangement || [];
  const modeSel = sField("mode");
  $("option[value=keep]", modeSel)?.remove();
  if (wa.length && wa.join() !== "hybrid") modeSel.append(h("option", { value: "keep" }, wa.join(", ")));
  modeSel.value = s.remote ? "remote" : wa.join() === "hybrid" ? "hybrid" : wa.length ? "keep" : "any";
  searchDialog.showModal();
  sField("name").focus();
}
$("#add-search").addEventListener("click", () => openSearch(null, "new"));
$("[data-act=cancel]", searchForm).addEventListener("click", () => searchDialog.close());
searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { ...searchDialog._base, name: sField("name").value.trim() };
  for (const k of ["titles", "locations", "exclude_titles"]) body[k] = lines(sField(k).value);
  for (const k of ["min_salary_usd", "posted_within_days", "limit"]) body[k] = sField(k).value;
  const mode = sField("mode").value;
  if (mode !== "keep") { delete body.remote; delete body.work_arrangement; }
  if (mode === "remote") body.remote = true;
  if (mode === "hybrid") body.work_arrangement = ["hybrid"];
  const id = searchDialog._edit;
  if (!id) delete body.id;        // the server names a new search from its name
  try {
    applySearches(await (id ? put(`/api/searches/${id}`, body) : post("/api/searches", body)));
    searchDialog.close();
    toast(id ? "Filter saved." : "Filter added.");
  } catch (err) { formError(searchForm, err.message); }
});
$$("[data-run]").forEach((b) => b.addEventListener("click", () => {
  const ids = S.searches.filter((s) => S.picked.has(s.id)).map((s) => s.id);
  if (!ids.length) { toast("Tick at least one filter.", true); return; }
  const kind = b.dataset.run;
  if (kind === "preflight") startRun({ kind: "preflight", search_ids: ids });
  else startRun({ kind: "run", search_ids: ids, no_tailor: kind === "triage", top: kind === "full" ? $("#run-top").value : null });
}));

// ---- runs ------------------------------------------------------------------------------------------
async function startRun(body) {
  try { runStarted(await post("/api/runs", body)); }
  catch (e) { toast(e.message, true); }
}
function runStarted(r) {
  toast(`Started: ${r.label}`);
  pollRun.live = r.id;
  showTab("runs");
  selectRun(r.id);
  loadSummary();
}
async function loadRuns() {
  try {
    const d = await api("/api/runs");
    $("#runs").replaceChildren(...d.runs.map((r) => h("li", { class: r.id === S.runId ? "selected" : "", onclick: () => selectRun(r.id) },
      h("div", { class: `st ${r.status}` }, r.status), h("div", {}, r.label), h("div", { class: "muted" }, new Date(r.started).toLocaleString()))));
    if (!d.runs.length) $("#runs").append(h("li", { class: "muted" }, "No runs yet. Start one from Filters or a job."));
  } catch (e) { /* summary shows auth errors */ }
}
function selectRun(id) {
  S.runId = id; S.runSince = 0;
  $("#runlog").textContent = "";
  renderRunResults(null);
  loadRuns();
  pollRun();
}
async function pollRun() {
  if (S.runId == null) return;
  const id = S.runId;
  clearTimeout(pollRun._t);
  try {
    const r = await api(`/api/runs/${id}?since=${S.runSince}`);
    if (id !== S.runId) return;
    $("#runlog-title").textContent = `${r.label} · ${r.status}`;
    const log = $("#runlog");
    if (r.lines.length) {
      const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.append(r.lines.join("\n") + "\n");
      S.runSince = r.line_count;
      if (pinned) log.scrollTop = log.scrollHeight;
    }
    renderRunResults(r);
    $("#stop-run").classList.toggle("hidden", r.status !== "running");
    $("#stop-run").onclick = () => post(`/api/runs/${id}/stop`).then(pollRun);
    if (r.status === "running") {
      pollRun.live = id;
      pollRun._t = setTimeout(pollRun, document.hidden ? 5000 : 1500);
    } else if (pollRun.live === id) {   // it finished while we watched: pick up what it wrote
      pollRun.live = null;
      loadRuns(); loadSummary();
      S.details.clear();
      await loadJobs({ refresh: S.notion });
      if (S.byId.get(S.selected)?.local) loadDetail(S.selected);
    }
  } catch (e) { toast(e.message, true); }
}

// What a finished run scored or tailored, each a link to that job. Follow-up questions are at the end
// of a tailored job's fit report; a scored job's gaps are beside its posting.
function renderRunResults(r) {
  const box = $("#run-results");
  const res = r && r.status !== "running" ? r.results || [] : [];
  box.classList.toggle("hidden", !r || r.status === "running");
  if (!r || r.status === "running") { box.replaceChildren(); return; }
  if (!res.length) {
    box.replaceChildren(h("p", { class: "muted" }, r.status === "done" ? "This run didn't score or tailor any jobs."
      : r.status === "interrupted" ? "The app was closed while this run was going, so it stopped and its results weren't collected."
      : "No jobs were scored or tailored."));
    return;
  }
  const tailored = res.filter((x) => x.tailored).length;
  box.replaceChildren(
    h("h3", {}, `Results: ${plural(res.length, "job")}`),
    h("p", { class: "muted" }, tailored
      ? "Open a tailored job's Fit report: its follow-up questions are at the end. Answer them in Confirmed facts, then tailor again if the answers change what the résumé can claim."
      : "Open a job to see its score, matches and likely gaps beside the posting."),
    h("ul", {}, ...res.map((x) => h("li", {},
      h("span", { class: `fit ${fitClass(x.impact_score ?? x.fit)}` }, x.impact_score ?? x.fit ?? "–"),
      h("span", { class: "what" }, h("b", {}, x.title || "(untitled)"), " · ", x.company || ""),
      x.tailored && h("span", { class: "tag ok" }, `Résumé${x.ats_total != null ? " " + pct(x.ats_total) : ""}`),
      h("span", { class: "actions-inline" },
        x.tailored && h("button", { class: "ghost small", onclick: () => openJob(x.id, "report") }, "Fit report"),
        h("button", { class: "ghost small", onclick: () => openJob(x.id, x.tailored ? "resume" : "posting") }, x.tailored ? "Résumé" : "Open"))))));
}
// Show one job's detail on the given tab, in whichever list it's in, clearing filters that hide it.
function openJob(id, tab) {
  const j = S.byId.get(id);
  if (!j) { toast("That job isn't in the list yet. Try again in a moment.", true); return; }
  const scope = SCOPES.tracker.has(j) ? "tracker" : "find";
  S.detailTab = tab; S.detailTabJob = id;
  S.sel[scope] = id;
  showTab(scope);
  if (S.selected !== id) {
    clearFilters();
    if (scope === "find" && j.dismissed) { S.findFilter = "dismissed"; renderJobs(); }
    selectJob(id, true);
  } else if (!boardMode()) renderDetail();
  if (boardMode()) selectJob(id, true);
  j._el?.scrollIntoView({ block: "nearest" });
}


// ---- startups: who just raised, and their open roles --------------------------------------------------
const ROUNDS = ["Pre-seed", "Seed", "Series A", "Series B", "Series C", "Series D+", "Growth", "Unknown"];
const ROUND_SHORT = { "Pre-seed": "PS", Seed: "S", "Series A": "A", "Series B": "B", "Series C": "C", "Series D+": "D+", Growth: "G", Unknown: "?" };
const DAYS = 90;
const since = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const hiringForYou = (s) => !s.dismissed && !s.exited && !!s.roles?.jobs?.some((j) => j.match);
const SU_VIEWS = [
  ["hiring", "Hiring for you", hiringForYou],
  ["raised", "Raised recently", (s) => !s.dismissed && s.round?.date >= since(DAYS)],
  ["yc", "YC hiring", (s) => !s.dismissed && !!s.batch && s.hiring],
  ["all", "All", (s) => !s.dismissed],
  ["dismissed", "Dismissed", (s) => s.dismissed],
];
const SU = { list: [], byId: new Map(), loaded: false, query: "", tokens: [], view: "hiring", rounds: new Set(), sort: "newest",
             selected: null, visible: [], phrases: [], busy: new Map(), refreshed: null, lookup: false };
const SU_SORTS = {
  amount: (a, b) => (b.round?.amount_usd || 0) - (a.round?.amount_usd || 0) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};
function indexStartup(s) {
  s._hay = [s.name, s.one_liner, s.hq, s.stage, s.line, s.batch, ...(s.industries || []), ...(s.tags || [])].join(" ").toLowerCase();
  s._el = null;
}
async function loadStartups({ quiet = false } = {}) {
  try {
    const d = await api("/api/startups");
    SU.list = d.startups; SU.phrases = d.phrases; SU.refreshed = d.refreshed; SU.lookup = d.lookup;
    SU.byId = new Map(SU.list.map((s) => [s.id, s]));
    SU.list.forEach(indexStartup);
    if (!SU.loaded && !SU.list.some(hiringForYou)) SU.view = "raised";   // nothing matched yet: start from the raises
    SU.loaded = true;
    renderStartups();
    if (SU.selected && !SU.byId.get(SU.selected)) SU.selected = null;
    renderStartupDetail();
    if (!SU.selected && SU.visible.length && !quiet) selectStartup(SU.visible[0].id);
  } catch (e) { if (!quiet) toast(e.message, true); }
}
const suMatches = (s, { rounds = true } = {}) => SU_VIEWS.find(([k]) => k === SU.view)[2](s)
  && SU.tokens.every((t) => s._hay.includes(t)) && (!rounds || !SU.rounds.size || SU.rounds.has(s.stage));
function renderStartupState() {
  const el = $("#startup-state");
  const going = (S.summary?.active_runs || []).find((r) => r.label === "Startup search");
  $("#startup-refresh").disabled = !!going;
  if (going) el.replaceChildren(spinner(), " Reading the sources… ", h("button", { class: "link-btn", onclick: () => { showTab("runs"); selectRun(going.id); } }, "follow it in Runs"));
  else if (SU.refreshed) {
    const hours = S.summary?.startups?.auto_refresh_hours;
    const inFind = S.jobs.filter((j) => j.searches?.includes("startups")).length;
    el.replaceChildren(`Sources and boards read ${new Date(SU.refreshed).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      + (hours ? `, again every ${hours}h on its own` : "") + " · ",
      h("button", { class: "link-btn", title: "Roles matching your filters are added there on each refresh, with the round.",
        onclick: () => { showTab("find"); S.flags.clear(); S.flags.add("startup"); renderJobs(); } }, `${plural(inFind, "startup role")} in Find jobs`));
  } else el.textContent = "";
}
function renderStartups() {
  SU.tokens = SU.query.toLowerCase().split(/\s+/).filter(Boolean);
  $("#startup-views").replaceChildren(...SU_VIEWS.map(([k, label, test]) => h("button", {
    class: SU.view === k ? "active" : "", onclick: () => { SU.view = k; renderStartups(); } },
    label, " ", h("b", {}, SU.list.filter((s) => test(s) && SU.tokens.every((t) => s._hay.includes(t))).length))));
  $("#rounds").replaceChildren(...ROUNDS.map((r) => {
    const n = SU.list.filter((s) => suMatches(s, { rounds: false }) && s.stage === r).length;
    return (n || SU.rounds.has(r)) && h("button", { class: "chip round-chip", "data-round": r, "aria-pressed": String(SU.rounds.has(r)),
      onclick: () => { SU.rounds.has(r) ? SU.rounds.delete(r) : SU.rounds.add(r); renderStartups(); } }, r, h("b", {}, n));
  }).filter(Boolean));
  const list = SU.visible = SU.list.filter((s) => suMatches(s));
  if (SU_SORTS[SU.sort]) list.sort(SU_SORTS[SU.sort]);
  $("#startup-count").textContent = plural(list.length, "startup");
  $("#startups").replaceChildren(...list.map(startupRow), ...(list.length ? [] : [h("div", { class: "list-empty" },
    !SU.loaded ? [spinner(), " Loading…"] : SU.list.length ? (SU.view === "hiring" && !filtersOnStartups()
        ? "No startup has an open role matching your filters yet. Each refresh reads their careers boards, newest raise first, and matching roles land in Find jobs."
        : "No startups match.")
      : ["No startups yet. Refresh sources reads the funding news, the YC directory and VC boards (free), then the startups' careers boards for roles matching your filters.",
         h("button", { class: "primary", onclick: refreshStartups }, "Refresh sources")])]));
  renderStartupState();
}
const filtersOnStartups = () => SU.tokens.length || SU.rounds.size;
const roundTile = (s, cls = "") => h("div", { class: `round-tile ${cls}`, "data-round": s.stage, title: s.line || "Round unknown" }, ROUND_SHORT[s.stage] || "?");
const rolesTag = (s) => {
  if (!s.roles) return null;
  const m = s.roles.jobs.filter((j) => j.match).length;
  return h("span", { class: "tag " + (m ? "ok" : "") }, m ? `${plural(m, "matching role")}` : `${plural(s.roles.jobs.length, "open role")}`);
};
function startupRow(s) {
  if (!s._el) {
    s._el = h("li", { "data-id": s.id, tabindex: "0", onclick: () => selectStartup(s.id), onkeydown: (e) => { if (e.key === "Enter") selectStartup(s.id); } },
      h("span", {}), roundTile(s),
      h("div", { class: "row-main" },
        h("div", { class: "t" }, s.name),
        h("div", { class: "s" }, [s.one_liner, s.hq].filter(Boolean).join(" · ")),
        h("div", { class: "tags" },
          h("span", { class: "tag round-tag", "data-round": s.stage, title: s.line }, s.round ? (s.round.name || s.stage) : s.batch ? `YC ${s.batch}` : "Round unknown",
            s.round?.amount && h("b", {}, ` ${s.round.amount}`), s.round?.date && h("b", {}, ` · ${fmtDate(s.round.date + "T12:00")}`)),
          s.batch && s.round && h("span", { class: "tag" }, `YC ${s.batch}`),
          s.exited && h("span", { class: "tag", title: "A VC board still lists it, but it was acquired or went public, so its roles aren't added to Find jobs on their own" }, s.exited === "public" ? "Public" : "Acquired"),
          s.hiring && h("span", { class: "tag" }, "Hiring"),
          rolesTag(s),
          s.tracked && h("span", { class: "tag stage-tag", "data-stage": "Not started" }, "Tracked"))),
      h("span", {}));
  }
  s._el.classList.toggle("selected", s.id === SU.selected);
  return s._el;
}
function selectStartup(id) {
  const prev = SU.byId.get(SU.selected);
  SU.selected = id;
  prev?._el?.classList.remove("selected");
  SU.byId.get(id)?._el?.classList.add("selected");
  renderStartupDetail();
}
function openStartup(id, company) {
  showTab("startups");
  const s = SU.byId.get(id) || SU.list.find((x) => x.name.toLowerCase() === (company || "").toLowerCase());
  if (!s) { toast("That startup isn't in the list.", true); return; }
  if (!suMatches(s)) { SU.view = s.dismissed ? "dismissed" : "all"; SU.rounds.clear(); SU.query = ""; $("#startup-filter").value = ""; renderStartups(); }
  selectStartup(s.id);
  s._el?.scrollIntoView({ block: "nearest" });
}
function repaintStartup(s) {
  indexStartup(s);
  renderStartups();
  if (s.id === SU.selected) renderStartupDetail();
}
function suReplace(d) {
  const old = SU.byId.get(d.id);
  const s = old ? Object.assign(old, d) : d;
  if (!old) { SU.list.unshift(s); SU.byId.set(s.id, s); }
  repaintStartup(s);
  return s;
}
async function suAction(s, label, fn) {
  SU.busy.set(s.id, label); renderStartupDetail();
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { SU.busy.delete(s.id); renderStartupDetail(); }
}
const readRoles = (s) => suAction(s, "roles", async () => {
  const d = suReplace(await post(`/api/startups/${encodeURIComponent(s.id)}/roles`));
  if (!d.board) toast(d.careers_url ? "No Greenhouse, Lever or Ashby board found; its careers page is linked." : "Couldn't find a careers board on its website.", true);
  else if (!d.roles.jobs.length) toast("Its board lists no open roles right now.");
});
const lookUpRound = (s) => suAction(s, "enrich", async () => { suReplace(await post(`/api/startups/${encodeURIComponent(s.id)}/enrich`)); toast(`${s.name}: ${SU.byId.get(s.id).line}`); });
const trackStartup = (s) => suAction(s, "track", async () => {
  const r = await post(`/api/startups/${encodeURIComponent(s.id)}/track`);
  s.tracked = r.tracker_id || true; repaintStartup(s);
  toast(r.action === "created" ? `${s.name} is on your tracker as "Open roles".` : `${s.name} was already tracked.`);
  loadJobs();
});
const dismissStartup = (s, dismissed) => suAction(s, "dismiss", async () => {
  suReplace(await patch(`/api/startups/${encodeURIComponent(s.id)}`, { dismissed }));
  if (dismissed) { const next = SU.visible.find((x) => x.id !== s.id); SU.selected = null; renderStartups(); if (next) selectStartup(next.id); else renderStartupDetail(); }
});
async function addRole(s, role, btn) {
  btn.disabled = true;
  try {
    const { id, existing } = await post(`/api/startups/${encodeURIComponent(s.id)}/roles/add`, { url: role.url });
    role.job_id = id;
    await loadJobs();
    toast(existing ? "That role is already in your jobs." : `Added to Find jobs: ${role.title}.`);
    renderStartupDetail();
  } catch (e) { toast(e.message, true); btn.disabled = false; }
}
function renderStartupDetail() {
  const box = $("#startup-detail");
  const s = SU.byId.get(SU.selected);
  if (!s) {
    box.replaceChildren(h("div", { class: "empty" }, SU.visible.length || !SU.loaded ? "Select a startup to see its round, what it does and its open roles." : "No startups here."));
    return;
  }
  const busy = SU.busy.get(s.id);
  const btn = (label, kind, fn, cls = "ghost", title = null) => h("button", { class: cls, disabled: !!busy, title, onclick: () => fn(s) },
    busy === kind ? [spinner(), " ", label] : label);
  const r = s.round;
  const roundText = r ? [r.name || s.stage, r.amount, r.date && new Date(r.date + "T12:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })].filter(Boolean).join(" · ")
    : s.batch ? `Round not in the news yet · YC ${s.batch}${s.yc_stage ? ` (${s.yc_stage.toLowerCase()} stage)` : ""}` : "Round unknown";
  const head = h("div", { class: "dhead" },
    h("div", { class: "dhead-top" },
      roundTile(s, "big"),
      h("div", { class: "dhead-title" },
        h("h2", {}, s.name),
        h("div", { class: "sub" }, [s.hq, s.team_size && `${s.team_size} people`, ...(s.industries || []).slice(0, 3)].filter(Boolean).join(" · "))),
      h("div", { class: "dhead-actions" },
        btn("Check its board now", "roles", readRoles, "ghost", "Reads the company's own careers board (Greenhouse, Lever or Ashby) right now. Each refresh does this on its own, and matching roles go to Find jobs."),
        btn(s.tracked ? "Tracked" : "Track company", "track", trackStartup, "ghost", "Adds an \"Open roles\" card for this company to your tracker, with its round, while you watch for the right role."))),
    h("div", { class: "bar" },
      h("span", { class: "tag round-tag", "data-round": s.stage }, roundText),
      r?.url && h("a", { href: safeHref(r.url), target: "_blank", rel: "noopener", title: r.headline }, r.source || "news", " ↗"),
      extLink(s.website, "Website"), extLink(s.careers_url || s.jobs_url, "Careers"), extLink(s.yc_url, "YC page"),
      h("span", { class: "grow" }),
      (s.stage === "Unknown" || !r) && btn("Look up the round", "enrich", lookUpRound, "ghost small",
        SU.lookup ? "Asks Fundable or People Data Labs for the latest round (one lookup credit)." : "Needs FUNDABLE_API_KEY or PDL_API_KEY in .env (both have free allowances)."),
      btn(s.dismissed ? "Restore" : "Dismiss", "dismiss", (x) => dismissStartup(x, !x.dismissed), "ghost small")));
  const pad = h("div", { class: "pad" });
  if (s.one_liner || s.description) pad.append(h("div", { class: "card" }, h("h3", {}, s.one_liner || "About"), s.description && h("p", { class: "posting-body" }, s.description)));
  if (r?.headline) pad.append(h("div", { class: "card" }, h("h3", {}, "The round"),
    h("p", {}, r.url ? h("a", { href: safeHref(r.url), target: "_blank", rel: "noopener" }, r.headline, " ↗") : r.headline),
    h("p", { class: "muted" }, [r.source, r.date && fmtDate(r.date + "T12:00")].filter(Boolean).join(" · "), " · A headline, read by the app: check the article before you quote the round.")));
  pad.append(rolesCard(s, busy));
  if (s.sources?.length) pad.append(h("div", { class: "card" }, h("h3", {}, "Seen in"),
    h("div", { class: "src-list" }, ...s.sources.map((x) => x.url ? h("a", { class: "tag", href: safeHref(x.url), target: "_blank", rel: "noopener" }, x.name || x.kind, x.at ? ` · ${fmtDate(x.at + "T12:00")}` : "")
      : h("span", { class: "tag" }, x.name || x.kind)))));
  box.replaceChildren(head, pad);
}
function rolesCard(s, busy) {
  const card = h("div", { class: "card" }, h("h3", {}, "Open roles"));
  if (!s.roles) {
    card.append(h("p", { class: "muted" }, busy === "roles" ? [spinner(), " Reading its careers board…"]
      : ["Its board hasn't been read yet. Each refresh reads the startups' boards on its own, newest raise first, and roles matching your filters (",
         SU.phrases.join(", ") || "none saved", ") go to Find jobs. ", h("button", { class: "link-btn", onclick: () => readRoles(s) }, "Check its board now"), "."]));
    return card;
  }
  const jobs = s.roles.jobs, match = jobs.filter((j) => j.match), rest = jobs.filter((j) => !j.match);
  if (s.exited) card.append(h("p", { class: "muted" }, `It was ${s.exited === "public" ? "taken public" : "acquired"}, so it isn't a startup any more: its matching roles are shown here but not added to Find jobs on their own. Add one if you want it.`));
  if (!s.board) card.append(h("p", { class: "muted" }, s.roles.from_vc_board ? "Listed by a VC portfolio board; the company's own board wasn't found." : "No Greenhouse, Lever or Ashby board was found on its website.",
    s.careers_url ? [" Its careers page: ", extLink(s.careers_url, host(s.careers_url))] : "", s.exited ? "" : " A role it lists that matches your filters is in Find jobs already; another one can be ",
    s.exited ? "" : h("button", { class: "link-btn", onclick: () => { addDialog.showModal(); addField("company").value = s.name; addField("url").focus(); } }, "added by its link"), s.exited ? "" : "."));
  else card.append(h("p", { class: "muted" }, `${plural(jobs.length, "open role")} on `, extLink(s.board.url, s.board.kind.replace(/^./, (c) => c.toUpperCase())),
    s.roles.checked ? ` · read ${fmtDate(s.roles.checked)}` : "", match.length ? ` · ${match.length} match your filters (title and place) and are in Find jobs` : jobs.length ? " · none match your filters' titles and places" : ""));
  const roleLi = (j) => {
    const added = j.job_id && h("button", { class: "ghost small", title: "Added on its own, because it matches your filters", onclick: () => openJob(j.job_id, "posting") }, j.status ? `Tracked · ${j.status}` : "In Find jobs");
    const addBtn = h("button", { class: j.match ? "primary small" : "ghost small", title: "Stores the posting here, with the round, so you can score or tailor it" }, "Add to Find jobs");
    addBtn.addEventListener("click", () => addRole(s, j, addBtn));
    return h("li", { class: j.match ? "match" : "" },
      h("div", { class: "what" }, h("div", { class: "t" }, j.title), h("div", { class: "s" }, [j.location, j.remote && "Remote", j.pay, j.posted && `Posted ${fmtDate(j.posted + "T12:00")}`].filter(Boolean).join(" · "))),
      extLink(j.url, "Posting"), added || addBtn);
  };
  if (match.length) card.append(h("ul", { class: "roles" }, ...match.map(roleLi)));
  if (rest.length) card.append(h("details", { class: "roles" }, h("summary", {}, `${plural(rest.length, "other role")} that don't match your filters`), h("ul", { class: "roles" }, ...rest.map(roleLi))));
  return card;
}
async function refreshStartups() {
  try {
    const r = await post("/api/startups/refresh");
    toast(`Started: ${r.label}. The list updates when it finishes.`);
    loadSummary();
  } catch (e) { toast(e.message, true); }
}
$("#startup-refresh").addEventListener("click", refreshStartups);
$("#startup-filter").addEventListener("input", (e) => { SU.query = e.target.value; clearTimeout(renderStartups._t); renderStartups._t = setTimeout(renderStartups, 60); });
$("#startup-sort").addEventListener("change", (e) => { SU.sort = e.target.value; renderStartups(); });
const suDialog = $("#startup-dialog"), suForm = $("#startup-form");
$("#startup-add").addEventListener("click", () => { suForm.reset(); formError(suForm); suDialog.showModal(); suForm.elements.namedItem("name").focus(); });
$("[data-act=cancel]", suForm).addEventListener("click", () => suDialog.close());
suForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(suForm).entries());
  if (!body.name.trim()) { formError(suForm, "Give the startup's name."); return; }
  try {
    const s = suReplace(await post("/api/startups", body));
    suDialog.close();
    SU.view = "all"; SU.rounds.clear(); renderStartups();
    selectStartup(s.id);
    toast(s.line ? `${s.name}: ${s.line}` : `Added ${s.name}. Find open roles reads its careers board.`);
  } catch (err) { formError(suForm, err.message); }
});

// ---- notes ------------------------------------------------------------------------------------------
async function loadNotes() {
  try {
    const d = await api("/api/notes");
    $("#notes").replaceChildren(h("pre", { class: "posting" }, d.markdown || "No confirmed facts yet."));
  } catch (e) { toast(e.message, true); }
}
$("#add-note").addEventListener("click", async () => {
  const t = $("#note-text");
  if (!t.value.trim()) return;
  try { await post("/api/notes", { text: t.value }); t.value = ""; loadNotes(); toast("Recorded."); }
  catch (e) { toast(e.message, true); }
});

// ---- profile -------------------------------------------------------------------------------------
// searches.yaml's candidate section: who the résumés are for, and which résumés to score against.
const P = { data: null, rows: [], fallback: null, base: "" };
const pForm = $("#profile-form"), pField = (n) => pForm.elements.namedItem(n);
const PROFILE_TEXT = ["name", "pronouns", "city", "phone", "email", "linkedin", "pdf_prefix", "evidence"];
const prefixFor = (name) => (name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Your-Name") + "-Resume";
const fileLabel = (f) => f.replace(/^resume-|\.md$/g, "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") + " resume";

function profileState() {
  const out = Object.fromEntries(PROFILE_TEXT.map((k) => [k, pField(k).value.trim()]));
  const ticked = P.rows.filter((r) => r.ticked);
  const first = ticked.find((r) => r.file === P.fallback) || ticked[0];
  out.resumes = (first ? [first, ...ticked.filter((r) => r !== first)] : []).map((r) => ({ name: r.name.trim(), file: r.file }));
  return out;
}
const profileDirty = () => !!P.data && JSON.stringify(profileState()) !== P.base;

async function loadProfile() {
  if (!P.data || !profileDirty()) {
    try { applyProfile(await api("/api/profile")); } catch (e) { toast(e.message, true); }
  }
}
function applyProfile(d) {
  P.data = d;
  const c = d.candidate;
  for (const k of PROFILE_TEXT) pField(k).value = c[k] || "";
  pField("evidence").placeholder = d.default_evidence;
  const facts = new Map(d.files.map((f) => [f.file, f]));
  P.rows = [...c.resumes.map((r) => ({ ...r, ticked: facts.has(r.file), missing: !facts.has(r.file) })),
            ...d.files.filter((f) => !c.resumes.some((r) => r.file === f.file)).map((f) => ({ file: f.file, name: "", ticked: false }))];
  P.fallback = c.resumes.find((r) => facts.has(r.file))?.file || null;
  $("#profile-first").classList.toggle("hidden", d.saved && !d.example);
  $("#profile-first-text").textContent = d.example
    ? `This is a made-up example profile, so you can try the app. Put in your own details and save; your files are in ${d.folder}.`
    : "No profile is saved yet. Put in your details and save.";
  formError(pForm);
  renderResumeRows();
  P.base = JSON.stringify(profileState());
  profileChanged();
  const ir = d.impact_record;
  $("#profile-impact").textContent = ir.words ? `${ir.words.toLocaleString()} words` : "empty";
}
function renderResumeRows() {
  const facts = new Map(P.data.files.map((f) => [f.file, f]));
  if (!P.rows.some((r) => r.ticked && r.file === P.fallback)) P.fallback = P.rows.find((r) => r.ticked)?.file || null;
  $("#resume-files").replaceChildren(...P.rows.map((r) => {
    const f = facts.get(r.file);
    const tick = h("input", { type: "checkbox", checked: r.ticked, disabled: r.missing, "aria-label": `Score against ${r.file}` });
    const name = h("input", { type: "text", value: r.name, placeholder: fileLabel(r.file), disabled: !r.ticked, "aria-label": `Name for ${r.file}` });
    const fb = h("input", { type: "radio", name: "fallback", checked: r.ticked && r.file === P.fallback, disabled: !r.ticked });
    tick.addEventListener("change", () => {
      r.ticked = tick.checked;
      if (r.ticked && !r.name.trim()) r.name = fileLabel(r.file);
      renderResumeRows(); profileChanged();
      if (r.ticked) $(`[data-file="${CSS.escape(r.file)}"] input[type=text]`)?.select();
    });
    name.addEventListener("input", () => { r.name = name.value; profileChanged(); });
    fb.addEventListener("change", () => { P.fallback = r.file; profileChanged(); });
    return h("li", { class: "rfile" + (r.ticked ? " on" : ""), "data-file": r.file },
      tick, name,
      h("div", { class: "rmeta" }, h("code", {}, r.file),
        r.missing ? h("span", { class: "tag warn-tag" }, "file missing")
          : h("span", { class: "muted" }, [f.headline, plural(f.words, "word")].filter(Boolean).join(" · "))),
      h("label", { class: "check fb", title: "Where the writers start when the matcher's pick isn't one of these" }, fb, "Fallback"));
  }), ...(P.rows.length ? [] : [h("li", { class: "muted" }, "No résumés in your profile folder yet. Add one below.")]));
}
function profileChanged() {
  const name = pField("name").value.trim();
  pField("pdf_prefix").placeholder = prefixFor(name);
  $("#contact-preview").textContent = ["city", "phone", "email", "linkedin"].map((k) => pField(k).value.trim()).filter(Boolean).join(" | ") || "—";
  $("#pdf-preview").textContent = `${pField("pdf_prefix").value.trim() || prefixFor(name)}-Acme-Staff-Technical-Program-Manager.pdf`;
  const dirty = profileDirty();
  $("#profile-save").disabled = !dirty;
  $("#profile-discard").disabled = !dirty;
  $("#profile-state").textContent = dirty ? "Unsaved changes" : P.data?.saved ? "Saved in searches.yaml" : "";
}
pForm.addEventListener("input", (e) => { if (!e.target.closest(".rfile")) profileChanged(); });
$("#profile-discard").addEventListener("click", () => applyProfile(P.data));
pForm.addEventListener("submit", (e) => { e.preventDefault(); saveProfile(); });
async function saveProfile() {
  if (!profileDirty()) return;
  const btn = $("#profile-save");
  btn.disabled = true;
  try {
    applyProfile(await put("/api/profile", profileState()));
    toast("Profile saved. The next score or résumé uses it.");
  } catch (e) { formError(pForm, e.message); btn.disabled = false; }
}
$("#resume-add").addEventListener("click", () => $("#resume-upload").click());
$("#resume-upload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const body = { filename: file.name, markdown: await file.text() };
  let d;
  try { d = await post("/api/profile/resumes", body); }
  catch (err) {
    if (!/already exists/.test(err.message) || !confirm(`${err.message} Replace it with ${file.name}?`)) { if (!/already exists/.test(err.message)) toast(err.message, true); return; }
    try { d = await post("/api/profile/resumes", { ...body, replace: true }); } catch (err2) { toast(err2.message, true); return; }
  }
  P.data.files = d.files;              // keep unsaved edits; tick the new résumé
  let row = P.rows.find((r) => r.file === d.file);
  if (!row) P.rows.push(row = { file: d.file, name: "" });
  Object.assign(row, { ticked: true, missing: false, name: row.name || fileLabel(d.file) });
  renderResumeRows(); profileChanged();
  toast(`Added ${d.file}. Save the profile to start scoring against it.`);
});

$("#profile-impact-link").addEventListener("click", () => showTab("impact"));
document.addEventListener("keydown", (e) => {
  if (S.tab === "profile" && (e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveProfile(); }
});
window.addEventListener("beforeunload", (e) => { if (profileDirty() || aiDirty()) e.preventDefault(); });

// ---- the AI: which provider and models do the work (searches.yaml's models: section, the key in the profile's .env)
const AI = { data: null, base: "", models: [] };
const aForm = $("#ai-form"), aField = (n) => aForm.elements.namedItem(n);
const AI_STAGES = [["triage", "Quick score", "one short call per job"],
                   ["analysis", "Analysis", "reading the posting, matching your evidence"],
                   ["writer", "Writing", "the résumé drafts and the merge"]];
const AI_NOTES = {
  "claude-code": "Uses your Claude Pro or Max plan through Claude Code, so there's nothing to pay per call. Sign in once with the button below.",
  api: "Pays per call with a Claude API key (console.anthropic.com).",
  openai: "Pays per call with an OpenAI API key. A ChatGPT subscription doesn't include API use.",
  gemini: "Uses a Google AI Studio key, paid per call. Check Google's page for any free allowance.",
  openrouter: "One key for models from many companies, paid per call; a few models are free.",
  ollama: "Free, on this Mac. Install Ollama, download a model, and give it a large context window (OLLAMA_CONTEXT_LENGTH=65536): each step reads your whole impact record and every résumé. Small models give weak results.",
  lmstudio: "Free, on this Mac. Start LM Studio's server and load a model with a context length of 64k or more: each step reads your whole impact record and every résumé. Small models give weak results.",
  "openai-compatible": "Any server with an OpenAI-style chat API (vLLM, LiteLLM, Together, Groq and others).",
};
const isClaude = (b) => b === "claude-code" || b === "api";
const aiProvider = (b) => AI.data?.providers.find((p) => p.id === b);

function aiState() {
  const out = { backend: aField("backend").value, base_url: aField("base_url").value.trim(), stages: {} };
  for (const [s] of AI_STAGES) out.stages[s] = { model: $(`#ai-model-${s}`).value.trim(), effort: $(`#ai-effort-${s}`).value };
  return out;
}
const aiDirty = () => !!AI.data && (JSON.stringify(aiState()) !== AI.base || !!aField("key").value.trim());

async function loadAI() {
  loadKeys();
  if (AI.data && aiDirty()) return;
  try { applyAI(await api("/api/ai")); } catch (e) { toast(e.message, true); }
}
async function loadKeys(d) {
  try { d = d || await api("/api/keys"); } catch (e) { return; }
  $("#keys").replaceChildren(...d.keys.map((k) => {
    const box = h("input", { type: "password", autocomplete: "new-password", spellcheck: "false",
                             placeholder: k.set ? "•••••••• (saved)" : "paste the key", "aria-label": `${k.label} key` });
    const save = h("button", { type: "button", class: "ghost", disabled: true }, "Save");
    box.addEventListener("input", () => { save.disabled = !box.value.trim(); });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        loadKeys(await put("/api/keys", { name: k.name, value: box.value.trim() }));
        toast(`${k.label} key saved.${k.restart ? " Quit and reopen the app to start using it." : ""}`);
      } catch (e) { toast(e.message, true); save.disabled = false; }
    });
    return h("li", {}, h("div", { class: "what" }, k.label, " ", extLink(k.url, "get one"), h("span", { class: "muted" }, k.for)), box, save);
  }));
}
function applyAI(d) {
  AI.data = d;
  aField("backend").replaceChildren(...d.providers.map((p) => h("option", { value: p.id }, p.label)));
  aField("backend").value = d.backend;
  aField("base_url").value = d.base_url;
  aField("key").value = "";
  $("#ai-stages").replaceChildren(...AI_STAGES.flatMap(([s, name, what]) => [
    h("div", { class: "ai-step" }, name, h("span", { class: "muted" }, what)),
    h("input", { id: `ai-model-${s}`, list: "ai-models", value: d.stages[s].model, placeholder: "model", spellcheck: "false", "aria-label": `${name} model` }),
    h("select", { id: `ai-effort-${s}`, "aria-label": `${name} effort` },
      ...["low", "medium", "high"].map((e) => h("option", { value: e, selected: d.stages[s].effort === e }, e))),
  ]));
  AI.base = JSON.stringify(aiState());
  formError(aForm);
  aiProviderShown(false);
}
// Show the key and address fields the chosen provider needs, and offer its models.
function aiProviderShown(changed) {
  const b = aField("backend").value, p = aiProvider(b) || {};
  $("#ai-key-row").classList.toggle("hidden", !p.key_env);
  $("#ai-key-hint").textContent = p.key_env ? (p.key_set ? `saved as ${p.key_env}; type a new one to replace it` : `saved as ${p.key_env} in your profile's .env`) : "";
  aField("key").placeholder = p.key_set ? "••••••••" : p.local || b === "openai-compatible" ? "if the server needs one" : "paste your key";
  $("#ai-url-row").classList.toggle("hidden", !(b === "openai-compatible" || p.local));
  aField("base_url").placeholder = p.base_url || "http://localhost:8000/v1";
  $("#ai-note").replaceChildren(AI_NOTES[b] || "", p.signup ? " " : "", p.signup ? extLink(p.signup, "Get started") : "");
  $("#ai-claude").classList.toggle("hidden", b !== "claude-code");
  if (b === "claude-code") claudeStatus();
  if (changed) {                                      // a different family of models: the old names won't work
    const wasClaude = isClaude(AI.lastBackend ?? AI.data.backend);
    if (isClaude(b) !== wasClaude || !isClaude(b)) for (const [s] of AI_STAGES) $(`#ai-model-${s}`).value = isClaude(b) ? AI.data.claude_models[0] : "";
  }
  AI.lastBackend = b;
  setModels(isClaude(b) ? AI.data.claude_models : []);
  $("#ai-state").textContent = "";
  if (!isClaude(b) && (p.key_set || p.local)) checkAI(true);
  aiChanged();
}
function setModels(list) {
  AI.models = list;
  $("#ai-models").replaceChildren(...list.map((m) => h("option", { value: m })));
}
async function checkAI(quiet = false) {
  const s = aiState(), state = $("#ai-state");
  state.replaceChildren(spinner(), " Checking…");
  try {
    const d = await post("/api/ai/models", { backend: s.backend, base_url: s.base_url, key: aField("key").value.trim() });
    setModels(d.models);
    state.textContent = isClaude(s.backend) ? "" : `Connected: ${plural(d.models.length, "model")} available. Pick one for each step.`;
    for (const [st] of AI_STAGES) {                  // fill empty model boxes with the first listed model
      const box = $(`#ai-model-${st}`);
      if (!box.value && d.models.length) box.value = d.models[0];
    }
    aiChanged();
  } catch (e) { state.textContent = quiet ? "" : e.message; if (!quiet) toast(e.message, true); }
}
function aiChanged() {
  const dirty = aiDirty();
  $("#ai-save").disabled = !dirty;
  if (dirty && !$("#ai-state").textContent) $("#ai-state").textContent = "Unsaved changes";
}
async function claudeStatus() {
  const st = $("#ai-claude-state"), btn = $("#ai-claude-login");
  st.replaceChildren(spinner());
  try {
    const d = await api("/api/ai/claude");
    btn.disabled = !d.found;
    st.replaceChildren(d.found ? "Opens Terminal: type /login there and sign in with your Claude account."
      : h("span", {}, "Claude Code isn't installed. ", extLink("https://claude.ai/download", "Install the Claude app"), ", then reopen this tab."));
  } catch (e) { st.textContent = e.message; }
}
$("#ai-claude-login").addEventListener("click", async () => {
  try { await post("/api/ai/claude-login"); toast("Terminal is open: type /login, sign in, then close it."); }
  catch (e) { toast(e.message, true); }
});
aField("backend").addEventListener("change", () => aiProviderShown(true));
aForm.addEventListener("input", (e) => { if (e.target.name !== "backend" && !e.target.closest("#keys")) aiChanged(); });
$("#ai-check").addEventListener("click", () => checkAI());
aForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!aiDirty()) return;
  const btn = $("#ai-save");
  btn.disabled = true;
  try {
    applyAI(await put("/api/ai", { ...aiState(), key: aField("key").value.trim() }));
    loadSummary();
    toast("AI settings saved. The next score or résumé uses them.");
  } catch (err) { formError(aForm, err.message); btn.disabled = false; }
});

// ---- markdown documents: the impact record and interview prep ---------------------------------------
// Each is saved a moment after you stop typing, on ⌘S, and when you switch tabs. Each save sends the
// version it started from; if the file was changed elsewhere meanwhile (Claude, another editor), the
// server refuses and the banner offers to load that version or save over it. While a document is open
// and has no unsaved edits, changes made elsewhere are loaded as they happen.
// Views: Formatted (a Typora-style editor, static/vendor/editor.js, loaded when first shown), Markdown
// (the text), and Side by side (the text and a preview). The text box always holds the current markdown;
// the formatted editor writes into it as you type.
const AUTOSAVE_MS = 1200;

function loadScript(src) {
  return new Promise((ok, fail) => document.head.append(h("script", { src, onload: ok, onerror: () => fail(new Error("couldn't load the editor")) })));
}
// The outline: every # and ## heading outside code blocks, with its line number.
function headings(text) {
  const out = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, line: i, label: m[2].replace(/\\(.)/g, "$1").replace(/[*_`]/g, "") });
  });
  return out;
}

function docEditor({ key, url, onSaved = () => {} }) {
  const el = (part) => $(`#${key}-${part}`);
  const text = el("text"), preview = el("preview");
  const D = { loaded: false, version: null, saved: "", updated: null, saving: null, saves: 0, timer: null, failed: "",
              conflict: null, previewed: null, previewTimer: null, mirror: null, editor: null, opening: null };
  const dirty = () => D.loaded && text.value !== D.saved;
  const view = () => S.docViews[key];

  async function load() {
    if (D.saving) return;
    const saves = D.saves;
    let d;
    try { d = await api(url); }
    catch (e) { if (!D.loaded) setState(`Couldn't open it: ${e.message}`, "bad"); return; }
    if (D.saving || D.saves !== saves) return;    // a save started meanwhile: this reply may be older than it
    // Unsaved edits stay put; if the file moved on underneath them, the next save reports the conflict.
    if (sync()) edited();
    if (!dirty()) apply(d);
    if (view() === "formatted" && !D.editor) await setView("formatted");
  }
  function apply(d) {
    Object.assign(D, { loaded: true, version: d.version, saved: d.markdown, updated: d.updated, conflict: null, failed: "" });
    if (text.value !== d.markdown) {
      const top = text.scrollTop;
      text.value = d.markdown;
      text.scrollTop = top;
    }
    if (D.editor && D.editor.getMarkdown() !== d.markdown) { D.editor.setMarkdown(d.markdown); D.editor.rebase(d.markdown); }
    el("conflict").classList.add("hidden");
    onSaved(d);
    changed();
  }

  async function save(force = false) {
    clearTimeout(D.timer);
    sync();
    if (!dirty() || (D.conflict && !force)) return;
    if (D.saving) { await D.saving; return save(force); }
    const md = text.value;
    D.failed = "";
    D.saves++;
    setState("Saving…");
    D.saving = (async () => {
      try {
        const res = await request(url, { method: "PUT", body: JSON.stringify({ markdown: md, version: D.version, force }) });
        const d = await res.json();
        if (res.status === 409) {
          D.conflict = d.current;
          el("conflict").classList.remove("hidden");
          return;
        }
        if (!res.ok) throw new Error(d.detail || res.statusText);
        Object.assign(D, { version: d.version, saved: md, updated: d.updated, conflict: null });
        el("conflict").classList.add("hidden");
        onSaved(d);
      } catch (e) {
        D.failed = e instanceof TypeError ? "the app's server isn't running" : e.message;
      } finally { D.saving = null; }
    })();
    await D.saving;
    state();
    if (dirty() && !D.conflict && !D.failed) D.timer = setTimeout(save, AUTOSAVE_MS);   // typed while it saved
  }

  function state() {
    el("dirty").classList.toggle("hidden", !dirty());
    if (D.saving) return;
    if (D.conflict) return setState("Not saved: changed elsewhere", "bad");
    if (D.failed) return setState(`Not saved: ${D.failed}`, "bad");
    if (dirty()) return setState("Unsaved changes");
    const when = D.updated && new Date(D.updated * 1000);
    setState(!when ? "" : `Saved ${when.toDateString() === new Date().toDateString()
      ? when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : fmtDate(when)}`, "good");
  }
  function setState(msg, tone = "") {
    const s = el("state");
    s.textContent = msg;
    s.className = `save-state ${tone}`;
  }

  function changed() {
    state();
    clearTimeout(D.previewTimer);
    D.previewTimer = setTimeout(() => { renderOutline(); renderPreview(); }, 350);
  }
  function edited() {
    changed();
    clearTimeout(D.timer);
    if (!D.conflict) D.timer = setTimeout(save, AUTOSAVE_MS);
  }
  text.addEventListener("input", edited);
  text.addEventListener("blur", () => save());

  // The formatted view. Blocks you didn't touch keep their exact markdown; only edited ones are rewritten.
  function sync() {
    if (view() !== "formatted" || !D.editor) return false;
    const md = D.editor.getMarkdown();
    if (md === text.value) return false;
    text.value = md;
    return true;
  }
  function openEditor() {
    D.opening = D.opening || (async () => {
      try {
        if (!window.MarkdownEditor) await loadScript($("meta[name=editor-src]").content);
        D.editor = await MarkdownEditor.create(el("editor"), text.value, { onChange: () => { if (sync()) edited(); } });
        el("editor").addEventListener("focusout", () => save());
      } catch (e) {
        D.opening = null;
        setState(`Formatted view unavailable: ${e.message}`, "bad");
      }
    })();
    return D.opening;
  }

  async function renderPreview() {
    if (view() !== "split" || D.previewed === text.value) return;
    const md = text.value;
    try {
      const { html } = await post(`${url}/preview`, { markdown: md });
      if (text.value !== md) return;      // a newer render is on its way
      preview.innerHTML = html;
      D.previewed = md;
    } catch (e) { /* the editor still works; the state line reports a server that's gone */ }
  }

  function renderOutline() {
    el("outline").replaceChildren(...headings(text.value).map((x, n) =>
      h("button", { class: `l${x.level}`, title: x.label, onclick: () => jumpTo(x, n) }, x.label)));
  }
  function jumpTo(x, n) {
    if (view() === "formatted") {
      const box = el("wysiwyg"), hd = $$("h1, h2", box)[n];
      if (hd) box.scrollTop = hd.offsetTop - box.offsetTop - 12;
      return;
    }
    const pos = text.value.split("\n").slice(0, x.line).reduce((a, l) => a + l.length + 1, 0);
    text.scrollTop = Math.max(0, caretTop(pos) - 12);
    text.focus({ preventScroll: true });
    text.setSelectionRange(pos, pos);
    if (view() === "split") {
      const hd = $$("h1, h2", preview)[n];
      if (hd) preview.scrollTop = hd.offsetTop - preview.offsetTop - 12;
    }
  }
  // Where character `pos` sits in the textarea, measured on a hidden copy laid out the same way.
  function caretTop(pos) {
    const m = D.mirror || (D.mirror = document.body.appendChild(h("div", { class: "doc-mirror", "aria-hidden": "true" })));
    const cs = getComputedStyle(text);
    for (const k of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize",
                     "paddingTop", "paddingLeft", "paddingRight"]) m.style[k] = cs[k];
    m.style.width = `${text.clientWidth}px`;
    m.textContent = text.value.slice(0, pos);
    const mark = m.appendChild(h("span", {}, "​"));
    return mark.offsetTop - parseFloat(cs.paddingTop);
  }

  async function setView(v) {
    sync();                      // leaving the formatted view: the text box gets its latest
    S.docViews[key] = v;
    savePrefs();
    $$(`#${key}-view button`).forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    el("body").dataset.view = v;
    renderPreview();
    if (v === "formatted" && D.loaded) {
      await openEditor();
      // Edited as text meanwhile: show that, keeping the text exactly as typed.
      if (D.editor && D.editor.getMarkdown() !== text.value) { D.editor.setMarkdown(text.value); D.editor.rebase(text.value); }
    }
  }
  $$(`#${key}-view button`).forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  el("save").addEventListener("click", () => save());
  el("conflict").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "load") { apply(D.conflict); toast("Loaded the version on disk."); }
    else if (act === "force") save(true);
  });

  return { load, save, setView, dirty: () => { sync(); return dirty(); },
           toggleView: () => setView(view() === "formatted" ? "edit" : "formatted") };
}

const DOCS = {
  impact: docEditor({ key: "impact", url: "/api/impact-record",
                      onSaved: (d) => { if (S.summary?.impact_record) S.summary.impact_record.updated = d.updated; } }),
  prep: docEditor({ key: "prep", url: "/api/interview-prep",
                    onSaved: (d) => { Object.assign($("#prep-path"), { textContent: d.path.split("/").slice(-2).join("/"), title: d.path }); } }),
};
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || !(S.tab in DOCS)) return;
  if (e.key === "s") { e.preventDefault(); DOCS[S.tab].save(); }
  else if (e.key === "/") { e.preventDefault(); DOCS[S.tab].toggleView(); }
});
window.addEventListener("beforeunload", (e) => {
  for (const d of Object.values(DOCS)) if (d.dirty()) { d.save(); e.preventDefault(); e.returnValue = ""; }
});

// ---- keyboard ---------------------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
  if (e.target.closest("input, textarea, select, [contenteditable]")) {
    if (e.key === "Escape" && e.target.id === "job-filter") e.target.blur();
    return;
  }
  if (e.key === "/") { e.preventDefault(); showTab(S.scope); $("#job-filter").focus(); return; }
  if (!(S.tab in SCOPES)) return;
  const j = S.byId.get(S.selected);
  if (e.key === "Escape") closeDrawer();
  else if (e.key === "s" && j) toggleStar(j);
  else if ((e.key === "j" || e.key === "k") && !boardMode() && S.visible.some((x) => !collapsed(x))) {
    const shown = S.visible.filter((x) => !collapsed(x));
    const i = shown.indexOf(j);
    const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "j" ? 1 : -1)))];
    selectJob(next.id);
    next._el?.scrollIntoView({ block: "nearest" });
  }
});

// ---- boot -------------------------------------------------------------------------------------------
(async function boot() {
  if (!TOKEN) $("#auth-error").classList.remove("hidden");
  $$("[data-icon]").forEach((el) => { el.innerHTML = ICONS[el.dataset.icon]; });
  $("#job-sort").value = S.sort;
  $("#job-group").value = S.group;
  $$("#view-seg button").forEach((x) => x.classList.toggle("active", x.dataset.view === S.view));
  applyLayout();
  Object.entries(DOCS).forEach(([k, d]) => d.setView(S.docViews[k]));
  await Promise.all([loadSummary(), loadJobs()]);
  setScope("tracker");
  // An open document also picks up changes made elsewhere, e.g. notes Claude adds to interview prep.
  setInterval(() => { if (!document.hidden) { loadSummary(); if (S.tab in DOCS) DOCS[S.tab].load(); } }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { loadSummary(); loadJobs(); if (S.tab in DOCS) DOCS[S.tab].load(); }
  });
  window.addEventListener("focus", () => { if (S.tab in DOCS) DOCS[S.tab].load(); });
})();
