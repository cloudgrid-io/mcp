"use client";

// Small client component: renders the public list and posts to /api/jobs.
import { useState } from "react";

export default function JobBoard({ initialJobs }) {
  const [jobs, setJobs] = useState(initialJobs);
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [type, setType] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function post(e) {
    e.preventDefault();
    if (!title.trim() || !company.trim()) return;
    setBusy(true);
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, company, location, type, url }),
    });
    if (res.ok) {
      const job = await res.json();
      setJobs((prev) => [job, ...prev]);
      setTitle("");
      setCompany("");
      setLocation("");
      setType("");
      setUrl("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setJobs((prev) => prev.filter((j) => j.id !== id));
    setBusy(false);
  }

  function meta(j) {
    return [j.company, j.location, j.type].filter(Boolean).join(" · ");
  }

  return (
    <div>
      <form onSubmit={post} className="row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" aria-label="Company" />
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location" aria-label="Location" />
        <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Type (full-time…)" aria-label="Type" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Apply URL" aria-label="Apply URL" />
        <button type="submit" disabled={busy}>Post</button>
      </form>
      <ul>
        {jobs.length === 0 && <li className="empty">No open roles yet.</li>}
        {jobs.map((j) => (
          <li key={j.id}>
            <span>
              <span className="job-title">
                {j.url ? <a href={j.url} target="_blank" rel="noopener noreferrer">{j.title}</a> : j.title}
              </span>
              {meta(j) && <div className="job-meta">{meta(j)}</div>}
            </span>
            <button type="button" onClick={() => remove(j.id)} disabled={busy}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
