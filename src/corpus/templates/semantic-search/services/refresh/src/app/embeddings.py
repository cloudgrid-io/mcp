"""Single config point for embeddings (OpenAI-compatible).

Isolated behind one module so the provider can be swapped by env var
(EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL / EMBEDDINGS_API_KEY). NEVER reads the
API key at import time — only inside embed(). If the key is missing, embed()
raises EmbeddingsUnavailable, which callers translate into a graceful degraded
state (lexical + metadata search still work).
"""
from __future__ import annotations

import httpx

from . import config


class EmbeddingsUnavailable(RuntimeError):
    """Raised when embeddings are requested but not configured/reachable."""


def embed(texts: list[str]) -> list[list[float]]:
    """Return one embedding vector per input text.

    Raises EmbeddingsUnavailable if EMBEDDINGS_API_KEY is not set.
    """
    if not texts:
        return []
    key = config.embeddings_api_key()
    if not key:
        raise EmbeddingsUnavailable(
            "EMBEDDINGS_API_KEY is not set — semantic embedding is unavailable."
        )
    resp = httpx.post(
        f"{config.embeddings_base_url()}/embeddings",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": config.embeddings_model(), "input": texts},
        timeout=60.0,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    return [row["embedding"] for row in data]


def embed_one(text: str) -> list[float]:
    return embed([text])[0]
