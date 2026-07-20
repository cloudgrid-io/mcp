// Boot-time staleness self-check for the LOCAL edition.
//
// The .mcpb Desktop extension is a frozen snapshot: it never auto-updates, so
// an installed bundle silently rots (a pre-0.20.17 bundle crashed on boot for a
// week; stale installs pinned old CLIs that the API rejects). The hosted
// edition auto-updates on cutover and never needs this.
//
// The check is strictly best-effort: one fetch to the npm registry with a short
// timeout, fire-and-forget at boot. Offline, slow, or erroring → null, silently.
// The result is surfaced in TWO places: stderr (Desktop MCP logs) and the
// grid_start live context, where the model can relay it to the user in-session
// — turning silent rot into a one-line user action.

const REGISTRY_LATEST_URL = "https://registry.npmjs.org/@cloudgrid-io/mcp/latest";
const CHECK_TIMEOUT_MS = 2500;

// Compare two semver strings (no prerelease handling — releases are plain
// X.Y.Z). Returns -1 / 0 / 1 for a < b / a == b / a > b; null if unparsable.
export function compareSemver(a, b) {
  const pa = String(a ?? "").split(".").map((n) => Number.parseInt(n, 10));
  const pb = String(b ?? "").split(".").map((n) => Number.parseInt(n, 10));
  if (pa.length !== 3 || pb.length !== 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * One best-effort registry check. Resolves { current, latest, behind } when the
 * registry answered and `current` is older than `latest`; resolves null in every
 * other case (up to date, ahead, offline, timeout, bad payload). Never throws.
 */
export async function checkForNewerVersion(current, { fetchImpl = fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(REGISTRY_LATEST_URL, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res?.ok) return null;
    const data = await res.json();
    const latest = data?.version;
    if (typeof latest !== "string") return null;
    if (compareSemver(current, latest) === -1) {
      return { current, latest, behind: true };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The one-line, model-relayable note grid_start appends when the local MCP is
 * stale. Kept short and §23-plain; names the .mcpb non-auto-update property so
 * the model explains WHY a reinstall is needed.
 */
export function stalenessNote(staleness) {
  if (!staleness?.behind) return null;
  return (
    `Note: this local CloudGrid MCP is v${staleness.current}; the latest is v${staleness.latest}. ` +
    `If it is installed as the Claude Desktop extension (.mcpb), it never auto-updates — ` +
    `tell the user to reinstall the latest cloudgrid.mcpb from https://github.com/cloudgrid-io/mcp/releases/latest ` +
    `(npx installs pick up the latest on their next cold start).`
  );
}
