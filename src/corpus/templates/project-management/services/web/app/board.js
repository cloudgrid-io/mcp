"use client";

// Client component: renders the project list plus a per-project task board with
// three status columns (todo / doing / done). Talks to /api/projects and
// /api/tasks. Kept self-contained — no external UI libraries.
import { useState } from "react";

const STATUSES = ["todo", "doing", "done"];
const LABELS = { todo: "To do", doing: "Doing", done: "Done" };

export default function Board({ initialProjects, initialSelectedId, initialTasks }) {
  const [projects, setProjects] = useState(initialProjects);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [tasks, setTasks] = useState(initialTasks);
  const [projectName, setProjectName] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadTasks(projectId) {
    const res = await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
    if (res.ok) setTasks(await res.json());
    else setTasks([]);
  }

  async function selectProject(id) {
    setSelectedId(id);
    await loadTasks(id);
  }

  async function addProject(e) {
    e.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    setBusy(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const project = await res.json();
      setProjects((prev) => [project, ...prev]);
      setProjectName("");
      setSelectedId(project.id);
      setTasks([]);
    }
    setBusy(false);
  }

  async function removeProject(id) {
    setBusy(true);
    const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      const next = projects.filter((p) => p.id !== id);
      setProjects(next);
      if (selectedId === id) {
        const fallback = next[0] ? next[0].id : null;
        setSelectedId(fallback);
        if (fallback) await loadTasks(fallback);
        else setTasks([]);
      }
    }
    setBusy(false);
  }

  async function addTask(e) {
    e.preventDefault();
    const title = taskTitle.trim();
    if (!title || !selectedId) return;
    setBusy(true);
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: selectedId, title, assignee: taskAssignee.trim() }),
    });
    if (res.ok) {
      const task = await res.json();
      setTasks((prev) => [task, ...prev]);
      setTaskTitle("");
      setTaskAssignee("");
    }
    setBusy(false);
  }

  async function moveTask(id, status) {
    setBusy(true);
    const res = await fetch(`/api/tasks?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    setBusy(false);
  }

  async function removeTask(id) {
    setBusy(true);
    const res = await fetch(`/api/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setTasks((prev) => prev.filter((t) => t.id !== id));
    setBusy(false);
  }

  return (
    <div>
      <form onSubmit={addProject} className="row">
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="New project name…"
          aria-label="New project name"
        />
        <button type="submit" disabled={busy}>Add project</button>
      </form>

      <ul className="projects">
        {projects.length === 0 && <li className="empty">No projects yet.</li>}
        {projects.map((p) => (
          <li key={p.id} className={p.id === selectedId ? "active" : ""}>
            <span className="name" onClick={() => selectProject(p.id)}>{p.name}</span>
            <button type="button" onClick={() => removeProject(p.id)} disabled={busy}>Delete</button>
          </li>
        ))}
      </ul>

      {selectedId && (
        <>
          <h2>Tasks</h2>
          <form onSubmit={addTask} className="row">
            <input
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="Task title…"
              aria-label="Task title"
            />
            <input
              value={taskAssignee}
              onChange={(e) => setTaskAssignee(e.target.value)}
              placeholder="Assignee (optional)"
              aria-label="Assignee"
            />
            <button type="submit" disabled={busy}>Add task</button>
          </form>

          <div className="board">
            {STATUSES.map((status) => (
              <div className="col" key={status}>
                <h3>{LABELS[status]}</h3>
                {tasks.filter((t) => t.status === status).length === 0 && (
                  <p className="hint">Nothing here.</p>
                )}
                {tasks
                  .filter((t) => t.status === status)
                  .map((t) => (
                    <div className="card" key={t.id}>
                      <div className="title">{t.title}</div>
                      {t.assignee && <div className="assignee">{t.assignee}</div>}
                      <div className="actions">
                        {STATUSES.filter((s) => s !== status).map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => moveTask(t.id, s)}
                            disabled={busy}
                          >
                            → {LABELS[s]}
                          </button>
                        ))}
                        <button type="button" onClick={() => removeTask(t.id)} disabled={busy}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
