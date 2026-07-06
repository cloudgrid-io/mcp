"use client";

// Client component: renders the product grid, a category filter, and an admin
// add/delete form. Reads/writes via /api/products (GET/POST/DELETE).
import { useState, useMemo } from "react";

const ALL = "All";

function formatPrice(n) {
  return "$" + Number(n || 0).toFixed(2);
}

export default function Catalog({ initialProducts }) {
  const [products, setProducts] = useState(initialProducts);
  const [active, setActive] = useState(ALL);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    price: "",
    category: "",
    description: "",
    inStock: true,
  });

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean));
    return [ALL, ...Array.from(set).sort()];
  }, [products]);

  const visible = useMemo(
    () => (active === ALL ? products : products.filter((p) => p.category === active)),
    [products, active],
  );

  async function add(e) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    setBusy(true);
    const res = await fetch("/api/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        price: parseFloat(form.price) || 0,
        category: form.category.trim() || "Uncategorized",
        description: form.description.trim(),
        inStock: form.inStock,
      }),
    });
    if (res.ok) {
      const product = await res.json();
      setProducts((prev) => [product, ...prev]);
      setForm({ name: "", price: "", category: "", description: "", inStock: true });
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/products?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) setProducts((prev) => prev.filter((p) => p.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <div className="filters">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className={"chip" + (c === active ? " active" : "")}
            onClick={() => setActive(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="grid">
        {visible.length === 0 && <p className="empty">No products yet.</p>}
        {visible.map((p) => (
          <div className="card" key={p.id}>
            <span className="cat">{p.category}</span>
            <h3>{p.name}</h3>
            <span className="price">{formatPrice(p.price)}</span>
            {p.description && <p className="desc">{p.description}</p>}
            <div className="foot">
              <span className={"stock " + (p.inStock ? "in" : "out")}>
                {p.inStock ? "In stock" : "Out of stock"}
              </span>
              <button
                type="button"
                className="del"
                onClick={() => remove(p.id)}
                disabled={busy}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="admin">
        <h2>Add a product</h2>
        <form onSubmit={add}>
          <div className="form-grid">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Name"
              aria-label="Product name"
            />
            <input
              value={form.price}
              onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              placeholder="Price"
              type="number"
              step="0.01"
              min="0"
              aria-label="Price"
            />
            <input
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="Category"
              aria-label="Category"
            />
            <label className="check">
              <input
                type="checkbox"
                checked={form.inStock}
                onChange={(e) => setForm((f) => ({ ...f, inStock: e.target.checked }))}
              />
              In stock
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Description"
              aria-label="Description"
            />
          </div>
          <button type="submit" disabled={busy}>Add product</button>
        </form>
      </div>
    </div>
  );
}
