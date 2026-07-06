// Home page: a server component reads the items straight from Mongo, and a small
// client component adds / adjusts quantity / removes them via the API route.
// Data persists across refresh and across users because it lives in the
// grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import InventoryManager from "./inventory-manager.js";

export const dynamic = "force-dynamic";

async function listItems() {
  const db = await getDb();
  const list = await db.collection("items").find({}).sort({ createdAt: -1 }).toArray();
  return list.map((it) => {
    const qty = typeof it.qty === "number" ? it.qty : 0;
    const reorderAt = typeof it.reorderAt === "number" ? it.reorderAt : 0;
    return {
      id: it._id.toString(),
      sku: it.sku || "",
      name: it.name || "",
      qty,
      location: it.location || "",
      reorderAt,
      low: qty <= reorderAt,
    };
  });
}

export default async function Page() {
  const items = await listItems();
  return (
    <main>
      <h1>Inventory</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh. Rows at or below their reorder level are flagged low.</p>
      <InventoryManager initialItems={items} />
    </main>
  );
}
