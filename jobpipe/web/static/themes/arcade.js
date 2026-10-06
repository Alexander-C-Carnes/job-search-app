// Arcade: a daylight 8-bit HUD. A sent application slams in an "APPLICATION SENT!" panel, rolls a
// counter to +100 XP and bursts square confetti from the Applied segment; a finished role gets a short
// "QUEST COMPLETE"; a rejection brings a fat pixel cat on a continue screen. The panels are styled in
// themes/arcade.css (.px-burst); the cat is SVG rects drawn from the maps below.
"use strict";
(() => {
  const L = window.Look;
  if (!L) return;
  const { h, RM, words } = L;
  const INK = "#1B1B4D";

  // ---- pixel art: a map of characters becomes runs of rects ------------------------------------------
  function rects(map, cell, colors, ox = 0, oy = 0) {
    let out = "";
    map.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = colors[row[x]];
        if (!c) continue;
        let w = 1;
        while (row[x + w] === row[x]) w++;
        out += `<rect x="${(ox + x) * cell}" y="${(oy + y) * cell}" width="${w * cell}" height="${cell}" fill="${c}"/>`;
        x += w - 1;
      }
    });
    return out;
  }

  // The sad fat cat: a wide loaf of a body, a small head, half-closed eyes, a frown. Its ears start up and
  // flop down; the tail flicks between two frames.
  const COLORS = { "#": INK, o: "#FFA552", s: "#D96A12", c: "#FFE7C2", n: "#FF2D95" };
  const BODY = [
    ".............................",
    ".............................",
    ".............................",
    "...########..................",
    "..#oooooooo#.................",
    ".#oooooooooo#................",
    ".#oooooooooo#................",
    ".#o###oo###o#................",
    ".#oo#onno#oo#................",
    ".#oooo##oooo#................",
    ".#ooo#oo#ooo#................",
    "..#ooooooo#################..",
    ".#oooooooooooooooooooooooooo#",
    "#oooosoooooooooooooooooosooo#",
    "#oooosooooccccccccccooooosoo#",
    "#ooooooooccccccccccccoooooo#.",
    "#ooosoooocccccccccccoooosooo#",
    "#oooooooooccccccccccoooooooo#",
    ".#ooooooooooccccccoooooooo#..",
    "..##oooo##oooooooooo##oooo#..",
    "....####....######....####...",
  ];
  const EARS_UP = ["....#......#..", "...#o#....#o#.", "..#ooo#..#ooo#", "..##........##"];
  const EARS_DOWN = ["", "", "", "...##........##...", ".##oo........oo##.", "#ooo..........ooo#", ".##............##."];
  const TAIL_A = ["....###", "...#ooo#", "..#oo#.#", "..#o#...", ".#oo#...", "#oo#...."];
  const TAIL_B = ["", "", "", "", ".#####..", "#ooooo#.", "#o###oo#", "##...##."];
  const CELL = 5, W = 38, H = 22;
  const CAT = `<svg class="cat-px" viewBox="0 0 ${W * CELL} ${H * CELL}" width="${W * CELL}" height="${H * CELL}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
    <g class="body">${rects(BODY, CELL, COLORS, 2, 1)}</g>
    <g class="ears-up">${rects(EARS_UP, CELL, COLORS, 1, 1)}</g>
    <g class="ears-down">${rects(EARS_DOWN, CELL, COLORS, 0, 0)}</g>
    <g class="tail-a">${rects(TAIL_A, CELL, COLORS, 29, 6)}</g>
    <g class="tail-b">${rects(TAIL_B, CELL, COLORS, 29, 6)}</g></svg>`;
  const catArt = (still) => CAT.replace('class="cat-px"', `class="cat-px ${still ? "still" : "anim"}"`) + '<span class="px-bubble" aria-hidden="true">...</span>';

  // ---- the burst panel ------------------------------------------------------------------------------
  let burst = null, timer = null;
  function close() {
    clearTimeout(timer);
    const b = burst; burst = null;
    if (!b) return;
    if (RM()) { b.remove(); return; }
    b.classList.add("leaving");
    setTimeout(() => b.remove(), 300);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  // Switching to another look mid-moment takes the panel with it (its styles belong to this look).
  new MutationObserver(() => { if (document.documentElement.dataset.theme !== "arcade") close(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  function panel(kind, title, xp, msg, sub, ms) {
    close();
    L.hideAll();
    const still = RM();
    const score = h("span", {}, still ? String(xp) : "0");
    const b = h("div", { class: `px-burst ${kind}${still ? " said" : ""}`, role: "status", onclick: close },
      h("div", { class: "px-burst-card" },
        h("div", { class: "px-burst-title" }, title),
        h("div", { class: "px-burst-score" }, "+", score, " XP"),
        h("p", { class: "px-burst-msg" }, msg),
        sub ? h("p", { class: "px-burst-sub" }, sub) : null));
    document.body.append(b);
    burst = b;
    if (!still) {
      const t0 = performance.now(), dur = 700;
      const step = (now) => {
        if (burst !== b) return;
        const k = Math.min(1, (now - t0) / dur);
        score.textContent = String(Math.round(xp * k));
        if (k < 1) requestAnimationFrame(step);
        else b.classList.add("said");
      };
      requestAnimationFrame(step);
    }
    timer = setTimeout(close, ms);
  }

  L.register({
    id: "arcade",
    name: "Arcade",
    blurb: "A daylight 8-bit HUD. XP and a burst when you apply.",
    swatches: ["#E9FBFF", "#1B1B4D", "#FF2D95", "#FFD500", "#22D36B", "#16C7F2"],
    confetti: ["#FF2D95", "#FFD500", "#22D36B", "#FF7A00", "#16C7F2", "#1B1B4D"],
    cat: catArt(false),
    render: {
      applied({ job, counts, anchor, theme }) {
        panel("applied", "APPLICATION SENT!", 100, words.appliedWords(job, counts), `Level ${(counts.applied || 0) + 1}. Click anywhere to carry on.`, 4000);
        L.confetti(anchor.x, anchor.y, theme.confetti, { square: true, count: 160 });
      },
      done({ job, theme }) {
        panel("done", "QUEST COMPLETE", 50, words.doneWords(job), null, 2600);
        L.confetti(innerWidth / 2, innerHeight / 2 - 40, theme.confetti, { square: true, count: 60, size: 0.8, spread: 1.2 });
      },
      denied({ job, counts }) {
        close();
        const n = counts.inPlay || 0;
        const rest = n ? ` ${words.who(job)} passed. The cat is sad too. ${n} ${n === 1 ? "role" : "roles"} still in play.`
                       : ` ${words.who(job)} passed. The cat is sad too. Time to find more roles.`;
        L.catCard({ svg: catArt(RM()), lead: "GAME NOT OVER. CONTINUE?", rest, cls: "arcade-cat" });
      },
    },
  });
})();
