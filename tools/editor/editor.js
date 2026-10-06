// The impact record's and interview prep's editor: Milkdown (ProseMirror + remark), a Typora-style WYSIWYG markdown editor.
// Build with `npm install && npm run build` here; the app serves the bundle from static/vendor/editor.js.
//
// Saving keeps the file's own formatting: every top-level block (paragraph, list, table, heading) that
// wasn't edited is written back exactly as it was in the source text, and only edited or new blocks
// are serialized by the editor. Without this, saving one word would restyle the whole file.
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, remarkCtx, serializerCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { indent } from "@milkdown/kit/plugin/indent";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { replaceAll, $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";

// Edited blocks are written the way the skill's files are written.
const STYLE = { bullet: "-", emphasis: "*", strong: "*", rule: "-", fence: "`", listItemIndent: "one" };

// Task items (- [ ] / - [x]) get a checkbox, drawn by app.css in the item's left margin. Clicking it
// ticks or unticks the item. Typing "[ ] " at the start of a list item makes it a task.
const TASK_BOX = 26;   // px from the item's left edge that count as the checkbox
const taskToggle = $prose(() => new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const li = event.target;
        if (!(li instanceof HTMLElement) || !li.matches('li[data-item-type="task"]')) return false;
        if (event.clientX - li.getBoundingClientRect().left > TASK_BOX) return false;
        const pos = view.posAtDOM(li, 0) - 1;
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.attrs.checked == null) return false;
        event.preventDefault();
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
        return true;
      },
    },
  },
}));

// The source text of each top-level block, matched to the editor's top-level nodes.
// Null when they don't line up one-to-one (then the whole document is serialized).
function sourceBlocks(ctx, markdown, doc) {
  const children = ctx.get(remarkCtx).parse(markdown).children;
  const nodes = [];
  doc.forEach((n) => nodes.push(n));
  // The trailing plugin may add an empty paragraph after a final table or list.
  while (nodes.length > children.length && nodes.at(-1).type.name === "paragraph" && !nodes.at(-1).content.size) nodes.pop();
  if (nodes.length !== children.length || children.some((c) => !c.position)) return null;
  return {
    prefix: markdown.slice(0, children.length ? children[0].position.start.offset : markdown.length),
    blocks: nodes.map((node, i) => ({
      node,
      text: markdown.slice(children[i].position.start.offset,
                           i + 1 < children.length ? children[i + 1].position.start.offset : markdown.length),
    })),
  };
}

async function create(root, markdown, { onChange } = {}) {
  let blocks = null;
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, ...STYLE }));
      ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
      if (onChange) ctx.get(listenerCtx).markdownUpdated(() => onChange());
    })
    .use(commonmark).use(gfm).use(history).use(listener).use(clipboard).use(indent).use(trailing).use(cursor).use(taskToggle)
    .create();
  const ctx = editor.ctx;
  // md is the text the editor's current document came from (after a save, or edits in the source view):
  // its blocks become the originals. If they don't line up, the previous originals stay in use.
  const rebase = (md) => {
    const b = sourceBlocks(ctx, md, ctx.get(editorViewCtx).state.doc);
    if (b) blocks = b;
    return !!b;
  };
  rebase(markdown);

  const serializeNode = (node) => {
    const schema = node.type.schema;
    return ctx.get(serializerCtx)(schema.topNodeType.create(null, [node])).replace(/\s+$/, "");
  };

  function getMarkdown() {
    const doc = ctx.get(editorViewCtx).state.doc;
    if (!blocks) return ctx.get(serializerCtx)(doc);
    let out = blocks.prefix, next = 0, last = -1;   // last: index of the source block written just before
    const add = (text, k) => {
      if (k < 0 && !text) return;                         // an empty paragraph writes nothing
      // Two source blocks that were neighbours keep the text between them; anything else gets a blank line.
      if (out && !(k >= 0 && k === last + 1) && !out.endsWith("\n\n")) out = out.replace(/\n*$/, "\n\n");
      out += text;
      last = k;
    };
    doc.forEach((node) => {
      // An unedited block is the same node as at load (or an equal one, after undo): reuse its source text.
      let k = -1;
      for (let i = next; i < Math.min(blocks.blocks.length, next + 200); i++) {
        if (blocks.blocks[i].node.eq(node)) { k = i; break; }
      }
      if (k >= 0) next = k + 1;
      add(k >= 0 ? blocks.blocks[k].text : serializeNode(node), k);
    });
    // The file ends as it did, unless an edited block is now last.
    return last === blocks.blocks.length - 1 ? out : out.replace(/\s*$/, "\n");
  }

  return {
    getMarkdown,
    exact: () => !!blocks,                                // false: a save re-serializes the whole file
    setMarkdown: (md) => editor.action(replaceAll(md)),   // e.g. after editing the source text
    rebase,
    focus: () => ctx.get(editorViewCtx).focus(),
    destroy: () => editor.destroy(),
  };
}

window.MarkdownEditor = { create };
