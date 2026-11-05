/**
 * @file live-result MCP App — the card Claude and ChatGPT render after a plug
 * (cloudgrid-io/mcp#434).
 *
 * One widget for both hosts: it speaks the MCP Apps bridge (SEP-1865,
 * postMessage JSON-RPC) through the official `App` class, which Claude and
 * ChatGPT both implement. `window.openai` is used only as a fallback for a
 * capability a host may not expose over the standard bridge (opening a link,
 * adding a follow-up message).
 *
 * The card shows the app URL with Open, Copy link, Update and visibility. A
 * live preview frame is a progressive enhancement: it appears only when the
 * server hands the card a preview URL in the result `_meta` (MCP_PREVIEW_ORIGIN
 * set), and the resource CSP then admits that one origin as a frame source.
 *
 * Bundled into a single self-contained src/widgets/live-result.html by
 * scripts/build-widgets.mjs. The iframe CSP is deny-by-default, so nothing here
 * may reference a remote script, stylesheet, or font.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import {
  readResult,
  headline,
  showPreview,
  updateMessage,
  visibilityArgs,
  visibilityPills,
  checkDeployArgs,
  applyCheckDeploy,
} from "./view.js";

const $ = (id) => document.getElementById(id);
const els = {
  card: $("card"),
  headline: $("headline"),
  badge: $("badge"),
  preview: $("preview"),
  frame: $("preview-frame"),
  url: $("url"),
  open: $("open"),
  copy: $("copy"),
  update: $("update"),
  check: $("check"),
  form: $("update-form"),
  text: $("update-text"),
  cancel: $("update-cancel"),
  visibility: $("visibility"),
  pills: $("pills"),
  status: $("status"),
};

let model = null;

function setStatus(text) {
  els.status.textContent = text || "";
}

function render() {
  if (!model) {
    els.card.hidden = true;
    return;
  }
  els.card.hidden = false;
  els.headline.textContent = headline(model);
  els.badge.hidden = model.status !== "building";
  els.badge.textContent = model.status === "building" ? "Not live yet" : "";
  els.url.textContent = model.url;
  els.url.setAttribute("href", model.url);
  els.check.hidden = model.status !== "building";

  if (showPreview(model)) {
    if (els.frame.getAttribute("src") !== model.previewUrl) els.frame.setAttribute("src", model.previewUrl);
    els.preview.hidden = false;
  } else {
    els.preview.hidden = true;
  }

  const pills = visibilityPills(model);
  els.visibility.hidden = !(pills.length && model.entityId);
  els.pills.replaceChildren(
    ...pills.map((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.textContent = opt.label;
      b.dataset.value = opt.value;
      b.setAttribute("aria-pressed", String(opt.pressed));
      b.addEventListener("click", () => setVisibility(opt.value));
      return b;
    }),
  );
}

async function openUrl(url) {
  try {
    const res = await app.openLink({ url });
    if (!res?.isError) return;
  } catch {
    /* fall through to the Apps SDK alias */
  }
  if (window.openai?.openExternal) {
    window.openai.openExternal({ href: url });
    return;
  }
  setStatus("Open the link above in your browser.");
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(model.url);
    setStatus("Link copied.");
    return;
  } catch {
    /* clipboard API blocked in this frame: try a selection copy */
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(els.url);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand("copy");
    setStatus(ok ? "Link copied." : "Select the link above and copy it.");
  } catch {
    setStatus("Select the link above and copy it.");
  }
}

async function setVisibility(value) {
  if (!model || value === model.visibility) return;
  const pills = [...els.pills.querySelectorAll("button")];
  pills.forEach((p) => (p.disabled = true));
  setStatus("Updating who can open it.");
  try {
    const res = await app.callServerTool({ name: "grid_visibility", arguments: visibilityArgs(model, value) });
    if (res?.isError) {
      const msg = res.content?.find((c) => c?.type === "text")?.text;
      setStatus(msg ? `Could not change it: ${msg}` : "Could not change who can open it.");
    } else {
      model = { ...model, visibility: value };
      render();
      const label = model.visibilityOptions.find((o) => o.value === value)?.label ?? value;
      setStatus(`Now: ${label}.`);
      try {
        await app.updateModelContext({
          content: [{ type: "text", text: `The user set who can open ${model.url} to "${value}" (${label}) from the app card.` }],
        });
      } catch {
        /* the change is applied; the model hears about it on its next read */
      }
    }
  } catch {
    setStatus("Could not change who can open it.");
  } finally {
    pills.forEach((p) => (p.disabled = false));
  }
}

async function sendUpdate(request) {
  const text = updateMessage(model, request);
  try {
    const res = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    if (!res?.isError) {
      els.form.hidden = true;
      els.text.value = "";
      setStatus("Sent. The update will re-plug the same link.");
      return;
    }
  } catch {
    /* fall through to the Apps SDK alias */
  }
  if (window.openai?.sendFollowUpMessage) {
    await window.openai.sendFollowUpMessage({ prompt: text });
    els.form.hidden = true;
    setStatus("Sent. The update will re-plug the same link.");
    return;
  }
  setStatus("Ask in the chat to update it; the link stays the same.");
}

async function checkDeploy() {
  els.check.disabled = true;
  setStatus("Checking the build.");
  try {
    const res = await app.callServerTool({ name: "grid_check_deploy", arguments: checkDeployArgs(model) });
    const next = applyCheckDeploy(model, res);
    model = next.model;
    render();
    setStatus(next.note);
  } catch {
    setStatus("Could not check the build. Try again.");
  } finally {
    els.check.disabled = false;
  }
}

els.open.addEventListener("click", () => model && openUrl(model.url));
els.url.addEventListener("click", (e) => {
  e.preventDefault();
  if (model) openUrl(model.url);
});
els.copy.addEventListener("click", () => model && copyUrl());
els.update.addEventListener("click", () => {
  els.form.hidden = !els.form.hidden;
  if (!els.form.hidden) els.text.focus();
});
els.cancel.addEventListener("click", () => {
  els.form.hidden = true;
});
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (model) sendUpdate(els.text.value);
});
els.check.addEventListener("click", () => model && checkDeploy());

const app = new App({ name: "CloudGrid app", version: "1.0.0" });

app.onerror = (err) => console.error("[live-result card]", err);

app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};

app.ontoolresult = (result) => {
  model = readResult(result);
  setStatus("");
  render();
};

render();
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) app.onhostcontextchanged(ctx);
});
