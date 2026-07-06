// App Router route handler for the `properties` collection.
// GET  -> list properties (optional ?location= and ?maxPrice= filters)
// POST -> add a property, DELETE -> remove a property by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. a `rentals` or `homes` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function properties() {
  const db = await getDb();
  return db.collection("properties");
}

function toClient(p) {
  return {
    id: p._id.toString(),
    title: p.title,
    price: p.price,
    location: p.location,
    beds: p.beds,
    description: p.description || "",
  };
}

// GET /api/properties?location=&maxPrice= — list properties, newest first.
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const location = params.get("location");
  const maxPrice = params.get("maxPrice");
  const query = {};
  if (location) query.location = location;
  if (maxPrice && !Number.isNaN(Number(maxPrice))) query.price = { $lte: Number(maxPrice) };
  const col = await properties();
  const items = await col.find(query).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(toClient));
}

// POST /api/properties — add a property.
// Body: { title, price:number, location, beds:number, description }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const price = Number(body.price);
  const beds = Number(body.beds);
  if (!title || !location) {
    return NextResponse.json({ error: "title and location are required" }, { status: 400 });
  }
  if (Number.isNaN(price) || Number.isNaN(beds)) {
    return NextResponse.json({ error: "price and beds must be numbers" }, { status: 400 });
  }
  const col = await properties();
  const doc = { title, price, location, beds, description, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(toClient({ ...doc, _id: res.insertedId }), { status: 201 });
}

// DELETE /api/properties?id=<id> — remove a property.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await properties();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
