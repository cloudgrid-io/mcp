// Home page: a server component reads the sales straight from Mongo, computes the
// revenue total and the per-product breakdown, and renders a recent-sales table.
// A small client form adds new sales via the API route. Data persists across
// refresh and across users because it lives in the grid-shared Mongo, not memory.
import { getDb } from "../lib/db.js";
import SaleForm from "./sale-form.js";

export const dynamic = "force-dynamic";

async function listSales() {
  const db = await getDb();
  const items = await db.collection("sales").find({}).sort({ at: -1 }).toArray();
  return items.map((s) => ({
    id: s._id.toString(),
    product: s.product,
    amount: typeof s.amount === "number" ? s.amount : 0,
    at: (s.at instanceof Date ? s.at : new Date(s.at)).toISOString(),
  }));
}

function money(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default async function Page() {
  const sales = await listSales();
  const total = sales.reduce((sum, s) => sum + s.amount, 0);

  const byProduct = new Map();
  for (const s of sales) {
    byProduct.set(s.product, (byProduct.get(s.product) || 0) + s.amount);
  }
  const breakdown = [...byProduct.entries()]
    .map(([product, amount]) => ({ product, amount }))
    .sort((a, b) => b.amount - a.amount);

  return (
    <main>
      <h1>Revenue Dashboard</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>

      <p className="total-label">Total revenue</p>
      <p className="total">{money(total)}</p>

      <h2>Add a sale</h2>
      <SaleForm />

      <h2>By product</h2>
      {breakdown.length === 0 ? (
        <p className="empty">No sales yet.</p>
      ) : (
        <div className="cards">
          {breakdown.map((b) => (
            <div className="card" key={b.product}>
              <div className="name">{b.product}</div>
              <div className="amt">{money(b.amount)}</div>
            </div>
          ))}
        </div>
      )}

      <h2>Recent sales</h2>
      {sales.length === 0 ? (
        <p className="empty">No sales yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="amt">Amount</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {sales.slice(0, 20).map((s) => (
              <tr key={s.id}>
                <td>{s.product}</td>
                <td className="amt">{money(s.amount)}</td>
                <td>{new Date(s.at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
