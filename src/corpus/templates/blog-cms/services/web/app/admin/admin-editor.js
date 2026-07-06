"use client";

// Client editor: renders the admin list and posts create/delete to /api/posts.
import { useState } from "react";

export default function AdminEditor({ initialPosts }) {
  const [posts, setPosts] = useState(initialPosts);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [published, setPublished] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(e) {
    e.preventDefault();
    setError("");
    if (!title.trim() || !body.trim()) {
      setError("Title and body are required.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        slug: slug.trim(),
        body: body.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        published,
      }),
    });
    if (res.ok) {
      const post = await res.json();
      setPosts((prev) => [post, ...prev]);
      setTitle("");
      setSlug("");
      setBody("");
      setTags("");
      setPublished(true);
    } else {
      const err = await res.json().catch(() => ({}));
      setError(err.error || "Failed to create post.");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/posts?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) setPosts((prev) => prev.filter((p) => p.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={create} className="admin">
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Post title"
          />
        </label>
        <label>
          Slug (optional — derived from title if blank)
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-post"
          />
        </label>
        <label>
          Body
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your post…"
          />
        </label>
        <label>
          Tags (comma-separated)
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="news, updates"
          />
        </label>
        <div className="checkbox">
          <input
            id="published"
            type="checkbox"
            checked={published}
            onChange={(e) => setPublished(e.target.checked)}
          />
          <label htmlFor="published" style={{ display: "inline" }}>
            Published
          </label>
        </div>
        {error && <p className="draft">{error}</p>}
        <div>
          <button type="submit" disabled={busy}>
            Create post
          </button>
        </div>
      </form>

      {posts.length === 0 && <p className="empty">No posts yet.</p>}
      {posts.map((p) => (
        <article key={p.id}>
          <h2>
            {p.title}
            {!p.published && <span className="draft">draft</span>}
          </h2>
          <p className="meta">/{p.slug}</p>
          <div className="row-actions">
            <button type="button" onClick={() => remove(p.id)} disabled={busy}>
              Delete
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
