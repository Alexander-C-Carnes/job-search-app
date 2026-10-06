// Sorbet's gooey segmented buttons: the dark scoop behind the active button oozes to the one you pick.
// app.js renders segmented controls (.seg) in many places and often rebuilds them, so this watches the page:
// each .seg gets .gooey and a .seg-goo of three blobs (themes/sorbet.css draws them under the #goo filter),
// placed at the active button. A rebuilt control starts its scoop where the old one was, so it still slides.
// Only while Sorbet is the look; switching away takes it all out again. Sorbet itself is registered in theme.js.
"use strict";
(() => {
  const root = document.documentElement;
  const on = () => root.dataset.theme === "sorbet";
  const last = new Map();   // a control's id or label → where its scoop last was {x, w}
  const keyOf = (seg) => seg.id || seg.getAttribute("aria-label") || "";
  // A control that resizes (shown from a hidden tab, counts grown) re-places its scoop without sliding. Observing
  // again fires at once, which would cut a slide short, so each control is observed once and only real changes count.
  const sizes = new WeakMap();
  const resize = new ResizeObserver((entries) => entries.forEach((e) => {
    const w = e.target.clientWidth;
    if (sizes.get(e.target) !== w) { sizes.set(e.target, w); place(e.target, false); }
  }));

  function place(seg, slide = true) {
    let goo = seg.querySelector(":scope > .seg-goo");
    const fresh = !goo;
    if (fresh) {
      goo = document.createElement("span");
      goo.className = "seg-goo";
      goo.setAttribute("aria-hidden", "true");
      goo.innerHTML = '<i class="g1"></i><i class="g2"></i><i class="g3"></i>';
      seg.prepend(goo);
      seg.classList.add("gooey");
      if (!sizes.has(seg)) { sizes.set(seg, seg.clientWidth); resize.observe(seg); }
    }
    const a = seg.querySelector(":scope > button.active, :scope > button[aria-pressed='true']");
    goo.classList.toggle("none", !a);
    if (!a || !a.offsetWidth) return;   // hidden (another tab): placed when it shows, by the ResizeObserver
    const to = { x: a.offsetLeft, w: a.offsetWidth }, key = keyOf(seg), from = last.get(key);
    const set = (p) => { goo.style.setProperty("--x", `${p.x}px`); goo.style.setProperty("--w", `${p.w}px`); };
    if (fresh && from && slide) { goo.classList.add("snap"); set(from); goo.offsetWidth; goo.classList.remove("snap"); }
    else if (fresh || !slide) { goo.classList.add("snap"); set(to); goo.offsetWidth; goo.classList.remove("snap"); }
    set(to);
    last.set(key, to);
  }
  function sync() { if (on()) document.querySelectorAll(".seg").forEach((s) => place(s)); }
  function strip() {
    document.querySelectorAll(".seg-goo").forEach((g) => g.remove());
    document.querySelectorAll(".seg.gooey").forEach((s) => { s.classList.remove("gooey"); resize.unobserve(s); sizes.delete(s); });
  }

  // One pass per burst of DOM changes (observer callbacks already batch a render's changes); skip the ones this file makes.
  const ours = (m) => m.target.classList?.contains("seg-goo") || m.target.closest?.(".seg-goo")
    || (m.type === "childList" && [...m.addedNodes, ...m.removedNodes].every((n) => n.classList?.contains("seg-goo")))
    || (m.type === "attributes" && m.target.classList?.contains("seg"));
  new MutationObserver((muts) => {
    if (on() && !muts.every(ours)) sync();
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-pressed"] });
  new MutationObserver(() => (on() ? sync() : strip())).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  document.fonts?.ready.then(() => document.querySelectorAll(".seg.gooey").forEach((s) => place(s, false)));
  sync();
})();
