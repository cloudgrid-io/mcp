"use client";

// Small client component: renders the entries + per-project totals, and posts to
// /api/entries to add or remove them.
import { useState } from "react";

function totalsByProject(entries) {
  const map = new Map();
  for (const e of entries) {
    map.set(e.project, (map.get(e.project) || 0) + e.minutes);
  }
  return [...map.entries()]
    .map(([project, minutes]) => ({ project, minutes }))
    .sort((a, b) => b.minutes - a.minutes);
}

function fmt(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export default function EntryForm({ initialEntries }) {
  const [entries, setEntries] = useState(initialEntries);
  const [task, setTask] = useState("");
  const [project, setProject] = useState("");
  const [minutes, setMinutes] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const t = task.trim();
    const p = project.trim();
    const mins = parseInt(minutes, 10);
    if (!t || !p || !Number.isFinite(mins) || mins <= 0) return;
    setBusy(true);
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: t, project: p, minutes: mins, date }),
    });
    if (res.ok) {
      const entry = await res.json();
      setEntries((prev) => [entry, ...prev]);
      setTask("");
      setMinutes("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEntries((prev) => prev.filter((e) => e.id !== id));
    setBusy(false);
  }

  const totals = totalsByProject(entries);

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task" aria-label="Task" />
        <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project" aria-label="Project" />
        <input type="number" min="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes" aria-label="Minutes" />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        <button type="submit" disabled={busy}>Log</button>
      </form>

      <h2>Totals per project</h2>
      {totals.length === 0 ? (
        <p className="meta">No time logged yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Project</th><th className="num">Time</th></tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.project}>
                <td>{t.project}</td>
                <td className="num">{fmt(t.minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Entries</h2>
      <ul>
        {entries.length === 0 && <li className="empty">No entries yet.</li>}
        {entries.map((e) => (
          <li key={e.id}>
            <span>
              <strong>{e.task}</strong> <span className="meta">{e.project} · {fmt(e.minutes)} · {e.date}</span>
            </span>
            <button type="button" onClick={() => remove(e.id)} disabled={busy}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
