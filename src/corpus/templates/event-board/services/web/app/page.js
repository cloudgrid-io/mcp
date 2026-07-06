// Home page: a server component reads the events straight from Mongo, and a small
// client form adds/removes them via the API route. Data persists across refresh
// and across users because it lives in the grid-shared Mongo, not in memory.
//
// Events are listed as an UPCOMING board — sorted by date ascending so the next
// event is on top.
import { getDb } from "../lib/db.js";
import EventBoard from "./event-form.js";

export const dynamic = "force-dynamic";

async function listEvents() {
  const db = await getDb();
  // Sort by event date ascending: soonest upcoming event first.
  const items = await db.collection("events").find({}).sort({ date: 1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    title: e.title,
    date: e.date,
    location: e.location,
    description: e.description,
  }));
}

export default async function Page() {
  const events = await listEvents();
  return (
    <main>
      <h1>Event Board</h1>
      <p className="hint">Community events, sorted by date — persisted in grid-shared Mongo.</p>
      <EventBoard initialEvents={events} />
    </main>
  );
}
