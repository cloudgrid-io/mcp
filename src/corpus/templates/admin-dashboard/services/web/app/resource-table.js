"use client";

// Generic client management table for one admin resource. Renders a row of
// inputs (driven by `columns`) and the current rows, and posts to
// /api/<resource> (POST to add, DELETE to remove). Reused for users + orders.
import { useState } from "react";

function blankDraft(columns) {
  const d = {};
  for (const c of columns) d[c.key] = c.input === "select" ? c.options[0] : "";
  return d;
}

export default function ResourceTable({ resource, columns, initialRows }) {
  const [rows, setRows] = useState(initialRows);
  const [draft, setDraft] = useState(() => blankDraft(columns));
  const [busy, setBusy] = useState(false);

  function set(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function add(e) {
    e.preventDefault();
    const required = columns.find((c) => c.required);
    if (required && !String(draft[required.key]).trim()) return;
    setBusy(true);
    const res = await fetch(`/api/${resource}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (res.ok) {
      const row = await res.json();
      setRows((prev) => [row, ...prev]);
      setDraft(blankDraft(columns));
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/${resource}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setRows((prev) => prev.filter((r) => r.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        {columns.map((c) =>
          c.input === "select" ? (
            <select key={c.key} value={draft[c.key]} onChange={(e) => set(c.key, e.target.value)} aria-label={c.label}>
              {c.options.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              key={c.key}
              type={c.input === "number" ? "number" : "text"}
              value={draft[c.key]}
              onChange={(e) => set(c.key, e.target.value)}
              placeholder={c.label}
              aria-label={c.label}
            />
          ),
        )}
        <button type="submit" disabled={busy}>Add</button>
      </form>
      <table>
        <thead>
          <tr>
            {columns.map((c) => <th key={c.key}>{c.label}</th>)}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td className="empty" colSpan={columns.length + 1}>No {resource} yet.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              {columns.map((c) => <td key={c.key}>{String(r[c.key] ?? "")}</td>)}
              <td>
                <button type="button" onClick={() => remove(r.id)} disabled={busy}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
