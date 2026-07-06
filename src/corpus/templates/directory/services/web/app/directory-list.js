"use client";

// Client component: renders the directory list, provides live search + category
// filtering, and adds/removes entries via /api/entries.
import { useMemo, useState } from "react";

export default function DirectoryList({ initialEntries }) {
  const [entries, setEntries] = useState(initialEntries);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [busy, setBusy] = useState(false);

  const categories = useMemo(() => {
    const set = new Set(entries.map((e) => e.category).filter(Boolean));
    return Array.from(set).sort();
  }, [entries]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filterCat && e.category !== filterCat) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.url.toLowerCase().includes(q)
      );
    });
  }, [entries, query, filterCat]);

  async function add(e) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: value,
        category: category.trim(),
        url: url.trim(),
        description: description.trim(),
      }),
    });
    if (res.ok) {
      const entry = await res.json();
      setEntries((prev) => [entry, ...prev]);
      setName("");
      setCategory("");
      setUrl("");
      setDescription("");
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/entries?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) setEntries((prev) => prev.filter((e) => e.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={add} className="add">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          aria-label="Name"
        />
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category"
          aria-label="Category"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="URL (https://…)"
          aria-label="URL"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          aria-label="Description"
        />
        <div className="actions">
          <button type="submit" disabled={busy}>Add entry</button>
        </div>
      </form>

      <div className="filters">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search"
        />
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      <ul>
        {visible.length === 0 && <li className="empty">No entries match.</li>}
        {visible.map((e) => (
          <li key={e.id}>
            <div className="entry-main">
              <div className="entry-head">
                <span className="entry-name">{e.name}</span>
                {e.category && <span className="cat">{e.category}</span>}
              </div>
              {e.url && (
                <a className="entry-url" href={e.url} target="_blank" rel="noreferrer">
                  {e.url}
                </a>
              )}
              {e.description && <p className="entry-desc">{e.description}</p>}
            </div>
            <button type="button" onClick={() => remove(e.id)} disabled={busy}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
