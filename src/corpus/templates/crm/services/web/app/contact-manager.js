"use client";

// Small client component: renders the contacts table and posts to /api/contacts.
import { useState } from "react";

const STAGES = ["lead", "qualified", "customer"];
const LABELS = { lead: "Lead", qualified: "Qualified", customer: "Customer" };

export default function ContactManager({ initialContacts }) {
  const [contacts, setContacts] = useState(initialContacts);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: value, email, company }),
    });
    if (res.ok) {
      const contact = await res.json();
      setContacts((prev) => [contact, ...prev]);
      setName("");
      setEmail("");
      setCompany("");
    }
    setBusy(false);
  }

  async function setStage(id, stage) {
    setBusy(true);
    const res = await fetch("/api/contacts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, stage }),
    });
    if (res.ok) setContacts((prev) => prev.map((c) => (c.id === id ? { ...c, stage } : c)));
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/contacts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setContacts((prev) => prev.filter((c) => c.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Email" />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" aria-label="Company" />
        <button type="submit" disabled={busy}>Add</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Company</th>
            <th>Stage</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {contacts.length === 0 && (
            <tr><td className="empty" colSpan={5}>No contacts yet.</td></tr>
          )}
          {contacts.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.email}</td>
              <td>{c.company}</td>
              <td>
                <select
                  value={c.stage}
                  onChange={(e) => setStage(c.id, e.target.value)}
                  disabled={busy}
                  aria-label="Stage"
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>{LABELS[s]}</option>
                  ))}
                </select>
              </td>
              <td>
                <button type="button" onClick={() => remove(c.id)} disabled={busy}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
