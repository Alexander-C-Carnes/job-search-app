// Transit: the pipeline as a transit line. A navy split-flap departure board announces an application
// (NOW BOARDING · APPLIED · the company) and an arrival (ARRIVED · DONE), then settles into the look's
// words; a rejection brings a very fat cat on a platform bench under a small Denied sign. No sound.
// Registered with theme.js's Look.register; the dressing itself is themes/transit.css.
"use strict";
(() => {
  const L = window.Look;
  if (!L?.register) return;
  const { h } = L;
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:&'- ";

  // ---- the departure board --------------------------------------------------------------------------
  let layer = null, boardEl = null, timer = null, gen = 0;
  function clearBoard() {
    clearTimeout(timer);
    const el = boardEl;
    boardEl = null;
    if (!el) return;
    if (L.RM()) { el.remove(); return; }
    el.classList.add("out");
    setTimeout(() => el.remove(), 380);
  }
  // Each character is a flap cell; every cell flips through a few random characters before it settles.
  function flapRow(container, text) {
    const chars = [...text];
    const cells = chars.map((ch) => {
      const s = h("span", { class: "flap" + (ch === " " ? " space" : "") }, " ");
      container.append(s);
      return s;
    });
    if (L.RM()) { cells.forEach((c, i) => { c.textContent = chars[i]; }); return Promise.resolve(); }
    return new Promise((res) => {
      let pending = 0;
      cells.forEach((c, i) => {
        const target = chars[i];
        if (target === " ") return;
        const steps = 3 + Math.floor(Math.random() * 4);
        let k = 0;
        pending++;
        const tick = () => {
          if (!c.isConnected) { if (--pending === 0) res(); return; }
          c.classList.remove("flipping"); void c.offsetWidth; c.classList.add("flipping");
          setTimeout(() => { c.textContent = k < steps ? ALPHA[Math.floor(Math.random() * ALPHA.length)] : target; }, 45);
          k++;
          if (k <= steps) setTimeout(tick, 90); else if (--pending === 0) res();
        };
        setTimeout(tick, i * 18);
      });
      if (!pending) res();
    });
  }
  function showBoard(lines, stage, message, ms) {
    clearBoard();
    const me = ++gen;
    if (!layer) { layer = h("div", { class: "transit-moment" }); document.body.append(layer); }
    const el = h("div", { class: "transit-board", "data-stage": stage, role: "status", onclick: clearBoard },
      h("div", { class: "rail" }), ...lines.map(() => h("div", { class: "flaps" })), h("div", { class: "boardmsg" }));
    layer.append(el);
    boardEl = el;
    timer = setTimeout(clearBoard, ms);
    Promise.all([...el.querySelectorAll(".flaps")].map((f, i) => flapRow(f, lines[i]))).then(() => {
      if (gen !== me || !el.isConnected) return;
      const m = el.querySelector(".boardmsg");
      m.textContent = message;
      m.classList.add("show");
    });
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") clearBoard(); });

  // The station's roundel in the pipeline swells once when a role arrives there.
  function pop(stage) {
    const n = document.querySelector(`#stages .stage[data-stage="${stage}"] .n`);
    if (!n || L.RM()) return;
    n.classList.remove("pop"); void n.offsetWidth; n.classList.add("pop");
    setTimeout(() => n.classList.remove("pop"), 600);
  }
  const company = (job) => (job.company || job.title || "").toUpperCase().slice(0, 22);
  const lines = (a, b, c) => (innerWidth < 900 ? [a, b, c] : [`${a}   ${b}   ${c}`]);

  // ---- the cat: very fat, on a platform bench under a small Denied sign, sighing -------------------
  const CAT = `<svg class="cat cat-transit" viewBox="0 0 250 150">
    <rect x="0" y="130" width="250" height="20" fill="#E6EDF4"/><rect x="0" y="126" width="250" height="4" fill="#DDAA00"/><path d="M0 130 H250" stroke="#0B1F3A" stroke-width="1.5"/>
    <path d="M192 0 V14" stroke="#0B1F3A" stroke-width="1.5"/><rect x="152" y="14" width="80" height="26" rx="3" fill="#AC64BB" stroke="#0B1F3A" stroke-width="1.5"/>
    <text x="192" y="32" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="16" fill="#fff">Denied</text>
    <rect x="66" y="108" width="7" height="22" fill="#0B1F3A"/><rect x="178" y="108" width="7" height="22" fill="#0B1F3A"/><rect x="44" y="100" width="164" height="10" rx="3" fill="#0B1F3A"/>
    <path class="tail" d="M168 88 q26 -4 30 18" fill="none" stroke="#0B1F3A" stroke-width="7" stroke-linecap="round"/><path class="tail" d="M168 88 q26 -4 30 18" fill="none" stroke="#9FB0C3" stroke-width="4" stroke-linecap="round"/>
    <ellipse cx="120" cy="76" rx="54" ry="30" fill="#9FB0C3" stroke="#0B1F3A" stroke-width="2"/>
    <ellipse cx="124" cy="86" rx="36" ry="16" fill="#D5DEE8"/>
    <ellipse cx="92" cy="104" rx="11" ry="5" fill="#D5DEE8" stroke="#0B1F3A" stroke-width="1.5"/><ellipse cx="118" cy="105" rx="11" ry="5" fill="#D5DEE8" stroke="#0B1F3A" stroke-width="1.5"/>
    <path class="ear" d="M56 48 L50 28 L66 40 Z" fill="#9FB0C3" stroke="#0B1F3A" stroke-width="2" stroke-linejoin="round"/><path class="ear r" d="M76 40 L90 28 L84 48 Z" fill="#9FB0C3" stroke="#0B1F3A" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="70" cy="58" r="19" fill="#9FB0C3" stroke="#0B1F3A" stroke-width="2"/>
    <g class="eyes" fill="none" stroke="#0B1F3A" stroke-width="2" stroke-linecap="round"><path d="M58 56 q4 4 8 0"/><path d="M74 56 q4 4 8 0"/></g>
    <path d="M68 63 l2 3 l2 -3 z" fill="#0B1F3A"/><path d="M70 66 q-3 4 -6 2 M70 66 q3 4 6 2" fill="none" stroke="#0B1F3A" stroke-width="1.5" stroke-linecap="round"/>
    <g stroke="#0B1F3A" stroke-width="1.2" stroke-linecap="round"><path d="M50 62 h-12 M51 66 h-11 M50 70 h-10"/><path d="M90 62 h12 M89 66 h11 M90 70 h10"/></g>
    <g fill="none" stroke="#4A5A70" stroke-width="2" stroke-linecap="round"><path class="sigh" d="M46 50 h-7"/><path class="sigh" d="M44 46 h-6"/><path class="sigh" d="M46 54 h-5"/></g>
  </svg>`;

  // ---- the moments ----------------------------------------------------------------------------------
  const render = {
    applied({ job, counts }) {
      showBoard(lines("NOW BOARDING", "APPLIED", company(job)), "Applied", L.words.appliedWords(job, counts), 5200);
      pop("Applied");
    },
    done({ job }) {
      showBoard(innerWidth < 900 ? ["ARRIVED", "DONE"] : ["ARRIVED   DONE"], "Done", L.words.doneWords(job), 3600);
      pop("Done");
    },
    denied({ job, counts }) {
      const n = counts.inPlay || 0;
      L.catCard({ svg: CAT, cls: "transit",
        lead: `Service suspended at ${L.words.who(job)}.`,
        rest: n ? ` The cat is sad too. ${n} ${n === 1 ? "train" : "trains"} still running.` : " The cat is sad too. Time to find more routes." });
    },
  };

  L.register({
    id: "transit", name: "Transit", blurb: "The pipeline as a transit line. A split-flap board when you apply.",
    swatches: ["#EEF3F8", "#0B1F3A", "#DDAA00", "#F4520A", "#00A862", "#0066CC"],
    confetti: ["#DDAA00", "#F4520A", "#00A862", "#0066CC", "#FFFFFF"],
    cat: CAT, render,
  });
})();
