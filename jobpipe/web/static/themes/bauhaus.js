// Bauhaus: flat colour fields and big black type. The moments are fields, not particles: a green wipe
// across the whole screen when a role is applied to, a blue field from the right when one is done, and a
// geometric cat on a blue field when one is denied. Styles live in themes/bauhaus.css (.bh-*); the DOM is
// built here and removed when each moment ends. With reduced motion the fields fade, the words appear in
// place, and the cat sits still.
"use strict";
(() => {
  const { h, RM, banner, catCard, words } = window.Look;
  const EASE_IN = "cubic-bezier(.7,0,.2,1)", EASE_OUT = "cubic-bezier(.2,.8,.2,1)";

  // The sad fat cat in the poster manner: circles, a half-circle of ground, triangles for the ears.
  const CAT = `<svg class="cat cat-bauhaus" viewBox="0 0 160 124" role="img" aria-label="A fat pink cat, eyes closed, ears down">
    <path d="M6 124 A74 74 0 0 1 154 124 Z" fill="#FFFFFF"/>
    <path class="tail" d="M130 104 C 156 100, 162 76, 148 62" fill="none" stroke="#FF77B7" stroke-width="11"/>
    <circle class="body" cx="98" cy="84" r="40" fill="#FF77B7"/>
    <polygon points="19,40 31,28 6,31" fill="#FF77B7"/>
    <polygon points="65,40 53,28 78,31" fill="#FF77B7"/>
    <circle cx="42" cy="52" r="26" fill="#FF77B7"/>
    <line x1="29" y1="52" x2="39" y2="52" stroke="#000000" stroke-width="3"/>
    <line x1="45" y1="52" x2="55" y2="52" stroke="#000000" stroke-width="3"/>
    <polygon points="39,59 45,59 42,64" fill="#000000"/>
  </svg>`;

  // Where a stage block sits on screen, so a field can collapse into it; the anchor's point when it is off screen.
  function target(stage, anchor) {
    const el = document.querySelector(`#stages .stage[data-stage="${stage}"]`);
    const r = el && el.offsetParent ? el.getBoundingClientRect() : null;
    return r && r.width ? r : { left: anchor.x - 40, top: anchor.y - 20, width: 80, height: 40 };
  }
  const anim = (el, frames, opts) => el.animate(frames, { fill: "forwards", ...opts });
  const finished = (a) => (a.finished || Promise.resolve()).catch(() => {});

  let live = [];                       // the fields on screen now, so a second moment clears the first
  function clear() { live.forEach((el) => el.remove()); live = []; }
  function show(...els) { clear(); live = els; document.body.append(...els); }

  // Applied: a green field wipes across left to right, "APPLIED." slides in and holds, then the field
  // collapses into the Applied block and goes; the banner says what was sent.
  async function applied({ job, counts, anchor }) {
    const wipe = h("div", { class: "bh-wipe", "aria-hidden": "true" });
    const word = h("div", { class: "bh-word", "aria-hidden": "true" }, h("span", {}, "APPLIED."));
    show(wipe, word);
    const span = word.firstChild;
    if (RM()) {
      await finished(anim(wipe, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 }));
      await new Promise((r) => setTimeout(r, 1200));
      await finished(anim(word, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }));
      await finished(anim(wipe, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }));
    } else {
      wipe.style.transform = "scaleX(0)";
      anim(wipe, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 450, easing: EASE_IN });
      anim(span, [{ transform: "translateX(-60px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, delay: 220, easing: EASE_OUT });
      await new Promise((r) => setTimeout(r, 1250));
      anim(span, [{ transform: "none", opacity: 1 }, { transform: "translateX(60px)", opacity: 0 }], { duration: 260, easing: "ease-in" });
      const t = target("Applied", anchor);
      await finished(anim(wipe, [
        { top: "0px", left: "0px", width: `${innerWidth}px`, height: `${innerHeight}px`, transform: "none" },
        { top: `${t.top}px`, left: `${t.left}px`, width: `${t.width}px`, height: `${t.height}px`, transform: "none" },
      ], { duration: 520, delay: 120, easing: "cubic-bezier(.7,0,.25,1)" }));
      await finished(anim(wipe, [{ opacity: 1 }, { opacity: 0 }], { duration: 180 }));
    }
    if (live.includes(wipe)) clear();
    banner(words.appliedWords(job, counts), "applied");
  }

  // Done: a shorter blue field slides in from the right with "DONE." and the role's name, holds, then
  // collapses into the Done block; the banner repeats the words.
  async function done({ job, anchor }) {
    const msg = words.doneWords(job);
    const field = h("div", { class: "bh-done", "aria-hidden": "true" }, h("div", { class: "word" }, "DONE."), h("div", { class: "msg" }, msg));
    show(field);
    if (RM()) {
      await finished(anim(field, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 }));
      await new Promise((r) => setTimeout(r, 1200));
      await finished(anim(field, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }));
    } else {
      anim(field, [{ transform: "translateX(100%)" }, { transform: "none" }], { duration: 380, easing: EASE_OUT });
      anim(field.firstChild, [{ transform: "translateX(40px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, delay: 200, easing: EASE_OUT });
      await new Promise((r) => setTimeout(r, 1150));
      const t = target("Done", anchor), w = field.offsetWidth;
      anim(field.firstChild, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
      anim(field.lastChild, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
      await finished(anim(field, [
        { top: "0px", left: `${innerWidth - w}px`, width: `${w}px`, height: `${innerHeight}px`, transform: "none" },
        { top: `${t.top}px`, left: `${t.left}px`, width: `${t.width}px`, height: `${t.height}px`, transform: "none" },
      ], { duration: 460, easing: "cubic-bezier(.7,0,.25,1)" }));
      await finished(anim(field, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 }));
    }
    if (live.includes(field)) clear();
    banner(msg, "done", 3200);
  }

  // Denied: the cat on its blue field, with the words the brief asks for.
  function denied({ job, counts }) {
    clear();
    const n = counts.inPlay || 0;
    catCard({ svg: CAT, lead: `${words.who(job)}: no.`,
              rest: n ? ` The cat is sad too. ${n} still in play.` : words.deniedWords(job, counts).rest, cls: "bauhaus" });
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") clear(); });

  window.Look.register({
    id: "bauhaus", name: "Bauhaus", blurb: "Flat colour fields and big black type. A green wipe when you apply.",
    swatches: ["#FFFFFF", "#000000", "#FFD400", "#FF4F1F", "#2E6BFF", "#19B36B"],
    confetti: ["#FFD400", "#FF4F1F", "#2E6BFF", "#19B36B", "#000000"],
    cat: CAT,
    render: { applied, done, denied },
  });
})();
