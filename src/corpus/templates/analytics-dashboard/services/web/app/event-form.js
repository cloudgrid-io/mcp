"use client";

// Small client component: records an event via POST /api/events, prepends it to
// the recent-events table, and recomputes the summary cards on the fly so the
// dashboard updates without a full reload. Delete removes an event by id.
import { useMemo, useState } from "react";

export default function EventForm({ initialEvents }) {
  const [events, setEvents] = useState(initialEvents);
  const [type, setType] = useState("");
  const [value, setValue] = useState("1");
  const [busy, setBusy] = useState(false);

  const stats = useMemo(() => {
    const totalValue = events.reduce((s, e) => s + e.value, 0);
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + e.value;
    const types = Object.keys(byType);
    const topType = types.sort((a, b) => byType[b] - byType[a])[0] || "—";
    return { totalCount: events.length, totalValue, distinctTypes: types.length, topType };
  }, [events]);

  async function record(e) {
    e.preventDefault();
    const t = type.trim();
    if (!t) return;
    const v = Number(value);
    setBusy(true);
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: t, value: Number.isFinite(v) ? v : 1 }),
    });
    if (res.ok) {
      const ev = await res.json();
      setEvents((prev) => [ev, ...prev].slice(0, 50));
      setType("");
      setValue("1");
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
      <h2>Record an event</h2>
      <form onSubmit={record} className="row">
        <input
          className="type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="Event type (e.g. page_view, signup)"
          aria-label="Event type"
        />
        <input
          className="value"
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          aria-label="Event value"
        />
        <button type="submit" disabled={busy}>Record</button>
      </form>
      <p className="hint">
        Live totals: {stats.totalCount} events · {stats.totalValue} total value ·{" "}
        {stats.distinctTypes} types · top “{stats.topType}”.
      </p>

      <h2>Recent events</h2>
      <table>
        <thead>
          <tr><th>Type</th><th className="num">Value</th><th>At</th><th></th></tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr><td className="empty" colSpan={4}>No events yet — record one above.</td></tr>
          )}
          {events.map((e) => (
            <tr key={e.id}>
              <td>{e.type}</td>
              <td className="num">{e.value}</td>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td className="num">
                <button type="button" onClick={() => remove(e.id)} disabled={busy}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
