// Backend base URL baked in at build time. The backend is mounted at /backend on
// the same entity, so same-origin "" works in production. Override with
// VITE_BACKEND_URL for split-origin local dev.
const BASE = import.meta.env.VITE_BACKEND_URL || "";

function url(path) {
  return `${BASE}${path}`;
}

let token = localStorage.getItem("mgr_token") || null;
export function setToken(t) {
  token = t;
  if (t) localStorage.setItem("mgr_token", t);
  else localStorage.removeItem("mgr_token");
}
export function isLoggedIn() {
  return !!token;
}
function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getStatus() {
  const r = await fetch(url("/backend/status"));
  return r.json();
}

export async function search(params) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== "" && v != null)
  );
  const r = await fetch(url(`/backend/search?${qs}`));
  return r.json();
}

export async function count(params) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== "" && v != null)
  );
  const r = await fetch(url(`/backend/count?${qs}`));
  return r.json();
}

export async function listCollections() {
  const r = await fetch(url("/backend/collections"));
  return r.json();
}

export async function answer(question) {
  const r = await fetch(url("/backend/answer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return r.json();
}

export function downloadUrl(documentId) {
  return url(`/backend/documents/${documentId}/download`);
}

// ── manager ──
export async function login(password) {
  const r = await fetch(url("/backend/admin/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error((await r.json()).detail || "Login failed");
  const data = await r.json();
  setToken(data.token);
  return data;
}

export async function getSettings() {
  const r = await fetch(url("/backend/admin/settings"), { headers: authHeaders() });
  if (!r.ok) throw new Error("Not authorized");
  return r.json();
}

export async function updateSettings(body) {
  const r = await fetch(url("/backend/admin/settings"), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function updateSynonyms(map) {
  const r = await fetch(url("/backend/admin/synonyms"), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ map }),
  });
  return r.json();
}

export async function changePassword(current, nw) {
  const r = await fetch(url("/backend/admin/password"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ current, new: nw }),
  });
  return r.json();
}

export async function indexReport() {
  const r = await fetch(url("/backend/admin/index-report"), { headers: authHeaders() });
  return r.json();
}

export async function refreshNow() {
  const r = await fetch(url("/backend/admin/refresh"), {
    method: "POST",
    headers: authHeaders(),
  });
  return r.json();
}

export async function usage() {
  const r = await fetch(url("/backend/admin/usage"), { headers: authHeaders() });
  if (!r.ok) throw new Error("Not authorized");
  return r.json();
}
