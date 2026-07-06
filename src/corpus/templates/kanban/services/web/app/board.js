"use client";

// Small client component: renders the three columns and posts to /api/cards.
import { useState } from "react";

const COLUMNS = ["todo", "doing", "done"];
const LABELS = { todo: "To do", doing: "Doing", done: "Done" };

export default function Board({ initialCards }) {
  const [cards, setCards] = useState(initialCards);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    setBusy(true);
    const res = await fetch("/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: value }),
    });
    if (res.ok) {
      const card = await res.json();
      setCards((prev) => [...prev, card]);
      setTitle("");
    }
    setBusy(false);
  }

  async function move(id, column) {
    setBusy(true);
    const res = await fetch("/api/cards", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, column }),
    });
    if (res.ok) setCards((prev) => prev.map((c) => (c.id === id ? { ...c, column } : c)));
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/cards?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setCards((prev) => prev.filter((c) => c.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a card…"
          aria-label="New card"
        />
        <button type="submit" disabled={busy}>Add</button>
      </form>
      <div className="board">
        {COLUMNS.map((column) => (
          <section key={column}>
            <h2>{LABELS[column]}</h2>
            {cards.filter((c) => c.column === column).length === 0 && (
              <p className="empty">No cards.</p>
            )}
            {cards
              .filter((c) => c.column === column)
              .map((c) => (
                <article key={c.id} className="card">
                  <span className="title">{c.title}</span>
                  <div className="moves">
                    {COLUMNS.filter((other) => other !== column).map((other) => (
                      <button
                        key={other}
                        type="button"
                        onClick={() => move(c.id, other)}
                        disabled={busy}
                      >
                        → {LABELS[other]}
                      </button>
                    ))}
                    <button type="button" onClick={() => remove(c.id)} disabled={busy}>Delete</button>
                  </div>
                </article>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
