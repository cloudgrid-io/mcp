"use client";

// Small client component: renders the board, upvotes via PATCH, and adds via POST
// to /api/requests. Sorted by votes (desc) locally after each mutation.
import { useState } from "react";

const STATUSES = ["open", "planned", "done"];

function sortByVotes(list) {
  return [...list].sort((a, b) => b.votes - a.votes);
}

export default function Board({ initialRequests }) {
  const [requests, setRequests] = useState(initialRequests);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    const res = await fetch("/api/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: t, description: description.trim() }),
    });
    if (res.ok) {
      const req = await res.json();
      setRequests((prev) => sortByVotes([req, ...prev]));
      setTitle("");
      setDescription("");
    }
    setBusy(false);
  }

  async function upvote(id) {
    setBusy(true);
    const res = await fetch(`/api/requests?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vote: 1 }),
    });
    if (res.ok) {
      const updated = await res.json();
      setRequests((prev) =>
        sortByVotes(prev.map((r) => (r.id === id ? { ...r, votes: updated.votes } : r))),
      );
    }
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="add">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Feature title…"
          aria-label="Feature title"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe it (optional)…"
          aria-label="Feature description"
        />
        <button type="submit" disabled={busy}>Add request</button>
      </form>
      <ul>
        {requests.length === 0 && <li className="empty">No requests yet — add the first one.</li>}
        {requests.map((r) => (
          <li key={r.id}>
            <div className="vote">
              <button type="button" onClick={() => upvote(r.id)} disabled={busy} aria-label="Upvote">
                ▲
              </button>
              <span className="count">{r.votes}</span>
            </div>
            <div className="body">
              <span className="title">{r.title}</span>{" "}
              <span className={`status ${STATUSES.includes(r.status) ? r.status : "open"}`}>{r.status}</span>
              {r.description && <p className="desc">{r.description}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
