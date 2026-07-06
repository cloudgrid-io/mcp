// Home page: a server component reads the tickets straight from Mongo, and a
// small client component adds / changes status / removes them via the API route.
// Data persists across refresh and across users because it lives in the
// grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import TicketQueue from "./ticket-queue.js";

export const dynamic = "force-dynamic";

const STATUSES = ["open", "pending", "closed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

async function listTickets() {
  const db = await getDb();
  const items = await db.collection("tickets").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((t) => ({
    id: t._id.toString(),
    subject: t.subject || "",
    requester: t.requester || "",
    status: STATUSES.includes(t.status) ? t.status : "open",
    priority: PRIORITIES.includes(t.priority) ? t.priority : "normal",
    body: t.body || "",
  }));
}

export default async function Page() {
  const tickets = await listTickets();
  return (
    <main>
      <h1>Support tickets</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <TicketQueue initialTickets={tickets} />
    </main>
  );
}
