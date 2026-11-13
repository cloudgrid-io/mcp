# ChatGPT plugin package

This folder holds the CloudGrid plugin package for ChatGPT, as uploaded to the
OpenAI plugin portal. ChatGPT connects to the hosted MCP server at
`https://mcp.cloudgrid.io/mcp` and signs in with OAuth (dynamic client
registration).

- `cloudgrid/plugin.json`: the listing (name, descriptions, category, links,
  default prompts) and the review test cases.
- `cloudgrid/mcp.json`: the server the plugin connects to.
- The logo is `assets/cloudgrid-icon-512.png` from the repo root. The build adds
  it to the ZIP as `assets/logo.png`.

## Rebuild and upload

1. Edit `cloudgrid/plugin.json` or `cloudgrid/mcp.json` if the listing changes.
2. Run `npm run test:openai-plugin`.
3. Run `npm run build:openai-plugin`. It writes
   `openai-plugin/dist/cloudgrid-chatgpt-plugin.zip` (gitignored). The
   `version` in the ZIP's `plugin.json` is the version in `package.json`. The
   committed `plugin.json` keeps the last uploaded version.
4. In the portal (platform.openai.com/plugins), open the CloudGrid plugin and
   choose "Upload new version". Upload the ZIP.
5. After the upload, set `version` in the committed `cloudgrid/plugin.json` to
   the version you uploaded.

## Portal constraints

- `tools_triggered` in each review test case is one string, with tool names
  joined by ", ". An array is rejected.
- `category` is exactly `Developer Tools`.
- Every tool named in `tools_triggered` is a tool the hosted server lists.
- The domain verification token is set in the portal and served by the hosted
  server. It is not part of this package.
