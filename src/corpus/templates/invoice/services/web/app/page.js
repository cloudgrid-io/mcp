// Home page: a server component reads the invoices straight from Mongo, and a
// small client component adds / marks-paid / removes them via the API route.
// Data persists across refresh and across users because it lives in the
// grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import InvoiceManager from "./invoice-manager.js";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "sent", "paid"];

async function listInvoices() {
  const db = await getDb();
  const items = await db.collection("invoices").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((i) => ({
    id: i._id.toString(),
    number: i.number || "",
    client: i.client || "",
    amount: typeof i.amount === "number" ? i.amount : 0,
    status: STATUSES.includes(i.status) ? i.status : "draft",
    due: i.due || "",
  }));
}

export default async function Page() {
  const invoices = await listInvoices();
  return (
    <main>
      <h1>Invoices</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <InvoiceManager initialInvoices={invoices} />
    </main>
  );
}
