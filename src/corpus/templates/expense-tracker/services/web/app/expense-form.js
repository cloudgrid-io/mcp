"use client";

// Client component: renders the add-form, the expense table, and totals by
// category. Posts to /api/expenses and deletes via the same route.
import { useState, useMemo } from "react";

const CATEGORIES = ["Food", "Transport", "Housing", "Utilities", "Entertainment", "Health", "Other"];

function fmt(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function ExpenseTracker({ initialExpenses }) {
  const [expenses, setExpenses] = useState(initialExpenses);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => {
    const byCat = {};
    let grand = 0;
    for (const e of expenses) {
      byCat[e.category] = (byCat[e.category] || 0) + e.amount;
      grand += e.amount;
    }
    const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    return { rows, grand };
  }, [expenses]);

  async function add(e) {
    e.preventDefault();
    const desc = description.trim();
    const amt = Number.parseFloat(amount);
    if (!desc || !Number.isFinite(amt)) return;
    setBusy(true);
    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: desc, amount: amt, category, date }),
    });
    if (res.ok) {
      const expense = await res.json();
      setExpenses((prev) =>
        [expense, ...prev].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      );
      setDescription("");
      setAmount("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/expenses?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setExpenses((prev) => prev.filter((e) => e.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <label>
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Coffee, rent, bus fare…"
            aria-label="Description"
          />
        </label>
        <label>
          Amount
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-label="Amount"
          />
        </label>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        </label>
        <button type="submit" disabled={busy}>Add</button>
      </form>

      <h2>Expenses</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th>Category</th>
            <th className="amount">Amount</th>
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {expenses.length === 0 && (
            <tr><td colSpan={5} className="empty">No expenses yet.</td></tr>
          )}
          {expenses.map((e) => (
            <tr key={e.id}>
              <td>{e.date}</td>
              <td>{e.description}</td>
              <td>{e.category}</td>
              <td className="amount">{fmt(e.amount)}</td>
              <td>
                <button type="button" className="del" onClick={() => remove(e.id)} disabled={busy} aria-label="Delete">✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Totals by category</h2>
      <ul className="totals">
        {totals.rows.length === 0 && <li className="empty">Nothing to total yet.</li>}
        {totals.rows.map(([cat, sum]) => (
          <li key={cat}><span>{cat}</span><span>{fmt(sum)}</span></li>
        ))}
        {totals.rows.length > 0 && (
          <li className="grand"><span>Total</span><span>{fmt(totals.grand)}</span></li>
        )}
      </ul>
    </div>
  );
}
