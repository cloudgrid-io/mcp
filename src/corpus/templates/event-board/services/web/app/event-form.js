"use client";

// Small client component: renders the upcoming-events list and posts to /api/events.
// The list is kept sorted by date ascending (soonest first) after each add.
import { useState } from "react";

function byDate(a, b) {
  return String(a.date).localeCompare(String(b.date));
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function EventBoard({ initialEvents }) {
  const [events, setEvents] = useState(initialEvents);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const t = title.trim();
    const d = date.trim();
    if (!t || !d) return;
    setBusy(true);
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: t,
        date: d,
        location: location.trim(),
        description: description.trim(),
      }),
    });
    if (res.ok) {
      const event = await res.json();
      setEvents((prev) => [...prev, event].sort(byDate));
      setTitle("");
      setDate("");
      setLocation("");
      setDescription("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/events?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEvents((prev) => prev.filter((e) => e.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Event title"
          aria-label="Event title"
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Event date"
        />
        <input
          className="full"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Location"
          aria-label="Event location"
        />
        <textarea
          className="full"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          aria-label="Event description"
        />
        <button className="full" type="submit" disabled={busy}>
          Add event
        </button>
      </form>
      <ul>
        {events.length === 0 && <li className="empty">No upcoming events yet.</li>}
        {events.map((e) => (
          <li key={e.id}>
            <div className="event-head">
              <span className="event-title">{e.title}</span>
              <button className="del" type="button" onClick={() => remove(e.id)} disabled={busy}>
                Delete
              </button>
            </div>
            <div className="event-meta">
              {formatDate(e.date)}
              {e.location ? ` · ${e.location}` : ""}
            </div>
            {e.description && <p className="event-desc">{e.description}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
