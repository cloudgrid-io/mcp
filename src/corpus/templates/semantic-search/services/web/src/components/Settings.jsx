import React, { useEffect, useState } from "react";
import * as api from "../api.js";

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [synonymsText, setSynonymsText] = useState("");
  const [report, setReport] = useState(null);
  const [msg, setMsg] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pw, setPw] = useState({ current: "", nw: "" });
  const [pwResult, setPwResult] = useState(null);

  async function load() {
    const s = await api.getSettings();
    setSettings(s);
    setSynonymsText(
      Object.entries(s.synonyms || {})
        .map(([k, v]) => `${k}: ${v.join(", ")}`)
        .join("\n")
    );
    setReport(await api.indexReport());
  }
  useEffect(() => {
    load().catch((e) => setMsg(e.message));
  }, []);

  async function saveFeatures() {
    await api.updateSettings({ answer_mode_enabled: settings.answer_mode_enabled });
    setMsg("Settings saved");
  }

  async function saveSynonyms() {
    const map = {};
    synonymsText.split("\n").forEach((line) => {
      const [k, rest] = line.split(":");
      if (k && rest) map[k.trim()] = rest.split(",").map((x) => x.trim()).filter(Boolean);
    });
    await api.updateSynonyms(map);
    setMsg("Synonyms saved");
  }

  async function doRefresh() {
    setRefreshing(true);
    try {
      await api.refreshNow();
      setReport(await api.indexReport());
      setMsg("Sync complete");
    } finally {
      setRefreshing(false);
    }
  }

  async function doChangePassword() {
    const r = await api.changePassword(pw.current, pw.nw);
    setPwResult(r);
  }

  if (!settings) return <div className="card">{msg || "Loading…"}</div>;

  return (
    <div>
      {msg && <div className="banner">{msg}</div>}

      <div className="card">
        <h3>Index</h3>
        <p className="note">
          Re-index new and changed documents from the configured source. This is
          the supported refresh path today. A scheduled (cron) refresh is a
          follow-up, blocked on a platform issue — see AGENTS.md.
        </p>
        <button onClick={doRefresh} disabled={refreshing}>
          {refreshing ? "Syncing…" : "Refresh now"}
        </button>
        <p className="note">Last refresh: {settings.last_refresh || "never"}</p>
      </div>

      <div className="card">
        <h3>Answer mode</h3>
        <div className="toggle">
          <input
            id="am"
            type="checkbox"
            checked={settings.answer_mode_enabled}
            onChange={(e) => setSettings({ ...settings, answer_mode_enabled: e.target.checked })}
          />
          <label htmlFor="am">Enable grounded answer mode</label>
        </div>
        <button className="ghost" onClick={saveFeatures} style={{ marginTop: 8 }}>Save</button>
      </div>

      <div className="card">
        <h3>Synonyms</h3>
        <p className="note">One line per term, format: <code>term: synonym1, synonym2</code></p>
        <textarea
          className="text-input"
          rows={5}
          value={synonymsText}
          onChange={(e) => setSynonymsText(e.target.value)}
        />
        <button className="ghost" onClick={saveSynonyms} style={{ marginTop: 8 }}>Save synonyms</button>
      </div>

      <div className="card">
        <h3>Index report</h3>
        {report && report.reports && report.reports.length > 0 ? (
          report.reports.slice(0, 1).map((rep, i) => (
            <div key={i}>
              <p className="note">
                {rep.status} — {rep.started_at}
                {rep.note ? ` — ${rep.note}` : ""}
              </p>
              <table className="usage">
                <tbody>
                  {(rep.files || []).slice(0, 50).map((f, j) => (
                    <tr key={j}>
                      <td>{f.file}</td>
                      <td>{f.result}</td>
                      <td>{f.chunks ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        ) : (
          <p className="note">No reports yet.</p>
        )}
      </div>

      <div className="card">
        <h3>Change password</h3>
        <label className="field">Current password</label>
        <input className="text-input" type="password"
          value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        <label className="field">New password</label>
        <input className="text-input" type="password"
          value={pw.nw} onChange={(e) => setPw({ ...pw, nw: e.target.value })} />
        <button className="ghost" onClick={doChangePassword} style={{ marginTop: 8 }}>Change password</button>
        {pwResult && (
          <div className="banner" style={{ marginTop: 10 }}>
            <div>{pwResult.note}</div>
            <code style={{ wordBreak: "break-all" }}>MANAGER_PASSWORD_HASH={pwResult.new_hash}</code>
          </div>
        )}
      </div>
    </div>
  );
}
