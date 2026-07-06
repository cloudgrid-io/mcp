"""Server-side manager session auth.

Admin functions are enforced on the server, not just hidden in the UI. Sessions
are opaque tokens stored in Mongo. The password is compared against
MANAGER_PASSWORD_HASH (sha256 hex). If no hash is configured, admin login is
refused (never open by default) — but the app still starts and search stays
public.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import secrets

from fastapi import Header, HTTPException

from . import config, db

SESSION_TTL_HOURS = 12


def _hash(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def login(password: str) -> str:
    configured = config.manager_password_hash()
    if not configured:
        raise HTTPException(
            status_code=503,
            detail="Manager auth is not configured (MANAGER_PASSWORD_HASH unset).",
        )
    if not secrets.compare_digest(_hash(password), configured):
        raise HTTPException(status_code=401, detail="Invalid password.")
    token = secrets.token_urlsafe(32)
    db.get_db().sessions.insert_one({
        "_id": token,
        "created_at": dt.datetime.now(dt.timezone.utc),
        "expires_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=SESSION_TTL_HOURS),
    })
    return token


def require_manager(authorization: str | None = Header(default=None)) -> str:
    """FastAPI dependency: validate the Bearer session token."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Manager session required.")
    token = authorization.split(" ", 1)[1].strip()
    session = db.get_db().sessions.find_one({"_id": token})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session.")
    if session["expires_at"] < dt.datetime.now(dt.timezone.utc):
        db.get_db().sessions.delete_one({"_id": token})
        raise HTTPException(status_code=401, detail="Session expired.")
    return token


def change_password(current: str, new: str) -> str:
    """Self-contained password change. Returns the NEW hash for the manager to
    store as the MANAGER_PASSWORD_HASH secret (we never persist the plaintext or
    the secret ourselves)."""
    configured = config.manager_password_hash()
    if configured and not secrets.compare_digest(_hash(current), configured):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")
    return _hash(new)
