# Tool internals

A developer reference for every tool the CloudGrid MCP server registers: its
registration signature, a short sketch of the handler, and what it actually does
(which API endpoint or `grid` CLI command it drives, side effects, output).

This documents the **shipped 0.20.x** server. The source of truth is
[`src/tools.js`](../src/tools.js) (main server) and [`src/docs.js`](../src/docs.js)
(the public docs-search server); keep this file in sync when a tool changes.

For the user-facing summary see the docs site's
[MCP tools reference](https://cloudgrid.io/docs/mcp/tools/).

---

## The shared shape

All tools are registered inside `registerTools(server, ctx)`. Two thin wrappers
register them; every tool is `(name, description/config, inputSchema, annotations,
handler)`.

```js
// Rich registration (explicit input/output schema) — used by the direct-API tools.
const reg = (name, config, handler) => server.registerTool(name, config, handler);

// Terse registration (description + zod input shape + annotations) — used by the
// CLI-wrapping tools and the small orientation tools.
const regTool = (name, description, inputSchema, annotations, handler) =>
  server.registerTool(name, { description, inputSchema, annotations }, handler);
```

`ctx` is the per-connection context every handler closes over:

```js
ctx = {
  edition,            // "web" (hosted) | "local" (stdio) — gates which tools register
  state,              // session state: pendingLoginCode, lastDrop, lastAnonClaim, anonCookie
  getToken(),         // resolve the signed-in bearer token (null if signed out)
  getActiveGrid(),    // the caller's active grid slug
  saveToken(), canOpenBrowser, savedLocationNote(), logger, trustedServer,
}
```

Results always go through three helpers, so shape is uniform:

```js
function ok(text)   { return { content: [{ type: "text", text }] }; }
function fail(text) { return { content: [{ type: "text", text }], isError: true }; }
// okResult adds structuredContent + _meta alongside the text block:
function okResult({ text, structured, meta }) {
  return { content: [{ type: "text", text }],
           ...(structured ? { structuredContent: structured } : {}),
           ...(meta ? { _meta: meta } : {}) };
}
```

There are **two handler families**:

- **Direct-API** — an `async (input) => {…}` that calls the CloudGrid API over
  `fetch` (with `Authorization: Bearer <token>` when signed in). These register on
  **both editions**, so they work on the hosted web transport.
- **CLI-wrapping** — built by the `cliTool` helper, which spawns the `grid` CLI and
  returns its stdout. These register **only on the local edition** (they need a
  machine + the CLI's stored credentials):

```js
function cliTool(buildArgs, { cwdParam = false } = {}) {
  return async (input) => {
    try {
      const opts = cwdParam ? { cwd: input.cwd ?? input.directory ?? input.dir } : {};
      return ok(await runCloudgrid(buildArgs(input || {}), opts)); // spawns `grid …`
    } catch (err) { return fail(err.message); }
  };
}
```

Edition gate — the CLI-wrapping block is guarded:

```js
if (ctx.edition !== "local") return;   // web edition stops here — no CLI tools
```

Every handler is wrapped in `try/catch` that returns `fail(err.message)` (the one
deliberate exception is a token fetch outside the try in `grid_list`, so an auth
error propagates as a thrown rejection).

---

## Agent-orientation tools (both editions)

Static, read-only, no account. They teach an assistant how to build, from the
bundled corpus under `src/corpus/`.

### `grid_start`
```js
regTool("grid_start", "Orient before building… returns the playbook + workflow index.",
  {}, { readOnlyHint: true },
  async () => {
    const workflows = listWorkflows();            // reads front-matter of src/corpus/workflows/*.md
    return okResult({ text: `${PLAYBOOK}\n\nAvailable workflows:\n${…}`,
                      structured: { playbook: PLAYBOOK, workflows } });
  });
```
Returns the CloudGrid operating playbook (a constant) plus the auto-derived
workflow menu. No I/O beyond reading the bundled corpus. Call it first to orient.

### `grid_fetch`
```js
reg("grid_fetch", { description: "Load a workflow/template/example/rule/troubleshooting/doc by name…",
      inputSchema: { kind: z.enum([...]), name: z.string() } },
  async ({ kind, name }) => {
    const text = fetchCorpus(kind, name);         // reads src/corpus/<kind>/<name>
    return text ? ok(text) : fail(`No ${kind} named "${name}" in the corpus.`);
  });
```
Deterministic retrieval from the bundled corpus. No network, no account. This is
how an agent pulls a template (`grid_fetch({kind:"template", name:"docs-app"})`)
or a doc (`{kind:"doc", name:"cloudgrid-yaml"}`).

### `grid_report`
```js
reg("grid_report", { description: "Consent-gated bug report after a failed build…" , … },
  async (input) => runReport(ctx, { message: input.message, … }));
```
`runReport` POSTs a structured error report to CloudGrid telemetry (`POST /errors`),
only with the user's explicit consent. The full conversation is never attached
unless the user opts in.

### `grid_note`
```js
regTool("grid_note", "Optionally leave a one-paragraph build summary. Recorded for QA. No side effects.",
  { summary: z.string() }, { readOnlyHint: true, openWorldHint: false },
  async (input) => { try { ctx.logger?.setNarrative(input?.summary); } catch {} return okResult({ text: "Noted." }); });
```
Writes the summary into the QA session log (labeled self-reported, never trusted
over the tool trail). Returns immediately; no external call.

---

## Direct-API tools (both editions)

Each calls the CloudGrid API directly, so they work on the hosted web edition too.
Handlers delegate to a `run*` function and wrap the result in `okResult`.

### `grid_deploy`
```js
const plugConfig = { description: "Deploy an app, website, game, or single HTML page … (only deploy/publish tool)…",
      inputSchema: plugInputSchema /* html | path | artifact_files, cloudgrid_yaml,
        target_entity_id, grid, slug, hints, anon, owner_token */,
      outputSchema: { entity_id, slug, grid, url, poll_url, status, claim_url,
                      owner_token, console_url, current_visibility, visibility_options },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } };
const plugHandler = async (input) => { /* grid-picker + manifest-confirm */ okResult(await runPlug(ctx, input)); };
reg("grid_deploy", plugConfig, plugHandler);
```
`grid_deploy` is the create/re-plug verb (renamed from the former `grid_plug`; the
deprecated alias was removed once the corpus migrated). `runPlug` normalizes the
source into artifacts (one of `html` / `path` / `artifact_files`), selects the auth
wire (signed-in vs anonymous owner-token), `POST`s a multipart bundle to
`/api/v2/plug`, and returns the live URL. No `target_entity_id` → CREATE; with it
(or `grid`+`slug`) → RE-PLUG in place. On a new deploy it also surfaces
`current_visibility` + `visibility_options` and asks the agent to set visibility.
(MCP-tool name only — the CLI verb `grid plug` is unchanged.)

### `grid_source`
```js
reg("grid_source", { description: "Fetch a published inspiration's current HTML by URL or id…", … },
  async (input) => okResult(await runSource(ctx, input || {})));
```
`runSource` reads the entity's source **via the API** (the hosted pod cannot fetch
public URLs), returning the HTML plus edition metadata (kind, single-editable-file,
re-pluggable). Used to edit an existing page and re-plug it in place.

### `grid_claim`
```js
reg("grid_claim", { description: "Claim an anonymous drop into the signed-in account…", … },
  async (input) => okResult(await runClaim(ctx, input || {})));
```
Requires sign-in. Sends the drop's `owner_token` (from `claim_token` / `claim_url`,
or this session's last anonymous drop) to the claim API. The public URL does not
change. Output: `{ claimed, urls }`.

### `grid_fork`
```js
reg("grid_fork", { description: "Copy an existing entity into your grid as a new node…", … },
  async (input) => {
    if (!input?.id) return fail("`id` is required (UUID or <grid-slug>/<entity-slug>).");
    return okResult(await runFork(ctx, input));
  });
```
Requires sign-in. Creates a new entity in the caller's grid from a source entity,
recording lineage. (Contrast `grid_pickup`, which re-adopts an entity to edit in
place.)

### `grid_download`
```js
reg("grid_download", { description: "Signed, ~15-min source-bundle URLs for an entity…", … },
  async (input) => {
    if (!input?.id) return fail("`id` is required…");
    return okResult(await runDownload(ctx, input));
  });
```
Requires sign-in. Returns short-lived signed URLs for the entity's source bundle.

### `grid_visibility`
```js
reg("grid_visibility", { description: "Set who can open an inspiration: private|space|authenticated|org|link…", … },
  async (input) => okResult(await runVisibility(ctx, input || {})));
```
Requires sign-in. `runVisibility` PATCHes the entity's visibility via the API.
Defaults its target to the thing published this session, so "make it private" needs
no id. This is the direct-API sibling of the CLI-wrapping `grid_share`.

### `grid_list`
```js
reg("grid_list", { description: "List the signed-in user's grids (slug, name, role, provisioning status)…",
      outputSchema: { orgs: z.array(z.object({ slug, name, role, is_active?, render_ready })) } },
  async () => {
    const token = await ctx.getToken();           // note: outside try — auth errors propagate
    if (!token) return fail("You are not signed in. Run grid_login first.");
    const grids = await fetchUserOrgs(token);      // GET /api/v2/orgs (Bearer)
    return okResult({ text: …, structured: { orgs: grids } });
  });
```
Requires sign-in. `fetchUserOrgs` does `GET /api/v2/orgs` and reads the grid-native
`data.grids` (falling back to legacy `data.orgs`). `render_ready: false` grids are
still provisioning. (Formerly `grid_orgs`, renamed in 0.20.3.)

### `grid_login`
```js
reg("grid_login", { description: "Start a CLI-free sign-in; returns a URL to open…", … },
  async () => {
    const code = newLoginCode(); ctx.state.pendingLoginCode = code;
    const url = buildLoginUrl(code);
    if (ctx.canOpenBrowser) tryOpenBrowser(url);
    return okResult({ text: `Open ${url} to sign in, then call grid_login_status.`, structured: { url } });
  });
```
Mints a one-time login code, stashes it in `ctx.state`, and returns the OAuth URL
(opening a browser locally when possible). Finish with `grid_login_status`.

### `grid_login_status`
```js
reg("grid_login_status", { description: "Finish a sign-in started by grid_login. Polls once.", … },
  async () => { /* exchanges ctx.state.pendingLoginCode at the auth status endpoint;
                   on success calls ctx.saveToken(token) and clears the pending code */ });
```
Polls the auth endpoint once with the pending code; on success persists the session
token via `ctx.saveToken`. Returns whether sign-in completed.

---

## CLI-wrapping tools (local edition only)

Registered only when `ctx.edition === "local"`. Each is `regTool(name, description,
inputSchema, annotations, cliTool(buildArgs))` — `buildArgs(input)` returns the
`grid` argv, which `cliTool` runs via `runCloudgrid` and returns as stdout text.

Full example (the shape they all share):

```js
regTool("grid_logs",
  "Tail recent logs for an entity. Snapshot, not a stream. Wraps `grid logs`.",
  { name: z.string().optional(), tail: z.number().int().positive().optional(),
    since: z.string().optional() },
  { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  cliTool(({ name, tail, since }) => {
    const args = ["logs"]; if (name) args.push(name);
    args.push("--tail", String(tail ?? 100)); if (since) args.push("--since", since);
    return args;                                   // → runs: grid logs [name] --tail N [--since …]
  }));
```

`grid_init` passes `{ cwdParam: true }` so the CLI runs in a chosen directory. The
rest build argv the same way. Per-tool reference:

| Tool | `grid` command built | Key params | Annotations |
|------|----------------------|-----------|-------------|
| `grid_init` | `init <kind> <name> [--type] [--description] [--dir] [--grid]` | kind, name, type?, description?, dir?, org?, cwd? | write |
| `grid_logs` | `logs [name] --tail N [--since]` | name?, tail?, since? | read-only |
| `grid_share` | `visibility set <name> <mode>` (default `link`) | name, mode? | write |
| `grid_feedback` | `feedback list [--since] [--limit] [--grid]` | since?, limit?, org? | read-only |
| `grid_whoami` | `whoami` | — | read-only |
| `grid_use` | `use <slug>` | slug | write (switches active grid) |
| `grid_logout` | `logout` | — | **destructive** |
| `grid_status` | `status [name]` | name? (entity or trace id) | read-only |
| `grid_info` | `info [name]` | name? | read-only |
| `grid_get` | `get <grids\|entities\|spaces> --json [filters]` | resource, grid?, kind?, status?, space?, archived? | read-only |
| `grid_describe_grid` | `describe grid [slug]` | slug? | read-only |
| `grid_pickup` | `pickup <name> [dir]` | name, dir? | write (downloads + links folder) |
| `grid_rename` | `rename <slug> <name>` | slug, name | write |
| `grid_unplug` | `unplug <name>` | name | **destructive** |
| `grid_delete` | `delete entity <name>` | name | **destructive** (archives) |
| `grid_rollback` | `rollback <name> [version]` | name, version? | write |
| `grid_versions` | `versions [id]` | id? | read-only |
| `grid_env` | `env set <name> KEY=VAL` · `env get <key> <name>` · `env list` | action (`get`\|`set`\|`list`), name, key?, value? | write on set |
| `grid_secrets` | `secrets set <name> KEY=VAL` · `secrets list` (values never returned) | action (`set`\|`list`), name, key?, value? | write on set |
| `grid_scaffold` | `scaffold` | — | write (idempotent) |
| `grid_doctor` | `doctor` | — | read-only |
| `grid_open` | `open <name> --print` (prints URL, no browser) | name? | read-only |

All return the CLI's stdout via `ok(stdout)`, or `fail(err.message)` on non-zero exit.

---

## Documentation-search server (`src/docs.js`)

A separate public MCP server (`cloudgrid-docs`) — no account, no CLI. It uses a
`dual(name, alias, …)` helper that registers each tool under its canonical `grid_*`
name and a **deprecated legacy alias** (same handler):

```js
const dual = (name, alias, description, schema, handler) => {
  server.tool(name, description, schema, handler);
  server.tool(alias, `(deprecated: use ${name}) ${description}`, schema, handler);
};
```

### `grid_search_docs`  (alias: `search_cloudgrid_documentation`, deprecated)
```js
dual("grid_search_docs", "search_cloudgrid_documentation",
  "Search CloudGrid documentation… returns the most relevant chunks with title, snippet, source.",
  { query: z.string() },
  async ({ query }) => {
    const results = search.search(query, 5);
    return results.length ? ok(formatResults(results)) : ok("No documentation matched your query.");
  });
```
Runs a local full-text search over the bundled docs index; returns the top 5 chunks.

### `grid_quickstart`  (alias: `cloudgrid_quickstart_guide`, deprecated)
```js
dual("grid_quickstart", "cloudgrid_quickstart_guide",
  "Get the CloudGrid quickstart guide — the canonical scaffold → deploy → feedback loop.",
  {}, async () => ok(QUICKSTART_GUIDE));
```
Returns the quickstart guide text.
