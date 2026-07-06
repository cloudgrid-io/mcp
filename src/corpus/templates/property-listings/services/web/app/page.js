// Home page: a server component reads the properties straight from Mongo and
// applies the location/price filters from the URL search params. A small client
// component renders the grid, the filter controls, the detail view, and the
// admin add form. Data persists across refresh and across users because it lives
// in the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import Listings from "./listings.js";

export const dynamic = "force-dynamic";

async function listProperties({ location, maxPrice } = {}) {
  const db = await getDb();
  const query = {};
  if (location) query.location = location;
  if (maxPrice && !Number.isNaN(Number(maxPrice))) query.price = { $lte: Number(maxPrice) };
  const items = await db.collection("properties").find(query).sort({ createdAt: -1 }).toArray();
  return items.map((p) => ({
    id: p._id.toString(),
    title: p.title,
    price: p.price,
    location: p.location,
    beds: p.beds,
    description: p.description || "",
  }));
}

async function allLocations() {
  const db = await getDb();
  const locs = await db.collection("properties").distinct("location");
  return locs.filter(Boolean).sort();
}

export default async function Page({ searchParams }) {
  const sp = (await searchParams) || {};
  const location = typeof sp.location === "string" ? sp.location : "";
  const maxPrice = typeof sp.maxPrice === "string" ? sp.maxPrice : "";
  const [properties, locations] = await Promise.all([
    listProperties({ location, maxPrice }),
    allLocations(),
  ]);
  return (
    <main>
      <h1>Property Listings</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <Listings
        initialProperties={properties}
        locations={locations}
        activeLocation={location}
        activeMaxPrice={maxPrice}
      />
    </main>
  );
}
