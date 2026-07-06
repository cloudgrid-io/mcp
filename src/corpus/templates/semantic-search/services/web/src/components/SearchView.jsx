import React, { useEffect, useState } from "react";
import * as api from "../api.js";

const MODES = [
  { id: "hybrid", label: "Hybrid" },
  { id: "lexical", label: "Exact / keyword" },
  { id: "semantic", label: "Semantic" },
  { id: "metadata", label: "By date / collection" },
];

// Render «...» highlight markers from the backend as <mark>.
function Passage({ text }) {
  if (!text) return null;
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <div className="passage">
      {parts.map((p, i) =>
        p.startsWith("«") && p.endsWith("»") ? (
          <mark key={i}>{p.slice(1, -1)}</mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </div>
  );
}

export default function SearchView({ status }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [collection, setCollection] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [collectionList, setCollectionList] = useState([]);
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [answerMode, setAnswerMode] = useState(false);
  const [answerRes, setAnswerRes] = useState(null);

  useEffect(() => {
    api.listCollections().then((d) => setCollectionList(d.collections || [])).catch(() => {});
  }, []);

  async function runSearch(e) {
    e && e.preventDefault();
    setLoading(true);
    setAnswerRes(null);
    try {
      if (answerMode && q.trim()) {
        setAnswerRes(await api.answer(q));
      }
      const params = { q, mode, collection, date_from: dateFrom, date_to: dateTo };
      setRes(await api.search(params));
    } finally {
      setLoading(false);
    }
  }

  const notIndexed = status && status.indexed_documents === 0;
  const answerEnabled = status && status.answer_mode_enabled;

  return (
    <div>
      {status && !status.mongo && (
        <div className="banner">The service is not connected to the database right now.</div>
      )}
      {notIndexed && status.mongo && (
        <div className="banner">
          The catalog is not indexed yet
          {!status.source_configured &&
            ` (source "${status.source_type}" is not configured)`}
          {status.source_configured && !status.embeddings_configured &&
            " — semantic search will be available once the embeddings key is set"}
          .
        </div>
      )}

      <form className="card" onSubmit={runSearch}>
        <div className="searchbar">
          <input
            type="text"
            placeholder="Search a word, phrase, or idea…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="modes">
          {MODES.map((m) => (
            <span
              key={m.id}
              className={`chip ${mode === m.id ? "active" : ""}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </span>
          ))}
        </div>

        <div className="filters">
          <select value={collection} onChange={(e) => setCollection(e.target.value)}>
            <option value="">All collections</option>
            {collectionList.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>

        {answerEnabled && (
          <div className="toggle" style={{ marginTop: 12 }}>
            <input
              id="answerMode"
              type="checkbox"
              checked={answerMode}
              onChange={(e) => setAnswerMode(e.target.checked)}
            />
            <label htmlFor="answerMode">Grounded answer mode</label>
          </div>
        )}
      </form>

      {answerRes && (
        <div className="card">
          <h3>Grounded answer</h3>
          {answerRes.answer ? (
            <>
              <div className="answer-box">{answerRes.answer}</div>
              <div className="citations">
                Sources: {answerRes.citations.map((c) => c.title).join(" · ")}
              </div>
            </>
          ) : (
            <p className="note">{answerRes.note}</p>
          )}
        </div>
      )}

      {res && (
        <div className="card">
          <div className="note" style={{ marginBottom: 10 }}>
            {res.total_matching_documents} matching documents
            {res.note ? ` — ${res.note}` : ""}
          </div>
          {res.results.length === 0 && <p className="note">No results found.</p>}
          {res.results.map((r) => (
            <div className="result" key={r.document_id}>
              <h3>{r.title}</h3>
              <div className="meta">
                {r.collection && <span>Collection: {r.collection} · </span>}
                {r.date && <span>{r.date} · </span>}
                {r.has_media && <span>🎧 media · </span>}
                <a href={api.downloadUrl(r.document_id)}>Download text</a>
              </div>
              <Passage text={r.best_passage} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
