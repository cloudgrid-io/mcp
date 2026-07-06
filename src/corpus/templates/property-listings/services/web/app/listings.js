"use client";

// Client component: renders the filter controls, the property grid, a detail
// view for a selected property, and an admin add form. It fetches the filtered
// list and posts/deletes via /api/properties.
import { useState } from "react";

function fmtPrice(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  return "$" + n.toLocaleString();
}

export default function Listings({ initialProperties, locations, activeLocation, activeMaxPrice }) {
  const [properties, setProperties] = useState(initialProperties);
  const [location, setLocation] = useState(activeLocation || "");
  const [maxPrice, setMaxPrice] = useState(activeMaxPrice || "");
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);

  async function applyFilters(e) {
    e.preventDefault();
    setBusy(true);
    const params = new URLSearchParams();
    if (location) params.set("location", location);
    if (maxPrice) params.set("maxPrice", maxPrice);
    const res = await fetch(`/api/properties?${params.toString()}`);
    if (res.ok) setProperties(await res.json());
    setBusy(false);
  }

  async function addProperty(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const payload = {
      title: (data.get("title") || "").toString().trim(),
      price: Number(data.get("price")),
      location: (data.get("location") || "").toString().trim(),
      beds: Number(data.get("beds")),
      description: (data.get("description") || "").toString().trim(),
    };
    if (!payload.title || !payload.location) return;
    setBusy(true);
    const res = await fetch("/api/properties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const created = await res.json();
      setProperties((prev) => [created, ...prev]);
      form.reset();
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/properties?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      setProperties((prev) => prev.filter((p) => p.id !== id));
      setSelected((s) => (s && s.id === id ? null : s));
    }
    setBusy(false);
  }

  if (selected) {
    return (
      <div>
        <button type="button" onClick={() => setSelected(null)}>← Back to listings</button>
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3>{selected.title}</h3>
          <span className="price">{fmtPrice(selected.price)}</span>
          <span className="meta">{selected.location} · {selected.beds} bed{selected.beds === 1 ? "" : "s"}</span>
          <p className="desc">{selected.description || "No description."}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <form onSubmit={applyFilters} className="filters">
        <div className="field">
          <label htmlFor="f-location">Location</label>
          <select id="f-location" value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">Any location</option>
            {locations.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-maxprice">Max price</label>
          <input
            id="f-maxprice"
            type="number"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            placeholder="No max"
          />
        </div>
        <button type="submit" disabled={busy}>Filter</button>
      </form>

      <ul className="grid">
        {properties.length === 0 && <li className="card empty">No properties match.</li>}
        {properties.map((p) => (
          <li key={p.id} className="card">
            <h3>{p.title}</h3>
            <span className="price">{fmtPrice(p.price)}</span>
            <span className="meta">{p.location} · {p.beds} bed{p.beds === 1 ? "" : "s"}</span>
            {p.description && <span className="desc">{p.description.slice(0, 80)}{p.description.length > 80 ? "…" : ""}</span>}
            <div className="del">
              <button type="button" onClick={() => setSelected(p)}>View</button>{" "}
              <button type="button" onClick={() => remove(p.id)} disabled={busy}>Delete</button>
            </div>
          </li>
        ))}
      </ul>

      <details className="admin">
        <summary>Admin · add a property</summary>
        <form onSubmit={addProperty} className="form-grid">
          <div className="field full">
            <label htmlFor="a-title">Title</label>
            <input id="a-title" name="title" placeholder="Sunny 2-bed apartment" required />
          </div>
          <div className="field">
            <label htmlFor="a-price">Price</label>
            <input id="a-price" name="price" type="number" placeholder="450000" required />
          </div>
          <div className="field">
            <label htmlFor="a-beds">Beds</label>
            <input id="a-beds" name="beds" type="number" placeholder="2" required />
          </div>
          <div className="field full">
            <label htmlFor="a-location">Location</label>
            <input id="a-location" name="location" placeholder="Austin, TX" required />
          </div>
          <div className="field full">
            <label htmlFor="a-description">Description</label>
            <textarea id="a-description" name="description" placeholder="Bright corner unit with…" />
          </div>
          <div className="full">
            <button type="submit" disabled={busy}>Add property</button>
          </div>
        </form>
      </details>
    </div>
  );
}
