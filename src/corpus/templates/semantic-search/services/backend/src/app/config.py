"""Central configuration and secret gating.

CRITICAL CloudGrid rule: NEVER read a secret at module import time. Every value
here is resolved lazily inside a function, so the process starts and passes
`GET /backend/health` even when NO secret is set. Search and indexing degrade
gracefully (empty results + a clear "not indexed / missing secret" note) rather
than crashing.

The Mongo connection is the ONLY hard dependency for health, and it is injected
automatically by CloudGrid (`needs: database`) as DATABASE_MONGODB_URL.

Two pluggable config points:
  - SOURCE_TYPE  selects the document-source adapter (dropbox | local | url).
  - EMBEDDINGS_* selects the embeddings provider (OpenAI-compatible by default).
"""
from __future__ import annotations

import os


# ── Mongo (injected by the grid — the only health-critical config) ──────────

def mongo_url() -> str | None:
    """Injected by CloudGrid `needs: database`. Never set by hand."""
    return os.environ.get("DATABASE_MONGODB_URL") or os.environ.get("MONGODB_URL")


# ── Embeddings (one config point, gated) ─────────────────────────────────────

def embeddings_api_key() -> str | None:
    return os.environ.get("EMBEDDINGS_API_KEY")


def embeddings_model() -> str:
    # Changing the model changes vector dimensions and requires a full reindex.
    return os.environ.get("EMBEDDINGS_MODEL", "text-embedding-3-small")


def embeddings_base_url() -> str:
    # Any OpenAI-compatible endpoint. Default is OpenAI.
    return os.environ.get("EMBEDDINGS_BASE_URL", "https://api.openai.com/v1")


def embeddings_configured() -> bool:
    return bool(embeddings_api_key())


def answer_model() -> str:
    return os.environ.get("ANSWER_MODEL", "gpt-4o-mini")


# ── Source adapter (one config point, gated) ─────────────────────────────────

def source_type() -> str:
    """dropbox | local | url. Selects the document-source adapter."""
    return os.environ.get("SOURCE_TYPE", "dropbox")


def dropbox_config() -> dict[str, str | None]:
    return {
        "app_key": os.environ.get("DROPBOX_APP_KEY"),
        "app_secret": os.environ.get("DROPBOX_APP_SECRET"),
        "refresh_token": os.environ.get("DROPBOX_REFRESH_TOKEN"),
        "folder_path": os.environ.get("DROPBOX_FOLDER_PATH", ""),
    }


def local_source_path() -> str:
    """Directory the local adapter reads. Point at a `needs: disk` mount
    (DISK_PATH) or a bundled folder."""
    return os.environ.get("LOCAL_SOURCE_PATH", os.environ.get("DISK_PATH", ""))


def url_source_manifest() -> str | None:
    """A newline- or comma-separated list of document URLs the url adapter
    fetches. Set as a secret or plain env var."""
    return os.environ.get("URL_SOURCE_MANIFEST")


def source_configured() -> bool:
    st = source_type()
    if st == "dropbox":
        c = dropbox_config()
        return bool(c["app_key"] and c["app_secret"] and c["refresh_token"])
    if st == "local":
        return bool(local_source_path())
    if st == "url":
        return bool(url_source_manifest())
    return False


# ── Manager auth (gated) ──────────────────────────────────────────────────────

def manager_password_hash() -> str | None:
    """A sha256 hex digest of the manager password. Compared server-side."""
    return os.environ.get("MANAGER_PASSWORD_HASH")


def manager_auth_configured() -> bool:
    return bool(manager_password_hash())


# ── Search blend weights ─────────────────────────────────────────────────────

def semantic_weight() -> float:
    return float(os.environ.get("SEMANTIC_WEIGHT", "0.55"))


def keyword_weight() -> float:
    return float(os.environ.get("KEYWORD_WEIGHT", "0.45"))
