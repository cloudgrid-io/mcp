"""CloudGrid cron-job entry point (services/refresh/src/main.py).

A `type: cron` service with `run: job` runs this file to completion once per
schedule, then exits — there is NO HTTP server here. It reuses the SAME
incremental indexing pipeline as the manager 'Refresh now' endpoint
(`app.indexing.run_sync`) and connects DIRECTLY to the grid-injected
`DATABASE_MONGODB_URL` (from the app-level `needs: { database: true }`), so it
does not depend on the backend service being reachable over the network.

The backend's `app/` package is VENDORED into this service's own
`services/refresh/src/app/` (config, db, source, embeddings, indexing). Each
CloudGrid service builds from its own folder in an isolated container, so a
cross-folder import of `services/backend/src/app` would not resolve here — the
copy is the CloudGrid-native way to share the logic. See services/refresh/README.md
for the drift note (keep the copies in sync with the backend originals).

Graceful by design: if the document source or the embeddings key is not
configured, `run_sync` records a clear report and returns WITHOUT raising, so the
scheduled run is a clean no-op (source_configured: false / 0 documents) rather
than a crash. No secret is read at import time.
"""
from __future__ import annotations

import sys

from app import indexing


def main() -> int:
    report = indexing.run_sync(triggered_by="cron")
    status = report.get("status", "unknown")
    note = report.get("note")
    files = report.get("files", [])
    # A single, greppable summary line for `grid logs` / the manager index-report.
    print(
        f"cron refresh: status={status} files={len(files)}"
        + (f" note={note!r}" if note else "")
    )
    # A skipped/degraded run is a SUCCESS (graceful no-op), not a failure — only a
    # genuine pipeline error should surface a non-zero exit for the scheduler.
    return 1 if status == "error" else 0


if __name__ == "__main__":
    sys.exit(main())
