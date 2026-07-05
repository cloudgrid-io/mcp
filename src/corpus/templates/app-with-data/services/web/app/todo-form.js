"use client";

// Small client component: renders the list and posts to /api/todos.
import { useState } from "react";

export default function TodoForm({ initialTodos }) {
  const [todos, setTodos] = useState(initialTodos);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    const res = await fetch("/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value }),
    });
    if (res.ok) {
      const todo = await res.json();
      setTodos((prev) => [todo, ...prev]);
      setText("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/todos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setTodos((prev) => prev.filter((t) => t.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a todo…"
          aria-label="New todo"
        />
        <button type="submit" disabled={busy}>Add</button>
      </form>
      <ul>
        {todos.length === 0 && <li className="empty">No todos yet.</li>}
        {todos.map((t) => (
          <li key={t.id}>
            <span>{t.text}</span>
            <button type="button" onClick={() => remove(t.id)} disabled={busy}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
