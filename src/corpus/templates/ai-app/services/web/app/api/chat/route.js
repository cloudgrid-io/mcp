// Chat API route: takes the user's message, asks the grid AI gateway for a
// reply, persists the exchange to Mongo, and returns the reply.
//
// The AI call uses @cloudgrid-io/runtime with ZERO config — no API key. The SDK
// reads the gateway URL from RUNTIME_GATEWAY_URL (injected by the grid) all on
// its own, so it only works inside a deployed grid app (or under `grid dev`). Do
// NOT set a key or reference the env var yourself.
import { NextResponse } from "next/server";
import { runtime } from "@cloudgrid-io/runtime";
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

  // 1. Ask the grid AI gateway (zero-config in-grid identity — no key). Chat
  //    expects a model; it returns { text }.
  const { text: reply } = await runtime.ai.chat({
    model: "claude-haiku",
    messages: [{ role: "user", content: text }],
  });

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
