// Home page: a server component reads the stored conversation straight from
// Mongo, and a small client component sends new messages via the /api/chat
// route (which calls the grid AI gateway and persists the exchange). History
// persists across refresh because it lives in the grid-shared Mongo.
import { getDb } from "../lib/db.js";
import Chat from "./chat.js";

export const dynamic = "force-dynamic";

async function listHistory() {
  const db = await getDb();
  const items = await db.collection("messages").find({}).sort({ createdAt: 1 }).toArray();
  return items.map((m) => ({ id: m._id.toString(), role: m.role, content: m.content }));
}

export default async function Page() {
  const history = await listHistory();
  return (
    <main>
      <h1>AI Assistant</h1>
      <p className="hint">Powered by the grid AI gateway — conversation persisted in Mongo.</p>
      <Chat initialHistory={history} />
    </main>
  );
}
