"""Incremental indexing pipeline: discover -> extract -> chunk -> embed -> store.

Shared by the manager 'Refresh now' endpoint (and, once platform issue #1585
lands, a `type: cron` refresh service). It is resilient: if the source or
embeddings are not configured it records a clear, non-crashing report and
returns. Only new/changed files (by rev / content-hash) are reprocessed.
"""
from __future__ import annotations

import datetime as dt
import os
import re

from . import config, db, embeddings, source

CHUNK_CHARS = 1200
CHUNK_OVERLAP = 150

# Generic date detection from filename or document head (best effort, nullable).
_DATE_RE = re.compile(r"(\d{4})[./-](\d{1,2})[./-](\d{1,2})")        # 2026-07-05
_DATE_RE_ALT = re.compile(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})")  # 05/07/2026


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _chunk_text(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    out: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + CHUNK_CHARS, n)
        out.append(text[start:end])
        if end == n:
            break
        start = end - CHUNK_OVERLAP
    return out


def _parse_metadata(name: str, text: str) -> dict:
    """Best-effort title / date / collection extraction. All fields nullable.

    Generalize this for your domain: `collection` is a free-form grouping tag
    (folder, series, category), `date` is an ISO date if one can be found.
    """
    title = os.path.splitext(name)[0].strip()
    # Collection tag = the leading non-numeric words of the title.
    collection = re.sub(r"[\d].*$", "", title).strip() or None

    date_iso = None
    haystack = f"{name}\n{text[:2000]}"
    m = _DATE_RE.search(haystack)
    if m:
        y, mo, d = m.groups()
        try:
            date_iso = dt.datetime(int(y), int(mo), int(d)).date().isoformat()
        except ValueError:
            date_iso = None
    if date_iso is None:
        m = _DATE_RE_ALT.search(haystack)
        if m:
            d, mo, y = m.groups()
            if len(y) == 2:
                y = "20" + y
            try:
                date_iso = dt.datetime(int(y), int(mo), int(d)).date().isoformat()
            except ValueError:
                date_iso = None

    return {"title": title, "collection": collection, "date": date_iso}


def run_sync(triggered_by: str = "manual") -> dict:
    """Run one incremental sync. Never raises on missing config — returns a report."""
    started = _utcnow()
    report: dict = {
        "started_at": started,
        "triggered_by": triggered_by,
        "files": [],
        "status": "ok",
        "note": None,
    }

    # Mongo is required for indexing (and always injected). Fail loud only here.
    db.ensure_indexes()

    if not config.source_configured():
        report["status"] = "skipped"
        report["note"] = (
            f"Source not configured (SOURCE_TYPE={config.source_type()!r} — "
            "missing its secrets/config)."
        )
        _save_report(report)
        return report

    try:
        src = source.get_source()
        files = src.list_files()
    except Exception as exc:  # noqa: BLE001 - resilient by design
        report["status"] = "error"
        report["note"] = f"Source listing failed: {exc}"
        _save_report(report)
        return report

    embeddings_ok = config.embeddings_configured()
    if not embeddings_ok:
        report["note"] = (
            "Embeddings not configured — documents indexed for lexical/metadata "
            "search only (no semantic vectors)."
        )

    for f in files:
        outcome = _process_file(src, f, embeddings_ok)
        report["files"].append(outcome)

    report["finished_at"] = _utcnow()
    _save_report(report)
    return report


def _process_file(src: source.Source, f: source.SourceFile, embeddings_ok: bool) -> dict:
    existing = db.documents().find_one({"source_filename": f.name})
    if existing and existing.get("source_rev") == f.rev:
        return {"file": f.name, "result": "unchanged"}

    if f.is_audio and not f.is_text:
        # Catalogue audio/media with a flag; do not search inside it.
        doc = {
            "title": os.path.splitext(f.name)[0],
            "source_filename": f.name,
            "source_rev": f.rev,
            "file_path": f.path,
            "collection": None,
            "date": None,
            "has_media": True,
            "media_path": f.path,
            "word_count": 0,
            "indexed_at": _utcnow(),
        }
        doc_id = _upsert_document(doc)
        db.chunks().delete_many({"document_id": doc_id})
        return {"file": f.name, "result": "catalogued_media"}

    if not f.is_text:
        return {"file": f.name, "result": "skipped_unsupported"}

    try:
        raw = src.download(f.path)
        text = source.extract_text(f.name, raw)
    except Exception as exc:  # noqa: BLE001
        return {"file": f.name, "result": "error", "detail": str(exc)}

    meta = _parse_metadata(f.name, text)
    doc = {
        **meta,
        "source_filename": f.name,
        "source_rev": f.rev,
        "file_path": f.path,
        "has_media": False,
        "media_path": None,
        "word_count": len(text.split()),
        "indexed_at": _utcnow(),
    }
    doc_id = _upsert_document(doc)

    # Rebuild chunks for this document.
    db.chunks().delete_many({"document_id": doc_id})
    parts = _chunk_text(text)
    vectors: list[list[float] | None] = [None] * len(parts)
    if embeddings_ok and parts:
        try:
            vectors = embeddings.embed(parts)  # type: ignore[assignment]
        except Exception as exc:  # noqa: BLE001
            return {
                "file": f.name,
                "result": "indexed_no_embeddings",
                "detail": f"embedding failed: {exc}",
                "chunks": len(parts),
            }

    docs = []
    for i, content in enumerate(parts):
        docs.append({
            "document_id": doc_id,
            "chunk_index": i,
            "content": content,
            "embedding": vectors[i] if i < len(vectors) else None,
            "token_count": len(content.split()),
        })
    if docs:
        db.chunks().insert_many(docs)

    return {
        "file": f.name,
        "result": "indexed" if embeddings_ok else "indexed_no_embeddings",
        "chunks": len(docs),
    }


def _upsert_document(doc: dict):
    db.documents().update_one(
        {"source_filename": doc["source_filename"]},
        {"$set": doc},
        upsert=True,
    )
    return db.documents().find_one({"source_filename": doc["source_filename"]})["_id"]


def _save_report(report: dict) -> None:
    try:
        db.index_reports().insert_one(dict(report))
        db.settings().update_one(
            {"_id": "catalog"},
            {"$set": {"last_refresh": report.get("finished_at") or report["started_at"]}},
            upsert=True,
        )
    except Exception:  # noqa: BLE001 - reporting must never crash the caller
        pass
