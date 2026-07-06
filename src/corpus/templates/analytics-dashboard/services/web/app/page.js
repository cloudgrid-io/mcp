// Home page: a server component reads the events straight from Mongo, computes
// the summary metrics (total count, total value, distinct types, top type), and
// a small client form records new events via the API route. Data persists across
// refresh and across users because it lives in the grid-shared Mongo, not memory.
import { getDb } from "../lib/db.js";
import EventForm from "./event-form.js";

export const dynamic = "force-dynamic";

async function loadEvents() {
  const db = await getDb();
  const items = await db
    .collection("events")
    .find({})
    .sort({ at: -1 })
    .limit(50)
    .toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    type: e.type,
    value: typeof e.value === "number" ? e.value : 0,
    at: (e.at instanceof Date ? e.at : new Date(e.at)).toISOString(),
  }));
}

function summarize(events) {
  const totalCount = events.length;
  const totalValue = events.reduce((sum, e) => sum + e.value, 0);
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + e.value;
  const types = Object.keys(byType);
  const topType = types.sort((a, b) => byType[b] - byType[a])[0] || "—";
  return { totalCount, totalValue, distinctTypes: types.length, topType };
}

export default async function Page() {
  const events = await loadEvents();
  const stats = summarize(events);
  return (
    <main>
      <h1>Analytics Dashboard</h1>
      <p className="hint">
        Usage metrics computed from events stored in the grid-shared Mongo — survives refresh.
      </p>
      <div className="cards">
        <div className="card"><div className="k">Events</div><div className="v">{stats.totalCount}</div></div>
        <div className="card"><div className="k">Total value</div><div className="v">{stats.totalValue}</div></div>
        <div className="card"><div className="k">Event types</div><div className="v">{stats.distinctTypes}</div></div>
        <div className="card"><div className="k">Top type</div><div className="v">{stats.topType}</div></div>
      </div>
      <EventForm initialEvents={events} />
    </main>
  );
}
