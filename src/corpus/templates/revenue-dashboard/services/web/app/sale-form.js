"use client";

// Small client component: posts a new sale to /api/sales, then refreshes the
// server component so the total, breakdown, and table all recompute from Mongo.
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SaleForm() {
  const router = useRouter();
  const [product, setProduct] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add(e) {
    e.preventDefault();
    const name = product.trim();
    const value = Number(amount);
    if (!name || !Number.isFinite(value)) {
      setError("Enter a product and a numeric amount.");
      return;
    }
    setError("");
    setBusy(true);
    const res = await fetch("/api/sales", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: name, amount: value }),
    });
    if (res.ok) {
      setProduct("");
      setAmount("");
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Failed to add sale.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={add}>
      <div className="row">
        <input
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          placeholder="Product"
          aria-label="Product"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          aria-label="Amount"
          type="number"
          step="0.01"
        />
        <button type="submit" disabled={busy}>Add sale</button>
      </div>
      {error && <p className="hint" role="alert">{error}</p>}
    </form>
  );
}
