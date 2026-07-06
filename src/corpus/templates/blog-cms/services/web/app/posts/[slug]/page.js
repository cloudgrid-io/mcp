// Single-post page: a server component reads one published post by its slug.
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function getPost(slug) {
  const db = await getDb();
  const p = await db.collection("posts").findOne({ slug, published: true });
  if (!p) return null;
  return {
    title: p.title,
    body: p.body,
    tags: Array.isArray(p.tags) ? p.tags : [],
    createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
  };
}

export default async function PostPage({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  return (
    <main>
      <nav>
        <Link href="/">← All posts</Link>
      </nav>
      <h1>{post.title}</h1>
      {post.createdAt && (
        <p className="meta">{new Date(post.createdAt).toLocaleDateString()}</p>
      )}
      {post.tags.length > 0 && (
        <p className="tags">
          {post.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </p>
      )}
      <div className="post-body">{post.body}</div>
    </main>
  );
}
