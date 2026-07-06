// Home page: a server component reads the products straight from Mongo, and a
// small client component renders the grid, the category filter, and the admin
// add/delete form (posting to the API route). Data persists across refresh and
// across users because it lives in the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import Catalog from "./catalog.js";

export const dynamic = "force-dynamic";

async function listProducts() {
  const db = await getDb();
  const items = await db
    .collection("products")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  return items.map((p) => ({
    id: p._id.toString(),
    name: p.name,
    price: typeof p.price === "number" ? p.price : 0,
    category: p.category || "Uncategorized",
    description: p.description || "",
    inStock: !!p.inStock,
  }));
}

export default async function Page() {
  const products = await listProducts();
  return (
    <main>
      <h1>Product Catalog</h1>
      <p className="hint">Browse products by category — persisted in the grid-shared Mongo.</p>
      <Catalog initialProducts={products} />
    </main>
  );
}
