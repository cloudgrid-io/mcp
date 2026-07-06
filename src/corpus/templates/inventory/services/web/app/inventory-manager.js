"use client";

// Small client component: renders the items table and posts to /api/items.
import { useState } from "react";

export default function InventoryManager({ initialItems }) {
  const [items, setItems] = useState(initialItems);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [location, setLocation] = useState("");
  const [reorderAt, setReorderAt] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    if (!sku.trim() || !name.trim()) return;
    setBusy(true);
    const res = await fetch("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku, name, qty, location, reorderAt }),
    });
    if (res.ok) {
      const item = await res.json();
      setItems((prev) => [item, ...prev]);
      setSku("");
      setName("");
      setQty("");
      setLocation("");
      setReorderAt("");
    }
    setBusy(false);
  }

  async function adjust(id, delta) {
    setBusy(true);
    const res = await fetch("/api/items", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, delta }),
    });
    if (res.ok) {
      const updated = await res.json();
      setItems((prev) => prev.map((it) => (it.id === id ? updated : it)));
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/items?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setItems((prev) => prev.filter((it) => it.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" aria-label="SKU" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" />
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" aria-label="Quantity" inputMode="numeric" />
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location" aria-label="Location" />
        <input value={reorderAt} onChange={(e) => setReorderAt(e.target.value)} placeholder="Reorder at" aria-label="Reorder at" inputMode="numeric" />
        <button type="submit" disabled={busy}>Add</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Location</th>
            <th>Qty</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td className="empty" colSpan={5}>No items yet.</td></tr>
          )}
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.sku}</td>
              <td>{it.name}</td>
              <td>{it.location}</td>
              <td className="qty">
                <button type="button" className="step" onClick={() => adjust(it.id, -1)} disabled={busy} aria-label="Decrease">−</button>{" "}
                {it.qty}{" "}
                <button type="button" className="step" onClick={() => adjust(it.id, 1)} disabled={busy} aria-label="Increase">+</button>
                {it.low && <span className="low">low</span>}
              </td>
              <td>
                <button type="button" onClick={() => remove(it.id)} disabled={busy}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
