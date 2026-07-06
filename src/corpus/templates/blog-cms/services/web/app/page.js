// Home page: a server component reads published posts straight from Mongo and
// renders the post list. Data persists across refresh and across users because
// it lives in the grid-shared Mongo, not in memory.
import Link from "next/link";
import { getDb } from "../lib/db.js";

export const dynamic = "force-dynamic";

async function listPublished() {
  const db = await getDb();
  const items = await db
    .collection("posts")
    .find({ published: true })
    .sort({ createdAt: -1 })
    .toArray();
  return items.map((p) => ({
    id: p._id.toString(),
    title: p.title,
    slug: p.slug,
    tags: Array.isArray(p.tags) ? p.tags : [],
    createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
  }));
}

export default async function Page() {
  const posts = await listPublished();
  return (
    <main>
      <h1>Blog</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <nav>
        <Link href="/admin">Admin</Link>
      </nav>
      {posts.length === 0 && <p className="empty">No published posts yet.</p>}
      {posts.map((p) => (
        <article key={p.id}>
          <h2>
            <Link href={`/posts/${encodeURIComponent(p.slug)}`}>{p.title}</Link>
          </h2>
          {p.createdAt && (
            <p className="meta">{new Date(p.createdAt).toLocaleDateString()}</p>
          )}
          {p.tags.length > 0 && (
            <p className="tags">
              {p.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </p>
          )}
        </article>
      ))}
    </main>
  );
}
