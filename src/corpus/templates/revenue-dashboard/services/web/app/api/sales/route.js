// App Router route handler for the `sales` collection.
// GET  -> list sales, POST -> add a sale, DELETE -> remove a sale by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. an `invoices` or `orders` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function sales() {
  const db = await getDb();
  return db.collection("sales");
}

function shape(s) {
  return {
    id: s._id.toString(),
    product: s.product,
    amount: typeof s.amount === "number" ? s.amount : 0,
    at: (s.at instanceof Date ? s.at : new Date(s.at)).toISOString(),
  };
}

// GET /api/sales — list all sales, newest first.
export async function GET() {
  const col = await sales();
  const items = await col.find({}).sort({ at: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/sales — add a sale. Body: { product: string, amount: number }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const product = typeof body.product === "string" ? body.product.trim() : "";
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!product) {
    return NextResponse.json({ error: "product is required" }, { status: 400 });
  }
  if (!Number.isFinite(amount)) {
    return NextResponse.json({ error: "amount must be a number" }, { status: 400 });
  }
  const col = await sales();
  const doc = { product, amount, at: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ _id: res.insertedId, ...doc }), { status: 201 });
}

// DELETE /api/sales?id=<id> — remove a sale.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await sales();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
