/**
 * @file Pure view logic for the live-result MCP App (cloudgrid-io/mcp#434).
 *
 * Everything the card decides from a tool result lives here, with no DOM and no
 * ext-apps import, so it can be unit-tested in Node. mcp-app.js wires it to the
 * page and the host bridge. Bundled inline into src/widgets/live-result.html by
 * scripts/build-widgets.mjs.
 */

/** The `_meta` key the server uses to hand the card its preview frame URL. */
export const PREVIEW_META_KEY = "cloudgrid/preview_url";

/** First http(s) URL in the text content: the text-first fallback. */
function urlFromText(result) {
  const text = Array.isArray(result?.content)
    ? result.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
    : "";
  const match = text.match(/https?:\/\/[^\s)]+/);
  return match ? match[0] : null;
}

const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

/**
 * Reduce a grid_plug / grid_hello / grid_check_deploy result to the card's
 * model. Returns null when the result carries no app URL (sign-in, grid
 * picker, confirm asks): the card renders nothing and the text result stands.
 */
export function readResult(result) {
  if (!result || result.isError) return null;
  const s = result.structuredContent || {};
  if (s.needs_auth || s.needs_grid || s.needs_grid_create || s.needs_confirmation) return null;
  const url = isHttpUrl(s.url) ? s.url : urlFromText(result);
  if (!url) return null;
  const building = s.status === "building" || (Boolean(s.poll_url) && s.live !== true);
  const preview = result._meta?.[PREVIEW_META_KEY];
  return {
    url,
    entityId: typeof s.entity_id === "string" ? s.entity_id : null,
    grid: typeof s.grid === "string" ? s.grid : null,
    status: building ? "building" : s.status === "updated" ? "updated" : "live",
    pollUrl: typeof s.poll_url === "string" ? s.poll_url : null,
    consoleUrl: isHttpUrl(s.console_url) ? s.console_url : null,
    visibility: typeof s.current_visibility === "string" ? s.current_visibility : null,
    visibilityOptions: Array.isArray(s.visibility_options)
      ? s.visibility_options.filter((o) => o && typeof o.value === "string" && typeof o.label === "string")
      : [],
    // Only an https preview URL is ever framed. It is kept while building and
    // shown once the build is live (see showPreview).
    previewUrl: typeof preview === "string" && /^https:\/\//i.test(preview) ? preview : null,
  };
}

/** The live preview frame shows only for a live app with a configured preview URL. */
export function showPreview(model) {
  return model.status !== "building" && Boolean(model.previewUrl);
}

/** The card heading for a model. The user-facing verb is plug. */
export function headline(model) {
  if (model.status === "building") return "Plugging";
  if (model.status === "updated") return "Updated";
  return "Live";
}

/**
 * The message the Update action adds to the conversation. The card has no
 * source to re-plug with, so the model does the edit and re-plugs the same
 * entity in place with grid_plug target_entity_id.
 */
export function updateMessage(model, request) {
  const ask = String(request || "").trim();
  const sentence = ask && !/[.!?]$/.test(ask) ? `${ask}.` : ask;
  const what = ask ? `Update my app at ${model.url}: ${sentence}` : `I want to update my app at ${model.url}. Ask me what to change.`;
  const how = model.entityId
    ? ` Re-plug it in place with grid_plug and target_entity_id ${model.entityId}.`
    : " Re-plug it in place so the link stays the same.";
  return what + how;
}

// Labels for a current setting the card does not offer as a choice (#482).
// Mirrors VISIBILITY_LABELS in src/tools/constants.js, which the browser
// bundle cannot import.
const CURRENT_ONLY_LABELS = {
  authenticated: "Anyone with the link, sign-in required",
  space: "Selected spaces",
  public: "Anyone, findable by search",
};

// A stored legacy name for an offered choice.
const CURRENT_ALIASES = { org: "grid" };

/**
 * The "Who can open it" pills: one per offered option, the current one marked
 * pressed (#473). The current value comes only from the result's
 * current_visibility; with none, no pill is marked. A current setting that is
 * not one of the offered choices (a sign-in link, selected spaces, search
 * findable) gets its own pressed pill, so the card always shows what is set
 * now (#482).
 */
export function visibilityPills(model) {
  const current = CURRENT_ALIASES[model.visibility] ?? model.visibility;
  const pills = model.visibilityOptions.map((o) => ({ value: o.value, label: o.label, pressed: o.value === current }));
  if (pills.length && current && !pills.some((p) => p.pressed) && CURRENT_ONLY_LABELS[current]) {
    pills.unshift({ value: current, label: CURRENT_ONLY_LABELS[current], pressed: true });
  }
  return pills;
}

/** The line under "Who can open it": the current setting, or that it is not confirmed. */
export function visibilityNote(model) {
  const now = visibilityPills(model).find((p) => p.pressed);
  return now ? `Now: ${now.label}.` : "Current setting not confirmed. Pick one to set it.";
}

/** grid_visibility arguments for a choice, scoped to this card's entity (#489). */
export function visibilityArgs(model, value) {
  return {
    visibility: value,
    ...(model.entityId ? { entity_id: model.entityId } : { url: model.url }),
    ...(model.grid ? { grid: model.grid } : {}),
  };
}

/**
 * grid_check_deploy arguments for a building card. The entity id and URL ride
 * on every call: ChatGPT opens a new server session for each tool call, so the
 * server cannot fall back to the plug it made earlier (#489).
 */
export function checkDeployArgs(model) {
  return {
    ...(model.entityId ? { entity_id: model.entityId } : {}),
    ...(model.entityId ? {} : { url: model.url }),
    ...(model.pollUrl ? { poll_url: model.pollUrl } : {}),
    ...(model.grid ? { grid: model.grid } : {}),
  };
}

/** Fold a grid_check_deploy result into the model. */
export function applyCheckDeploy(model, result) {
  const s = result?.structuredContent || {};
  if (result?.isError) return { model, note: "Could not check the status. Try again." };
  if (s.live === true || s.status === "success") {
    return {
      model: {
        ...model,
        status: "live",
        url: isHttpUrl(s.url) ? s.url : model.url,
        consoleUrl: isHttpUrl(s.console_url) ? s.console_url : model.consoleUrl,
      },
      note: "",
    };
  }
  if (s.status === "failed") {
    return { model, note: typeof s.error === "string" && s.error ? `Plugging failed: ${s.error}` : "Plugging failed." };
  }
  return { model, note: "Still plugging. Check again in a few seconds." };
}
