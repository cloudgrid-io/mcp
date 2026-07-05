// Chat API route: takes the user's message, asks the grid AI gateway for a
// reply, persists the exchange to Mongo, and returns the reply.
//
// The AI call uses @cloudgrid-io/ai with ZERO config — no API key. createClient()
// auto-detects the in-grid identity, so it only works inside a deployed grid app
// (or under `grid dev`). Do NOT pass a key.
import { NextResponse } from "next/server";
import { createClient } from "@cloudgrid-io/ai";
import { getDb } from "../../../lib/db.js";

// Never cache — always generate/persist live.
export const dynamic = "force-dynamic";

async function messages() {
  const db = await getDb();
  return db.collection("messages");
}

// POST /api/chat — body { message: string }. Returns { reply: string }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // 1. Ask the grid AI gateway (zero-config in-grid identity — no key).
  const client = createClient();
  const r = await client.chat({ messages: [{ role: "user", content: text }] });
  const reply = r.text ?? r.content ?? "";

  // 2. Persist the exchange so the conversation survives refresh.
  const col = await messages();
  const now = new Date();
  await col.insertMany([
    { role: "user", content: text, createdAt: now },
    { role: "assistant", content: reply, createdAt: new Date(now.getTime() + 1) },
  ]);

  // 3. Return the reply.
  return NextResponse.json({ reply });
}

// GET /api/chat — the stored conversation, oldest first.
export async function GET() {
  const col = await messages();
  const history = await col.find({}).sort({ createdAt: 1 }).toArray();
  return NextResponse.json(
    history.map((m) => ({ id: m._id.toString(), role: m.role, content: m.content })),
  );
}
