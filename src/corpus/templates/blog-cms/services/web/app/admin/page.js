// Admin page: a server component reads ALL posts (drafts + published) from Mongo
// and hands them to the client editor, which creates/deletes via the API route.
import Link from "next/link";
import { getDb } from "../../lib/db.js";
import AdminEditor from "./admin-editor.js";

export const dynamic = "force-dynamic";

async function listAll() {
  const db = await getDb();
  const items = await db.collection("posts").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((p) => ({
    id: p._id.toString(),
    title: p.title,
    slug: p.slug,
    published: !!p.published,
    tags: Array.isArray(p.tags) ? p.tags : [],
  }));
}

export default async function AdminPage() {
  const posts = await listAll();
  return (
    <main>
      <h1>Admin</h1>
      <p className="hint">Create and delete posts. Drafts stay off the public list.</p>
      <nav>
        <Link href="/">← View blog</Link>
      </nav>
      <AdminEditor initialPosts={posts} />
    </main>
  );
}
