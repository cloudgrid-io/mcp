"""FastAPI backend for the semantic-search document app.

Mounted at /backend by CloudGrid. Public search + answer endpoints, plus
manager-only admin (Settings, Usage Dashboard, Refresh now) enforced server-side.

Health is green as soon as Mongo connects — it does NOT require the document
source or the embeddings key. No secret is read at import time.
"""
from __future__ import annotations

import datetime as dt

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import answer, auth, config, db, indexing, search

app = FastAPI(title="Semantic Search API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # frontend is served same-origin; open for safety
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _ensure_indexes_on_startup() -> None:
    # Create the chunks $text index + documents indexes at boot so $text search
    # returns [] on an empty catalog instead of erroring (IndexNotFound / 500).
    # Never block startup if Mongo is briefly unavailable — an index run recreates
    # them.
    try:
        db.ensure_indexes()
    except Exception as e:  # noqa: BLE001
        print(f"startup: ensure_indexes skipped ({e})")


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/backend/health")
def health():
    """Green when Mongo connects. Independent of the source / embeddings key."""
    try:
        db.ping()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "degraded", "detail": str(exc)}


@app.get("/backend/status")
def status():
    """Public capability snapshot — powers the frontend's 'not indexed / missing
    secret' states without exposing any secret value."""
    try:
        db.ping()
        mongo_ok = True
    except Exception:  # noqa: BLE001
        mongo_ok = False
    settings_doc = db.settings().find_one({"_id": "catalog"}) if mongo_ok else None
    features = db.settings().find_one({"_id": "features"}) if mongo_ok else None
    return {
        "mongo": mongo_ok,
        "source_type": config.source_type(),
        "source_configured": config.source_configured(),
        "embeddings_configured": config.embeddings_configured(),
        "manager_auth_configured": config.manager_auth_configured(),
        "answer_mode_enabled": bool((features or {}).get("answer_mode_enabled", True)),
        "indexed_documents": db.documents().count_documents({}) if mongo_ok else 0,
        "last_refresh": (settings_doc or {}).get("last_refresh"),
    }


# ── Search (public) ───────────────────────────────────────────────────────────

@app.get("/backend/search")
def do_search(q: str = "", mode: str = "hybrid", collection: str | None = None,
              date_from: str | None = None, date_to: str | None = None,
              limit: int = 20):
    result = search.search(q, mode=mode, collection=collection,
                           date_from=date_from, date_to=date_to, limit=limit)
    _log_event("search", {"q": q, "mode": mode,
                          "zero_result": len(result["results"]) == 0})
    return result


@app.get("/backend/count")
def do_count(collection: str | None = None, date_from: str | None = None,
             date_to: str | None = None):
    """Counting answered directly from the DB (countDocuments)."""
    return {"count": search.count_documents(collection, date_from, date_to)}


@app.get("/backend/collections")
def list_collections():
    values = [c for c in db.documents().distinct("collection") if c]
    return {"collections": sorted(values)}


class AnswerRequest(BaseModel):
    question: str


@app.post("/backend/answer")
def do_answer(req: AnswerRequest):
    _log_event("answer", {"q": req.question})
    return answer.compose_answer(req.question)


@app.get("/backend/documents/{document_id}/download")
def download_document(document_id: str):
    """Stream a document's text through the service — source paths never exposed."""
    from bson import ObjectId
    from fastapi import HTTPException
    from fastapi.responses import PlainTextResponse

    try:
        doc = db.documents().find_one({"_id": ObjectId(document_id)})
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Not found.")
    if not doc:
        raise HTTPException(status_code=404, detail="Not found.")
    parts = db.chunks().find({"document_id": doc["_id"]}).sort("chunk_index", 1)
    text = "".join(p["content"] for p in parts)
    return PlainTextResponse(text, headers={
        "Content-Disposition": f'attachment; filename="{doc.get("title","document")}.txt"'
    })


# ── Manager auth ──────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    password: str


@app.post("/backend/admin/login")
def admin_login(req: LoginRequest):
    token = auth.login(req.password)
    return {"token": token}


# ── Manager: Settings ─────────────────────────────────────────────────────────

@app.get("/backend/admin/settings", dependencies=[Depends(auth.require_manager)])
def get_settings():
    features = db.settings().find_one({"_id": "features"}) or {}
    synonyms = db.settings().find_one({"_id": "synonyms"}) or {}
    catalog = db.settings().find_one({"_id": "catalog"}) or {}
    return {
        "answer_mode_enabled": bool(features.get("answer_mode_enabled", True)),
        "synonyms": synonyms.get("map", {}),
        "last_refresh": catalog.get("last_refresh"),
    }


class FeatureUpdate(BaseModel):
    answer_mode_enabled: bool | None = None


@app.put("/backend/admin/settings", dependencies=[Depends(auth.require_manager)])
def update_settings(req: FeatureUpdate):
    update = {k: v for k, v in req.dict().items() if v is not None}
    if update:
        db.settings().update_one({"_id": "features"}, {"$set": update}, upsert=True)
    return {"ok": True}


class SynonymUpdate(BaseModel):
    map: dict[str, list[str]]


@app.put("/backend/admin/synonyms", dependencies=[Depends(auth.require_manager)])
def update_synonyms(req: SynonymUpdate):
    db.settings().update_one({"_id": "synonyms"}, {"$set": {"map": req.map}}, upsert=True)
    return {"ok": True}


class PasswordChange(BaseModel):
    current: str
    new: str


@app.post("/backend/admin/password", dependencies=[Depends(auth.require_manager)])
def change_password(req: PasswordChange):
    new_hash = auth.change_password(req.current, req.new)
    # Return the hash for the manager to store as MANAGER_PASSWORD_HASH.
    return {
        "new_hash": new_hash,
        "note": "Store this as the MANAGER_PASSWORD_HASH secret "
                "(`grid secrets set MANAGER_PASSWORD_HASH=<hash>`) to persist it.",
    }


@app.get("/backend/admin/index-report", dependencies=[Depends(auth.require_manager)])
def index_report():
    reports = list(db.index_reports().find().sort("started_at", -1).limit(10))
    for r in reports:
        r["_id"] = str(r["_id"])
    return {"reports": reports}


@app.post("/backend/admin/refresh", dependencies=[Depends(auth.require_manager)])
def refresh_now():
    """Manager-only on-demand incremental sync.

    This is the supported refresh path today. A scheduled `type: cron` refresh
    service is a follow-up (blocked on platform issue #1585); see AGENTS.md.
    """
    report = indexing.run_sync(triggered_by="manager")
    report.pop("_id", None)
    return report


# ── Manager: Usage Dashboard ──────────────────────────────────────────────────

@app.get("/backend/admin/usage", dependencies=[Depends(auth.require_manager)])
def usage():
    ev = db.events()
    total_searches = ev.count_documents({"kind": "search"})
    by_mode = list(ev.aggregate([
        {"$match": {"kind": "search"}},
        {"$group": {"_id": "$meta.mode", "count": {"$sum": 1}}},
    ]))
    top_queries = list(ev.aggregate([
        {"$match": {"kind": "search", "meta.q": {"$ne": ""}}},
        {"$group": {"_id": "$meta.q", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}, {"$limit": 10},
    ]))
    zero_result = list(ev.aggregate([
        {"$match": {"kind": "search", "meta.zero_result": True}},
        {"$group": {"_id": "$meta.q", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}, {"$limit": 10},
    ]))
    unique_users = len(ev.distinct("anon_id", {"kind": "search"}))
    return {
        "total_searches": total_searches,
        "unique_users": unique_users,
        "by_mode": {row["_id"] or "unknown": row["count"] for row in by_mode},
        "top_queries": [{"query": r["_id"], "count": r["count"]} for r in top_queries],
        "zero_result_queries": [{"query": r["_id"], "count": r["count"]} for r in zero_result],
        "indexed_documents": db.documents().count_documents({}),
        "last_refresh": (db.settings().find_one({"_id": "catalog"}) or {}).get("last_refresh"),
    }


# ── internal ──────────────────────────────────────────────────────────────────

def _log_event(kind: str, meta: dict) -> None:
    try:
        db.events().insert_one({
            "kind": kind,
            "meta": meta,
            "anon_id": meta.get("anon_id", "anon"),
            "at": dt.datetime.now(dt.timezone.utc),
        })
    except Exception:  # noqa: BLE001 - telemetry must never break a request
        pass
