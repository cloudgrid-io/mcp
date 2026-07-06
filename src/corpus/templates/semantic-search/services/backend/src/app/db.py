"""Lazy MongoDB access.

The client and connection string are resolved LAZILY (inside get_client), never
at module top level — so importing this module never touches the network and
never requires the env var to exist. CloudGrid injects DATABASE_MONGODB_URL at
runtime from `needs: database`.

Collections:
  documents  — one row per source document (title, collection tag, date, ...).
  chunks     — one embeddable passage per document (content + embedding array).
  settings   — feature flags, synonyms, catalog metadata (last_refresh).
  usage_events, index_reports, sessions — telemetry / admin.
"""
from __future__ import annotations

from typing import Optional

from pymongo import ASCENDING, MongoClient, TEXT
from pymongo.database import Database

from . import config

_client: Optional[MongoClient] = None


def get_client() -> MongoClient:
    global _client
    if _client is None:
        uri = config.mongo_url()
        if not uri:
            raise RuntimeError(
                "DATABASE_MONGODB_URL is not set. CloudGrid injects it "
                "automatically from `needs: database` — run with `grid dev` "
                "locally or deploy with `grid plug`. Do not set it by hand."
            )
        # Short server-selection timeout so health checks fail fast, not hang.
        _client = MongoClient(uri, serverSelectionTimeoutMS=3000)
    return _client


def get_db() -> Database:
    # Default DB name comes from the connection-string path segment the grid injects.
    return get_client().get_default_database()


def ping() -> bool:
    """True if Mongo is reachable. Used by /backend/health."""
    get_client().admin.command("ping")
    return True


def ensure_indexes() -> None:
    """Create the indexes the search relies on. Safe to call repeatedly.

    Called at FastAPI startup so the chunks $text index exists before any query
    — without it, `$text` raises IndexNotFound (a 500) on an empty catalog.
    """
    db = get_db()
    # Text index on chunk content for lexical / $text search.
    db.chunks.create_index([("content", TEXT)], name="chunks_content_text")
    db.chunks.create_index([("document_id", ASCENDING)], name="chunks_document_id")
    # Metadata filter indexes on documents.
    db.documents.create_index([("date", ASCENDING)], name="documents_date")
    db.documents.create_index([("collection", ASCENDING)], name="documents_collection")
    db.documents.create_index(
        [("source_filename", ASCENDING)], name="documents_source_filename", unique=True
    )


# ── Collection accessors ─────────────────────────────────────────────────────

def documents():
    return get_db().documents


def chunks():
    return get_db().chunks


def settings():
    return get_db().settings


def events():
    return get_db().usage_events


def index_reports():
    return get_db().index_reports
