"""Pluggable document-source adapter, selected by SOURCE_TYPE.

The source is where the raw documents *live*, not the query database. Three
adapters ship here:

  - dropbox : read-only Dropbox via the offline refresh-token flow.
  - local   : a directory on the container filesystem (e.g. a `needs: disk`
              mount at DISK_PATH, or a bundled folder via LOCAL_SOURCE_PATH).
  - url     : a manifest of document URLs (URL_SOURCE_MANIFEST) fetched over HTTP.

Add your own by subclassing Source and returning it from get_source(). Never read
source secrets at import time; a missing config surfaces as SourceUnavailable,
handled gracefully by the indexing pipeline (it records a report and exits 0).
"""
from __future__ import annotations

import io
import os
from dataclasses import dataclass

import httpx

from . import config


class SourceUnavailable(RuntimeError):
    """Raised when the configured source is not usable (missing secrets, etc)."""


# File classes we handle.
TEXT_EXTS = {".txt", ".md"}
PDF_EXTS = {".pdf"}
DOCX_EXTS = {".docx", ".doc"}
AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".aac", ".ogg"}


@dataclass
class SourceFile:
    path: str            # source-internal path/URL (never exposed to clients)
    name: str            # filename only
    rev: str             # content revision / hash for incremental sync
    size: int
    is_audio: bool
    is_text: bool        # text-extractable (txt/md/pdf/docx)


def _classify(name: str) -> tuple[bool, bool]:
    ext = os.path.splitext(name)[1].lower()
    return (ext in AUDIO_EXTS, ext in (TEXT_EXTS | PDF_EXTS | DOCX_EXTS))


class Source:
    def list_files(self) -> list[SourceFile]:
        raise NotImplementedError

    def download(self, path: str) -> bytes:
        raise NotImplementedError


# ── Dropbox adapter ───────────────────────────────────────────────────────────

class DropboxSource(Source):
    """Read-only Dropbox via the offline refresh-token flow."""

    def __init__(self) -> None:
        c = config.dropbox_config()
        if not (c["app_key"] and c["app_secret"] and c["refresh_token"]):
            raise SourceUnavailable(
                "Dropbox is not configured — set DROPBOX_APP_KEY, "
                "DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN."
            )
        self._app_key = c["app_key"]
        self._app_secret = c["app_secret"]
        self._refresh_token = c["refresh_token"]
        self._folder = (c["folder_path"] or "").rstrip("/")
        self._token: str | None = None

    def _access_token(self) -> str:
        if self._token:
            return self._token
        resp = httpx.post(
            "https://api.dropbox.com/oauth2/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": self._refresh_token,
            },
            auth=(self._app_key, self._app_secret),
            timeout=30.0,
        )
        resp.raise_for_status()
        self._token = resp.json()["access_token"]
        return self._token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token()}"}

    def list_files(self) -> list[SourceFile]:
        out: list[SourceFile] = []
        url = "https://api.dropboxapi.com/2/files/list_folder"
        body: dict = {"path": self._folder, "recursive": True}
        while True:
            resp = httpx.post(url, headers=self._headers(), json=body, timeout=60.0)
            resp.raise_for_status()
            payload = resp.json()
            for entry in payload.get("entries", []):
                if entry.get(".tag") != "file":
                    continue
                out.append(self._to_source_file(entry))
            if payload.get("has_more"):
                url = "https://api.dropboxapi.com/2/files/list_folder/continue"
                body = {"cursor": payload["cursor"]}
            else:
                break
        return out

    @staticmethod
    def _to_source_file(entry: dict) -> SourceFile:
        name = entry["name"]
        is_audio, is_text = _classify(name)
        return SourceFile(
            path=entry["path_lower"],
            name=name,
            rev=entry.get("content_hash") or entry.get("rev", ""),
            size=int(entry.get("size", 0)),
            is_audio=is_audio,
            is_text=is_text,
        )

    def download(self, path: str) -> bytes:
        import json

        resp = httpx.post(
            "https://content.dropboxapi.com/2/files/download",
            headers={
                **self._headers(),
                "Dropbox-API-Arg": json.dumps({"path": path}),
            },
            timeout=120.0,
        )
        resp.raise_for_status()
        return resp.content


# ── Local-filesystem adapter ──────────────────────────────────────────────────

class LocalSource(Source):
    """Read documents from a directory on the container filesystem.

    Point LOCAL_SOURCE_PATH (or a `needs: disk` mount at DISK_PATH) at a folder
    of .txt/.md/.pdf/.docx files. `rev` is the file mtime+size, so changed files
    re-index on the next sync.
    """

    def __init__(self) -> None:
        root = config.local_source_path()
        if not root:
            raise SourceUnavailable(
                "Local source is not configured — set LOCAL_SOURCE_PATH "
                "(or mount a disk and it will default to DISK_PATH)."
            )
        if not os.path.isdir(root):
            raise SourceUnavailable(f"LOCAL_SOURCE_PATH does not exist: {root!r}")
        self._root = root

    def list_files(self) -> list[SourceFile]:
        out: list[SourceFile] = []
        for dirpath, _dirs, files in os.walk(self._root):
            for name in files:
                full = os.path.join(dirpath, name)
                is_audio, is_text = _classify(name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                out.append(SourceFile(
                    path=full,
                    name=name,
                    rev=f"{int(st.st_mtime)}-{st.st_size}",
                    size=st.st_size,
                    is_audio=is_audio,
                    is_text=is_text,
                ))
        return out

    def download(self, path: str) -> bytes:
        with open(path, "rb") as fh:
            return fh.read()


# ── URL-manifest adapter ──────────────────────────────────────────────────────

class UrlSource(Source):
    """Fetch documents from a manifest of URLs.

    URL_SOURCE_MANIFEST is a newline- or comma-separated list of document URLs.
    The filename is the URL's last path segment; `rev` is the URL itself
    (override by pointing the manifest at content-hashed URLs).
    """

    def __init__(self) -> None:
        manifest = config.url_source_manifest()
        if not manifest:
            raise SourceUnavailable(
                "URL source is not configured — set URL_SOURCE_MANIFEST to a "
                "newline- or comma-separated list of document URLs."
            )
        raw = manifest.replace(",", "\n").splitlines()
        self._urls = [u.strip() for u in raw if u.strip()]

    def list_files(self) -> list[SourceFile]:
        out: list[SourceFile] = []
        for u in self._urls:
            name = u.rstrip("/").rsplit("/", 1)[-1] or "document"
            is_audio, is_text = _classify(name)
            out.append(SourceFile(
                path=u,
                name=name,
                rev=u,
                size=0,
                is_audio=is_audio,
                is_text=is_text,
            ))
        return out

    def download(self, path: str) -> bytes:
        resp = httpx.get(path, timeout=120.0, follow_redirects=True)
        resp.raise_for_status()
        return resp.content


def get_source() -> Source:
    """Build the configured source adapter. Raises SourceUnavailable if unusable."""
    st = config.source_type()
    if st == "dropbox":
        return DropboxSource()
    if st == "local":
        return LocalSource()
    if st == "url":
        return UrlSource()
    raise SourceUnavailable(f"Unknown SOURCE_TYPE: {st!r}")


# ── Text extraction (used by the pipeline) ───────────────────────────────────

def extract_text(name: str, raw: bytes) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in TEXT_EXTS:
        return raw.decode("utf-8", errors="replace")
    if ext in PDF_EXTS:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    if ext in DOCX_EXTS:
        from docx import Document

        doc = Document(io.BytesIO(raw))
        return "\n".join(p.text for p in doc.paragraphs)
    return ""
