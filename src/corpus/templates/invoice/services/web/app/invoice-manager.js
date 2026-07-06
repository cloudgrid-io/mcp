"use client";

// Small client component: renders the invoices table and posts to /api/invoices.
import { useState } from "react";

const STATUSES = ["draft", "sent", "paid"];
const LABELS = { draft: "Draft", sent: "Sent", paid: "Paid" };

export default function InvoiceManager({ initialInvoices }) {
  const [invoices, setInvoices] = useState(initialInvoices);
  const [number, setNumber] = useState("");
  const [client, setClient] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    if (!number.trim() || !client.trim()) return;
    setBusy(true);
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ number, client, amount, due }),
    });
    if (res.ok) {
      const invoice = await res.json();
      setInvoices((prev) => [invoice, ...prev]);
      setNumber("");
      setClient("");
      setAmount("");
      setDue("");
    }
    setBusy(false);
  }

  async function setStatus(id, status) {
    setBusy(true);
    const res = await fetch("/api/invoices", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) setInvoices((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/invoices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setInvoices((prev) => prev.filter((i) => i.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Number" aria-label="Number" />
        <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client" aria-label="Client" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" aria-label="Amount" inputMode="decimal" />
        <input value={due} onChange={(e) => setDue(e.target.value)} placeholder="Due (YYYY-MM-DD)" aria-label="Due date" />
        <button type="submit" disabled={busy}>Add</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>Client</th>
            <th>Amount</th>
            <th>Due</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {invoices.length === 0 && (
            <tr><td className="empty" colSpan={6}>No invoices yet.</td></tr>
          )}
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td>
              <td>{i.client}</td>
              <td className="amount">{i.amount.toFixed(2)}</td>
              <td>{i.due}</td>
              <td>
                <select value={i.status} onChange={(e) => setStatus(i.id, e.target.value)} disabled={busy} aria-label="Status">
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{LABELS[s]}</option>
                  ))}
                </select>
              </td>
              <td>
                <button type="button" onClick={() => remove(i.id)} disabled={busy}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
