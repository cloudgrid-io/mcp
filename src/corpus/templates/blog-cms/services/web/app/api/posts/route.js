// App Router route handler for the `posts` collection.
// GET  -> list posts, POST -> create a post, DELETE -> remove a post by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. an `articles` or `pages` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function posts() {
  const db = await getDb();
  return db.collection("posts");
}

function slugify(input) {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function serialize(p) {
  return {
    id: p._id.toString(),
    title: p.title,
    slug: p.slug,
    body: p.body,
    tags: Array.isArray(p.tags) ? p.tags : [],
    published: !!p.published,
    createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
  };
}

// GET /api/posts — list all posts, newest first.
export async function GET() {
  const col = await posts();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

// POST /api/posts — create a post.
// Body: { title, body, slug?, tags?: string[], published?: boolean }.
export async function POST(request) {
  const data = await request.json().catch(() => ({}));
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const body = typeof data.body === "string" ? data.body.trim() : "";
  if (!title || !body) {
    return NextResponse.json({ error: "title and body are required" }, { status: 400 });
  }
  const slug =
    (typeof data.slug === "string" && data.slug.trim() && slugify(data.slug)) ||
    slugify(title);
  if (!slug) {
    return NextResponse.json({ error: "could not derive a slug" }, { status: 400 });
  }
  const tags = Array.isArray(data.tags)
    ? data.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const published = data.published !== false;

  const col = await posts();
  const existing = await col.findOne({ slug });
  if (existing) {
    return NextResponse.json({ error: "slug already exists" }, { status: 409 });
  }
  const doc = { title, slug, body, tags, published, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ _id: res.insertedId, ...doc }), { status: 201 });
}

// DELETE /api/posts?id=<id> — remove a post.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await posts();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
