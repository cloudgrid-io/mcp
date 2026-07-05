"use client";

// Small client component: renders the conversation and posts new messages to
// /api/chat. The route calls the grid AI gateway, persists the exchange, and
// returns the reply.
import { useState } from "react";

export default function Chat({ initialHistory }) {
  const [history, setHistory] = useState(initialHistory);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setHistory((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content: value }]);
    setText("");
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: value }),
    });
    if (res.ok) {
      const { reply } = await res.json();
      setHistory((prev) => [...prev, { id: `local-${Date.now()}-a`, role: "assistant", content: reply }]);
    } else {
      setHistory((prev) => [
        ...prev,
        { id: `local-${Date.now()}-e`, role: "assistant", content: "Something went wrong. Try again." },
      ]);
    }
    setBusy(false);
  }

  return (
    <div>
      <ul className="log">
        {history.length === 0 && <li className="empty">Say hello to start the conversation.</li>}
        {history.map((m) => (
          <li key={m.id} className={m.role}>
            <span className="who">{m.role === "user" ? "You" : "Assistant"}</span>
            <span className="msg">{m.content}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={send} className="row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask something…"
          aria-label="Message"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>{busy ? "…" : "Send"}</button>
      </form>
    </div>
  );
}
