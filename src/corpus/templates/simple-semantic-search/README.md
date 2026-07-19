# simple-semantic-search

Semantic search over a document in one node service, on the CloudGrid managed
vector substrate. `needs: { vector: pgvector }` provisions pgvector and injects
`VECTOR_PGVECTOR_URL`; `needs: { ai: true }` gives embeddings through
`@cloudgrid-io/runtime` with no API key. On startup the service embeds
`document.txt` (one vector per paragraph) into a `chunks` table sized from a
probe embedding, then `POST /search` embeds the query and returns the nearest
passages by cosine distance. `/health` returns 503 until the seed finishes, so
the platform holds the pod out of traffic until search works.

Proven by a real end-to-end deploy (live in under 3 minutes, 2026-07-16).

- Deploy: `grid plug` — the first plug auto-creates the entity from
  `cloudgrid.yaml` and deploys it.
- The CLI writes `.cloudgrid/link.json` (folder ↔ entity binding) on that first
  plug — never hand-author it; `rm -rf .cloudgrid` + re-plug to take a copied
  folder as your own app.
- Replace `services/web/src/document.txt` with the content to index.
- For a multi-service search portfolio (upload UI + refresh cron), use the
  `semantic-search` blueprint instead.
