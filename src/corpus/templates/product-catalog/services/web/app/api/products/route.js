// App Router route handler for the `products` collection.
// GET  -> list products, POST -> add a product, DELETE -> remove a product by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. an `items` or `inventory` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function products() {
  const db = await getDb();
  return db.collection("products");
}

function serialize(p) {
  return {
    id: p._id.toString(),
    name: p.name,
    price: typeof p.price === "number" ? p.price : 0,
    category: p.category || "Uncategorized",
    description: p.description || "",
    inStock: !!p.inStock,
  };
}

// GET /api/products — list all products, newest first.
export async function GET() {
  const col = await products();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

// POST /api/products — add a product.
// Body: { name: string, price?: number, category?: string, description?: string, inStock?: bool }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const doc = {
    name,
    price: typeof body.price === "number" && isFinite(body.price) ? body.price : 0,
    category:
      typeof body.category === "string" && body.category.trim()
        ? body.category.trim()
        : "Uncategorized",
    description: typeof body.description === "string" ? body.description.trim() : "",
    inStock: body.inStock !== false,
    createdAt: new Date(),
  };
  const col = await products();
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ ...doc, _id: res.insertedId }), { status: 201 });
}

// DELETE /api/products?id=<id> — remove a product.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await products();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
