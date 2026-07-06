"use client";

// Small client component: renders the task list with a complete-toggle + filter
// and posts to /api/tasks.
import { useState } from "react";

const PRIORITIES = ["low", "medium", "high"];
const FILTERS = ["all", "active", "done"];

export default function TaskList({ initialTasks }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("medium");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    setBusy(true);
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: value, due, priority }),
    });
    if (res.ok) {
      const task = await res.json();
      setTasks((prev) => [task, ...prev]);
      setTitle("");
      setDue("");
      setPriority("medium");
    }
    setBusy(false);
  }

  async function toggle(id, done) {
    setBusy(true);
    const res = await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, done }),
    });
    if (res.ok) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done } : t)));
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setTasks((prev) => prev.filter((t) => t.id !== id));
    setBusy(false);
  }

  const shown = tasks.filter((t) =>
    filter === "all" ? true : filter === "done" ? t.done : !t.done,
  );

  return (
    <div>
      <form onSubmit={add} className="row">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task…"
          aria-label="New task"
        />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button type="submit" disabled={busy}>Add</button>
      </form>
      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={filter === f ? "active" : ""}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <ul>
        {shown.length === 0 && <li className="empty">No tasks.</li>}
        {shown.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <input
              type="checkbox"
              checked={t.done}
              onChange={(e) => toggle(t.id, e.target.checked)}
              disabled={busy}
              aria-label="Done"
            />
            <span className="title">{t.title}</span>
            <span className="pri">{t.priority}</span>
            {t.due && <span className="meta">{t.due}</span>}
            <button type="button" onClick={() => remove(t.id)} disabled={busy}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
