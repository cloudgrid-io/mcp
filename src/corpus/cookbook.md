# Cookbook

Canonical chains you can run end to end. Each step is one skill. Together they are
the "I built a thing and shipped it" loop.

## Prerequisite

The CLI is installed and you are logged in:

```
npm install -g @cloudgrid-io/cli
grid login
```

## The build-and-ship loop

```
init  ->  plug  ->  logs  ->  share  ->  feedback
```

### 1. Scaffold

Scaffold a new app in the current directory and seed a static web service:

```
grid new my-thing --type static
```

`--type` accepts `node`, `nextjs`, `python`, or `static`; `--dir <path>` targets a
different folder. For an agent, use `grid new my-thing --agent`. Scaffolding is
local-only — the entity is created on the first `grid plug`.

### 2. Deploy

From the project directory, deploy it:

```
grid plug
```

The first plug auto-creates the entity from `cloudgrid.yaml` (honoring its
`name:`) and writes `.cloudgrid/link.json`.
`grid plug` also takes a path or a URL. It builds and deploys, then prints the
live URL. This usually takes about 30 seconds.

### 3. Watch the logs

```
grid logs my-thing --follow
```

Drop `--follow` for a one-time tail. `--since 5m` limits how far back to read.

### 4. Share

Make the entity reachable by anyone with the link. The command prints the URL:

```
grid visibility set my-thing link
```

### 5. Read feedback

```
grid feedback list
```

## Share an artifact with no account

The fastest chain has one step and no login. Drop an HTML file, get a public URL:

```
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -F "artifact=@./index.html;type=text/html"
```

The response includes `url` (the live link — use it verbatim), `entity_id`,
`owner_token` (keep both to update the page later), and `claim_url` (sign in
before it expires to keep it). This is what the `cloudgrid:plug` skill and the
`grid_plug` MCP tool (inline `html` param) do for you. It is anonymous and serves
inspirations only; a full app needs the signed-in `plug` flow above.

## Update your drop in place

Re-plugging with `target_entity_id` updates the SAME entity — same slug, same URL,
new content. Iterate on one link instead of minting a new one per revision:

```
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -F "target_entity_id=$ENTITY_ID" \
  -F "owner_token=$OWNER_TOKEN" \
  -F "artifact=@./index.html;type=text/html"
```

Signed in, drop the `owner_token` field and send your auth headers instead. Each
anonymous edit returns a refreshed `owner_token` (store the new one) and resets
the drop's expiry. Editing an archived or expired drop returns 409
`EDIT_REJECTED`; omit `target_entity_id` when you actually want a fresh link.

## Shorter chains

- **Ship an existing directory:** `plug`
- **Deploy a URL as an inspiration:** `plug https://example.com`
- **Refresh discovery metadata after a change:** `grid brain refresh my-thing --wait`

## Notes

- Every command uses the active org and linked entity when you omit the name. Run
  `grid whoami` to see the active context.
- These skills wrap the CLI. Anything the CLI can do, a skill can drive.
