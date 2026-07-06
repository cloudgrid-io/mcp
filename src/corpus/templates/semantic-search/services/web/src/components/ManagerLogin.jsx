import React, { useState } from "react";
import * as api from "../api.js";

export default function ManagerLogin({ onLoggedIn }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.login(password);
      onLoggedIn();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Manager sign-in</h3>
      <label className="field">Password</label>
      <input
        className="text-input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {err && <p className="note" style={{ color: "#b00" }}>{err}</p>}
      <div style={{ marginTop: 12 }}>
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </div>
    </form>
  );
}
