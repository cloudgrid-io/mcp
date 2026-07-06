// App Router route handler for the `questions` collection.
// GET  -> list questions, POST -> add a question, DELETE -> remove one by id.
//
// A question document is { prompt: string, options: string[], answerIndex: number }.
// To adapt this app, rename the collection and change the fields to match your
// own data.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function questions() {
  const db = await getDb();
  return db.collection("questions");
}

function shape(q) {
  return {
    id: q._id.toString(),
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : [],
    answerIndex: typeof q.answerIndex === "number" ? q.answerIndex : 0,
  };
}

// GET /api/questions — list all questions, newest first.
export async function GET() {
  const col = await questions();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/questions — add a question.
// Body: { prompt: string, options: string[], answerIndex: number }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const options = Array.isArray(body.options)
    ? body.options.map((o) => String(o).trim()).filter(Boolean)
    : [];
  let answerIndex = Number.isInteger(body.answerIndex) ? body.answerIndex : 0;
  if (!prompt || options.length < 2) {
    return NextResponse.json(
      { error: "prompt and at least 2 options are required" },
      { status: 400 },
    );
  }
  if (answerIndex < 0 || answerIndex >= options.length) answerIndex = 0;
  const col = await questions();
  const doc = { prompt, options, answerIndex, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(
    { id: res.insertedId.toString(), prompt, options, answerIndex },
    { status: 201 },
  );
}

// DELETE /api/questions?id=<id> — remove a question.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await questions();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
