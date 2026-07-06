"""Grounded answer mode.

Composes an answer from the indexed documents ONLY, with citations back to the
documents used. No outside knowledge. Toggleable from Settings. If the answer LLM
is not configured, it falls back to an extractive answer (the top passages
themselves), still grounded and cited — never crashes.
"""
from __future__ import annotations

import httpx

from . import config, search


def _answer_enabled_from_db() -> bool:
    from . import db

    doc = db.settings().find_one({"_id": "features"}) or {}
    return bool(doc.get("answer_mode_enabled", True))


def compose_answer(question: str) -> dict:
    """Return a grounded answer + the documents cited. Extractive fallback if no LLM."""
    if not _answer_enabled_from_db():
        return {"answer": None, "citations": [], "note": "Answer mode is disabled."}

    hits = search.search(question, mode="hybrid", limit=5)
    passages = hits["results"]
    if not passages:
        return {
            "answer": None,
            "citations": [],
            "note": "No indexed material matches this question.",
        }

    citations = [
        {"document_id": p["document_id"], "title": p["title"], "collection": p["collection"]}
        for p in passages
    ]

    # Grounded generation only if the LLM key is present; otherwise return an
    # extractive answer built from the retrieved passages.
    key = config.embeddings_api_key()
    if not key:
        extractive = "\n\n".join(
            f"- {p['title']}: {p['best_passage']}" for p in passages[:3]
        )
        return {
            "answer": extractive,
            "citations": citations,
            "mode": "extractive",
            "note": "Grounded generation unavailable (no API key) — showing "
                    "the most relevant source passages instead.",
        }

    context = "\n\n".join(
        f"[{i+1}] {p['title']}:\n{p['best_passage']}" for i, p in enumerate(passages)
    )
    system = (
        "You answer strictly and only from the provided document passages. "
        "Cite sources as [n]. If the passages do not contain the answer, say so. "
        "Never use outside knowledge."
    )
    try:
        resp = httpx.post(
            f"{config.embeddings_base_url()}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": config.answer_model(),
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": f"Question: {question}\n\nSources:\n{context}"},
                ],
                "temperature": 0.2,
            },
            timeout=60.0,
        )
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
        return {"answer": text, "citations": citations, "mode": "generated", "note": None}
    except Exception as exc:  # noqa: BLE001 - degrade to extractive, never crash
        extractive = "\n\n".join(
            f"- {p['title']}: {p['best_passage']}" for p in passages[:3]
        )
        return {
            "answer": extractive,
            "citations": citations,
            "mode": "extractive",
            "note": f"Generation failed ({exc}); showing source passages.",
        }
