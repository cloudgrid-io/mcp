"use client";

// Client component: derives the header metrics (count, avg ms, error rate) from
// the request log, renders a record form that POSTs to /api/requests, a recent
// table, and per-row delete (DELETE /api/requests?id=...).
import { useState } from "react";

function computeMetrics(requests) {
  const count = requests.length;
  if (count === 0) return { count: 0, avgMs: 0, errorRate: 0 };
  const totalMs = requests.reduce((sum, r) => sum + (Number(r.ms) || 0), 0);
  const errors = requests.filter((r) => Number(r.status) >= 400).length;
  return {
    count,
    avgMs: Math.round(totalMs / count),
    errorRate: Math.round((errors / count) * 1000) / 10,
  };
}

export default function Dashboard({ initialRequests }) {
  const [requests, setRequests] = useState(initialRequests);
  const [endpoint, setEndpoint] = useState("");
  const [status, setStatus] = useState("200");
  const [ms, setMs] = useState("");
  const [busy, setBusy] = useState(false);

  const metrics = computeMetrics(requests);

  async function record(e) {
    e.preventDefault();
    const path = endpoint.trim();
    if (!path) return;
    setBusy(true);
    const res = await fetch("/api/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: path,
        status: Number(status),
        ms: Number(ms) || 0,
      }),
    });
    if (res.ok) {
      const row = await res.json();
      setRequests((prev) => [row, ...prev].slice(0, 50));
      setEndpoint("");
      setMs("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/requests?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) setRequests((prev) => prev.filter((r) => r.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <div className="metrics">
        <div className="metric">
          <div className="label">Requests</div>
          <div className="value">{metrics.count}</div>
        </div>
        <div className="metric">
          <div className="label">Avg latency</div>
          <div className="value">{metrics.avgMs} ms</div>
        </div>
        <div className="metric">
          <div className="label">Error rate</div>
          <div className="value">{metrics.errorRate}%</div>
        </div>
      </div>

      <form onSubmit={record} className="row">
        <input
          className="endpoint"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="/api/endpoint"
          aria-label="Endpoint"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status code"
        >
          <option value="200">200</option>
          <option value="201">201</option>
          <option value="204">204</option>
          <option value="301">301</option>
          <option value="400">400</option>
          <option value="401">401</option>
          <option value="403">403</option>
          <option value="404">404</option>
          <option value="429">429</option>
          <option value="500">500</option>
          <option value="503">503</option>
        </select>
        <input
          type="number"
          min="0"
          value={ms}
          onChange={(e) => setMs(e.target.value)}
          placeholder="ms"
          aria-label="Latency in ms"
          style={{ width: "6rem" }}
        />
        <button type="submit" disabled={busy}>
          Record
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Status</th>
              <th>Latency</th>
              <th>When</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {requests.length === 0 && (
              <tr>
                <td className="empty" colSpan={5}>
                  No requests recorded yet.
                </td>
              </tr>
            )}
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{r.endpoint}</td>
                <td className={Number(r.status) >= 400 ? "status-err" : "status-ok"}>
                  {r.status}
                </td>
                <td>{r.ms} ms</td>
                <td>{new Date(r.at).toLocaleString()}</td>
                <td className="actions">
                  <button type="button" onClick={() => remove(r.id)} disabled={busy}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
