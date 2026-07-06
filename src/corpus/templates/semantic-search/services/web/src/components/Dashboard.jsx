import React, { useEffect, useState } from "react";
import * as api from "../api.js";

export default function Dashboard() {
  const [u, setU] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.usage().then(setU).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="card note">{err}</div>;
  if (!u) return <div className="card">Loading…</div>;

  return (
    <div>
      <div className="card">
        <h3>Usage overview</h3>
        <div className="stat-grid">
          <div className="stat"><div className="num">{u.total_searches}</div><div className="lbl">Searches</div></div>
          <div className="stat"><div className="num">{u.unique_users}</div><div className="lbl">Unique users</div></div>
          <div className="stat"><div className="num">{u.indexed_documents}</div><div className="lbl">Indexed documents</div></div>
        </div>
        <p className="note">Last refresh: {u.last_refresh || "never"}</p>
      </div>

      <div className="card">
        <h3>Searches by mode</h3>
        <table className="usage">
          <tbody>
            {Object.entries(u.by_mode || {}).map(([mode, n]) => (
              <tr key={mode}><td>{mode}</td><td>{n}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Top queries</h3>
        <table className="usage">
          <tbody>
            {(u.top_queries || []).map((q, i) => (
              <tr key={i}><td>{q.query}</td><td>{q.count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Zero-result queries</h3>
        <table className="usage">
          <tbody>
            {(u.zero_result_queries || []).map((q, i) => (
              <tr key={i}><td>{q.query}</td><td>{q.count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
