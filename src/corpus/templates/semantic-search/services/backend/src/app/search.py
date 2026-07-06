"""CloudGrid-native hybrid search over Mongo.

Modes blended in one query:
  - lexical/exact : Mongo $text index over chunks.content (+ synonym expansion)
  - semantic      : in-app cosine similarity (NumPy) over chunk embedding arrays
  - metadata      : Mongo filters on documents (date, collection)

Results aggregate to the document level; each result carries its single best
matching passage with a highlight. Counting questions use countDocuments.

Everything degrades gracefully:
  - no embeddings / no query vector -> semantic score = 0, lexical carries it
  - no $text index yet (empty catalog) -> lexical contributes nothing, no 500
  - empty catalog -> empty results + a clear reason
"""
from __future__ import annotations

import re

import numpy as np
from pymongo.errors import OperationFailure

from . import config, db, embeddings


def _synonyms() -> dict[str, list[str]]:
    doc = db.settings().find_one({"_id": "synonyms"}) or {}
    return doc.get("map", {})


def _expand_query(q: str) -> str:
    syn = _synonyms()
    extra: list[str] = []
    for token in q.split():
        for alt in syn.get(token, []):
            extra.append(alt)
    return q if not extra else q + " " + " ".join(extra)


def _metadata_filter(collection: str | None, date_from: str | None, date_to: str | None) -> dict:
    f: dict = {}
    if collection:
        f["collection"] = collection
    date_clause: dict = {}
    if date_from:
        date_clause["$gte"] = date_from
    if date_to:
        date_clause["$lte"] = date_to
    if date_clause:
        f["date"] = date_clause
    return f


def _cosine(query_vec: np.ndarray, mat: np.ndarray) -> np.ndarray:
    if mat.size == 0:
        return np.array([])
    qn = query_vec / (np.linalg.norm(query_vec) + 1e-9)
    norms = np.linalg.norm(mat, axis=1) + 1e-9
    return (mat @ qn) / norms


def _highlight(content: str, query: str) -> str:
    terms = [t for t in re.split(r"\s+", query.strip()) if len(t) >= 2]
    highlighted = content
    for t in sorted(set(terms), key=len, reverse=True):
        highlighted = re.sub(
            f"({re.escape(t)})", r"«\1»", highlighted, flags=re.IGNORECASE
        )
    return highlighted


def count_documents(collection: str | None = None,
                    date_from: str | None = None,
                    date_to: str | None = None) -> int:
    """Direct count from the DB (countDocuments), not estimated from results."""
    return db.documents().count_documents(_metadata_filter(collection, date_from, date_to))


def search(query: str,
           mode: str = "hybrid",
           collection: str | None = None,
           date_from: str | None = None,
           date_to: str | None = None,
           limit: int = 20) -> dict:
    """Blended search. mode in {hybrid, lexical, semantic, metadata}."""
    meta_filter = _metadata_filter(collection, date_from, date_to)

    # Candidate documents after metadata pre-filter (shrinks the semantic set).
    doc_ids = None
    if meta_filter:
        doc_ids = [d["_id"] for d in db.documents().find(meta_filter, {"_id": 1})]
        if not doc_ids:
            return {"results": [], "total_matching_documents": 0, "mode": mode,
                    "note": "No documents match the metadata filter."}

    # Pure metadata browse (no text query).
    if mode == "metadata" or not query.strip():
        return _metadata_only(meta_filter, limit)

    chunk_scope: dict = {}
    if doc_ids is not None:
        chunk_scope["document_id"] = {"$in": doc_ids}

    # ── lexical score via $text ──────────────────────────────────────────────
    lexical: dict = {}  # chunk_id -> (score, content, document_id)
    if mode in ("hybrid", "lexical"):
        expanded = _expand_query(query)
        try:
            cursor = db.chunks().find(
                {**chunk_scope, "$text": {"$search": expanded}},
                {"content": 1, "document_id": 1, "score": {"$meta": "textScore"}},
            ).sort([("score", {"$meta": "textScore"})]).limit(500)
            for c in cursor:
                lexical[c["_id"]] = (float(c.get("score", 0.0)), c["content"], c["document_id"])
        except OperationFailure:
            # No text index yet (empty catalog, not indexed) — lexical contributes
            # nothing rather than 500ing. ensure_indexes() at startup normally
            # prevents this; this is belt-and-suspenders.
            pass

    # ── semantic score via in-app cosine ─────────────────────────────────────
    semantic: dict = {}  # chunk_id -> (score, content, document_id)
    semantic_note = None
    if mode in ("hybrid", "semantic"):
        if not config.embeddings_configured():
            semantic_note = "Semantic search unavailable (embeddings not configured)."
        else:
            try:
                qvec = np.array(embeddings.embed_one(query), dtype=np.float32)
                candidate = db.chunks().find(
                    {**chunk_scope, "embedding": {"$ne": None}},
                    {"content": 1, "document_id": 1, "embedding": 1},
                ).limit(50000)
                ids, contents, dids, mat = [], [], [], []
                for c in candidate:
                    ids.append(c["_id"])
                    contents.append(c["content"])
                    dids.append(c["document_id"])
                    mat.append(c["embedding"])
                if mat:
                    sims = _cosine(qvec, np.array(mat, dtype=np.float32))
                    for cid, content, did, s in zip(ids, contents, dids, sims):
                        semantic[cid] = (float(s), content, did)
            except Exception as exc:  # noqa: BLE001
                semantic_note = f"Semantic search degraded: {exc}"

    # ── normalize + blend at the chunk level ─────────────────────────────────
    def _normalize(d: dict) -> dict:
        if not d:
            return {}
        vals = [v[0] for v in d.values()]
        lo, hi = min(vals), max(vals)
        span = (hi - lo) or 1.0
        return {k: (v[0] - lo) / span for k, v in d.items()}

    lex_n = _normalize(lexical)
    sem_n = _normalize(semantic)
    sw, kw = config.semantic_weight(), config.keyword_weight()
    if mode == "lexical":
        sw, kw = 0.0, 1.0
    elif mode == "semantic":
        sw, kw = 1.0, 0.0

    blended: dict = {}  # chunk_id -> (score, content, document_id)
    for cid in set(lex_n) | set(sem_n):
        content, did = (lexical.get(cid) or semantic.get(cid))[1:3]
        score = sw * sem_n.get(cid, 0.0) + kw * lex_n.get(cid, 0.0)
        blended[cid] = (score, content, did)

    # ── aggregate to document level: keep best passage per document ──────────
    best_per_doc: dict = {}  # document_id -> (score, content, chunk_id)
    for cid, (score, content, did) in blended.items():
        cur = best_per_doc.get(did)
        if cur is None or score > cur[0]:
            best_per_doc[did] = (score, content, cid)

    ranked = sorted(best_per_doc.items(), key=lambda kv: kv[1][0], reverse=True)[:limit]

    results = []
    for did, (score, content, cid) in ranked:
        doc = db.documents().find_one({"_id": did})
        if not doc:
            continue
        results.append({
            "document_id": str(did),
            "title": doc.get("title"),
            "collection": doc.get("collection"),
            "date": doc.get("date"),
            "has_media": doc.get("has_media", False),
            "score": round(score, 4),
            "best_passage": _highlight(content, query),
            "source_filename": doc.get("source_filename"),
        })

    return {
        "results": results,
        "total_matching_documents": len(best_per_doc),
        "mode": mode,
        "note": semantic_note,
    }


def _metadata_only(meta_filter: dict, limit: int) -> dict:
    cursor = db.documents().find(meta_filter).sort("date", -1).limit(limit)
    results = []
    for doc in cursor:
        results.append({
            "document_id": str(doc["_id"]),
            "title": doc.get("title"),
            "collection": doc.get("collection"),
            "date": doc.get("date"),
            "has_media": doc.get("has_media", False),
            "score": None,
            "best_passage": None,
            "source_filename": doc.get("source_filename"),
        })
    return {
        "results": results,
        "total_matching_documents": db.documents().count_documents(meta_filter),
        "mode": "metadata",
        "note": None,
    }
