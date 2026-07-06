"use client";

// Client component: renders the take-quiz UI (pick one option per question,
// submit to compute a score), plus an admin form that POSTs new questions to
// /api/questions and a delete control per question.
import { useState } from "react";

export default function Quiz({ initialQuestions }) {
  const [questions, setQuestions] = useState(initialQuestions);
  const [answers, setAnswers] = useState({}); // questionId -> chosen option index
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  // admin form state
  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [answerIndex, setAnswerIndex] = useState(0);

  function choose(qId, optIdx) {
    if (submitted) return;
    setAnswers((prev) => ({ ...prev, [qId]: optIdx }));
  }

  // Compute the score client-side against each question's answerIndex.
  const score = questions.reduce(
    (n, q) => (answers[q.id] === q.answerIndex ? n + 1 : n),
    0,
  );

  function submit(e) {
    e.preventDefault();
    setSubmitted(true);
  }

  function reset() {
    setAnswers({});
    setSubmitted(false);
  }

  async function addQuestion(e) {
    e.preventDefault();
    const cleanPrompt = prompt.trim();
    const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
    if (!cleanPrompt || cleanOptions.length < 2) return;
    const idx = Math.min(answerIndex, cleanOptions.length - 1);
    setBusy(true);
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: cleanPrompt,
        options: cleanOptions,
        answerIndex: idx,
      }),
    });
    if (res.ok) {
      const q = await res.json();
      setQuestions((prev) => [q, ...prev]);
      setPrompt("");
      setOptions(["", "", "", ""]);
      setAnswerIndex(0);
      setSubmitted(false);
    }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true);
    const res = await fetch(`/api/questions?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setQuestions((prev) => prev.filter((q) => q.id !== id));
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    setBusy(false);
  }

  function setOption(i, value) {
    setOptions((prev) => prev.map((o, j) => (j === i ? value : o)));
  }

  return (
    <div>
      <h2>Take the quiz</h2>
      {questions.length === 0 && (
        <p className="empty">No questions yet — add one below.</p>
      )}

      <form onSubmit={submit}>
        {questions.map((q) => (
          <div className="card" key={q.id}>
            <p className="prompt">{q.prompt}</p>
            <ul className="options">
              {q.options.map((opt, i) => {
                const chosen = answers[q.id] === i;
                let cls = "opt";
                if (submitted && i === q.answerIndex) cls += " correct";
                else if (submitted && chosen) cls += " wrong";
                else if (chosen) cls += " selected";
                return (
                  <li key={i}>
                    <button
                      type="button"
                      className={cls}
                      disabled={submitted}
                      onClick={() => choose(q.id, i)}
                    >
                      <span>{opt}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="row">
              <button
                type="button"
                className="del"
                onClick={() => remove(q.id)}
                disabled={busy}
              >
                Delete
              </button>
            </div>
          </div>
        ))}

        {questions.length > 0 && !submitted && (
          <button type="submit" className="primary">
            Submit quiz
          </button>
        )}
      </form>

      {submitted && (
        <div>
          <p className="score">
            Score: {score} / {questions.length}
          </p>
          <button type="button" onClick={reset}>
            Try again
          </button>
        </div>
      )}

      <h2>Add a question</h2>
      <form className="admin" onSubmit={addQuestion}>
        <div className="row">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Question prompt…"
            aria-label="Question prompt"
          />
        </div>
        {options.map((opt, i) => (
          <div className="row" key={i}>
            <input
              value={opt}
              onChange={(e) => setOption(i, e.target.value)}
              placeholder={`Option ${i + 1}`}
              aria-label={`Option ${i + 1}`}
            />
            <label className="ans">
              <input
                type="radio"
                name="answerIndex"
                checked={answerIndex === i}
                onChange={() => setAnswerIndex(i)}
                style={{ flex: "none", minWidth: 0 }}
              />
              correct
            </label>
          </div>
        ))}
        <div className="row">
          <button type="submit" className="primary" disabled={busy}>
            Add question
          </button>
        </div>
      </form>
    </div>
  );
}
