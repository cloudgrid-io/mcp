"use client";

// Small client component: renders the tickets table and posts to /api/tickets.
import { useState } from "react";

const STATUSES = ["open", "pending", "closed"];
const STATUS_LABELS = { open: "Open", pending: "Pending", closed: "Closed" };
const PRIORITIES = ["low", "normal", "high", "urgent"];
const PRIORITY_LABELS = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export default function TicketQueue({ initialTickets }) {
  const [tickets, setTickets] = useState(initialTickets);
  const [subject, setSubject] = useState("");
  const [requester, setRequester] = useState("");
  const [priority, setPriority] = useState("normal");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    if (!subject.trim()) return;
    setBusy(true);
    const res = await fetch("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, requester, priority, body }),
    });
    if (res.ok) {
      const ticket = await res.json();
      setTickets((prev) => [ticket, ...prev]);
      setSubject("");
      setRequester("");
      setPriority("normal");
      setBody("");
    }
    setBusy(false);
  }

  async function setStatus(id, status) {
    setBusy(true);
    const res = await fetch("/api/tickets", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/tickets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setTickets((prev) => prev.filter((t) => t.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add}>
        <div className="row">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" />
          <input value={requester} onChange={(e) => setRequester(e.target.value)} placeholder="Requester" aria-label="Requester" />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
            ))}
          </select>
          <button type="submit" disabled={busy}>Add</button>
        </div>
        <div className="row">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe the issue…" aria-label="Body" />
        </div>
      </form>
      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Requester</th>
            <th>Priority</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tickets.length === 0 && (
            <tr><td className="empty" colSpan={5}>No tickets yet.</td></tr>
          )}
          {tickets.map((t) => (
            <tr key={t.id}>
              <td>
                <div>{t.subject}</div>
                {t.body && <div className="hint">{t.body}</div>}
              </td>
              <td>{t.requester}</td>
              <td><span className="prio">{PRIORITY_LABELS[t.priority]}</span></td>
              <td>
                <select value={t.status} onChange={(e) => setStatus(t.id, e.target.value)} disabled={busy} aria-label="Status">
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </td>
              <td>
                <button type="button" onClick={() => remove(t.id)} disabled={busy}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
