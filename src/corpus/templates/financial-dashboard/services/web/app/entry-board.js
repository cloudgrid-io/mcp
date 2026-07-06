"use client";

// Client board: renders the totals + entries table and posts to /api/entries.
// Totals (income / expense / net) are derived from the current entries so they
// update instantly on add/delete, matching the server-computed view on refresh.
import { useState } from "react";

const fmt = (n) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function totals(entries) {
  let income = 0;
  let expense = 0;
  for (const e of entries) {
    if (e.type === "income") income += e.amount;
    else expense += e.amount;
  }
  return { income, expense, net: income - expense };
}

export default function EntryBoard({ initialEntries }) {
  const [entries, setEntries] = useState(initialEntries);
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState("income");
  const [busy, setBusy] = useState(false);

  const t = totals(entries);

  async function add(e) {
    e.preventDefault();
    const acct = account.trim();
    const amt = Number(amount);
    if (!acct || !Number.isFinite(amt) || amt <= 0) return;
    setBusy(true);
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: acct, amount: amt, type }),
    });
    if (res.ok) {
      const entry = await res.json();
      setEntries((prev) => [entry, ...prev]);
      setAccount("");
      setAmount("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEntries((prev) => prev.filter((e) => e.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <div className="totals">
        <div className="card">
          <div className="label">Income</div>
          <div className="value income">{fmt(t.income)}</div>
        </div>
        <div className="card">
          <div className="label">Expense</div>
          <div className="value expense">{fmt(t.expense)}</div>
        </div>
        <div className="card">
          <div className="label">Net</div>
          <div className={`value net ${t.net >= 0 ? "pos" : "neg"}`}>{fmt(t.net)}</div>
        </div>
      </div>

      <form onSubmit={add} className="row">
        <input
          className="account"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="Account (e.g. Sales, Rent)"
          aria-label="Account"
        />
        <input
          className="amount"
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          aria-label="Amount"
        />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="income">Income</option>
          <option value="expense">Expense</option>
        </select>
        <button type="submit" disabled={busy}>Add</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Type</th>
            <th style={{ textAlign: "right" }}>Amount</th>
            <th>Date</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr className="empty">
              <td colSpan={5}>No entries yet.</td>
            </tr>
          )}
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{e.account}</td>
              <td className={e.type}>{e.type}</td>
              <td className={`num ${e.type}`}>{fmt(e.amount)}</td>
              <td>{new Date(e.at).toLocaleDateString()}</td>
              <td className="num">
                <button type="button" onClick={() => remove(e.id)} disabled={busy}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
