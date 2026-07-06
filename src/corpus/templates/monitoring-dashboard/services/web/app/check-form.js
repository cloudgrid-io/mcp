"use client";

// Small client component: renders the current-status grid + recent history and
// posts new checks to /api/checks. Recomputes the per-service grid on the client
// after each POST so the board updates without a full refresh.
import { useState } from "react";

const STATUSES = ["up", "degraded", "down"];

function computeServices(checks) {
  const seen = new Map();
  for (const c of checks) {
    if (!seen.has(c.service)) seen.set(c.service, c);
  }
  return [...seen.values()].sort((a, b) => a.service.localeCompare(b.service));
}

function fmt(at) {
  const d = new Date(at);
  return isNaN(d) ? at : d.toLocaleString();
}

export default function CheckForm({ initialChecks, initialServices }) {
  const [checks, setChecks] = useState(initialChecks);
  const [services, setServices] = useState(initialServices);
  const [service, setService] = useState("");
  const [status, setStatus] = useState("up");
  const [latency, setLatency] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const name = service.trim();
    if (!name) return;
    setBusy(true);
    const res = await fetch("/api/checks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: name,
        status,
        latencyMs: latency === "" ? undefined : Number(latency),
      }),
    });
    if (res.ok) {
      const check = await res.json();
      const next = [check, ...checks];
      setChecks(next);
      setServices(computeServices(next));
      setService("");
      setLatency("");
    }
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input
          className="service"
          value={service}
          onChange={(e) => setService(e.target.value)}
          placeholder="Service name (e.g. api, web, db)…"
          aria-label="Service name"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          className="latency"
          type="number"
          min="0"
          value={latency}
          onChange={(e) => setLatency(e.target.value)}
          placeholder="Latency ms"
          aria-label="Latency in milliseconds"
        />
        <button type="submit" disabled={busy}>Record check</button>
      </form>

      <h2>Current status</h2>
      <div className="grid">
        {services.length === 0 && <div className="empty">No services checked yet.</div>}
        {services.map((s) => (
          <div className="card" key={s.service}>
            <div className="name">{s.service}</div>
            <div><span className={`badge ${s.status}`}>{s.status}</span></div>
            <div className="meta">
              {typeof s.latencyMs === "number" ? `${s.latencyMs} ms · ` : ""}
              {fmt(s.at)}
            </div>
          </div>
        ))}
      </div>

      <h2>Recent history</h2>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>Status</th>
            <th>Latency</th>
            <th>At</th>
          </tr>
        </thead>
        <tbody>
          {checks.length === 0 && (
            <tr><td className="empty" colSpan={4}>No checks recorded yet.</td></tr>
          )}
          {checks.map((c) => (
            <tr key={c.id}>
              <td>{c.service}</td>
              <td><span className={`badge ${c.status}`}>{c.status}</span></td>
              <td>{typeof c.latencyMs === "number" ? `${c.latencyMs} ms` : "—"}</td>
              <td>{fmt(c.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
