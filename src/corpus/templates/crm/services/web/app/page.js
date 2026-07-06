// Home page: a server component reads the contacts straight from Mongo, and a
// small client component adds / restages / removes them via the API route. Data
// persists across refresh and across users because it lives in the grid-shared
// Mongo, not in memory.
import { getDb } from "../lib/db.js";
import ContactManager from "./contact-manager.js";

export const dynamic = "force-dynamic";

const STAGES = ["lead", "qualified", "customer"];

async function listContacts() {
  const db = await getDb();
  const items = await db.collection("contacts").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((c) => ({
    id: c._id.toString(),
    name: c.name || "",
    email: c.email || "",
    company: c.company || "",
    stage: STAGES.includes(c.stage) ? c.stage : "lead",
    note: c.note || "",
  }));
}

export default async function Page() {
  const contacts = await listContacts();
  return (
    <main>
      <h1>Contacts</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <ContactManager initialContacts={contacts} />
    </main>
  );
}
