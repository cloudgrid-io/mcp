"""Manager password hashing: scrypt (stdlib only, no extra dependency).

The stored value is self-describing, so the work factor can be raised later
without breaking existing hashes:

    scrypt:<n>:<r>:<p>:<salt hex>:<hash hex>

Colons and hex only, so the value is safe to paste into a shell unquoted
(`grid secrets set MANAGER_PASSWORD_HASH=...`).

Generate a hash without putting the password on a command line (it is read
from the terminal, not argv, and never echoed):

    python3 services/backend/src/app/passwords.py

This file imports nothing outside the standard library, so it runs before the
service's requirements are installed.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

SCHEME = "scrypt"
N, R, P = 2**14, 8, 1          # ~16 MiB, the commonly recommended interactive cost
SALT_BYTES = 16
DKLEN = 32
# Refuse stored parameters that would let a bad secret pin the CPU or memory.
_MAX_N, _MAX_R, _MAX_P = 2**20, 32, 16


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
        maxmem=128 * r * (n + p + 2) + 1024 * 1024, dklen=DKLEN,
    )


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _derive(password, salt, N, R, P)
    return f"{SCHEME}:{N}:{R}:{P}:{salt.hex()}:{digest.hex()}"


def is_supported(stored: str) -> bool:
    """True when `stored` is a hash this module can verify."""
    try:
        _parse(stored)
        return True
    except ValueError:
        return False


def _parse(stored: str) -> tuple[int, int, int, bytes, bytes]:
    parts = stored.strip().split(":")
    if len(parts) != 6 or parts[0] != SCHEME:
        raise ValueError("not a scrypt password hash")
    n, r, p = (int(x) for x in parts[1:4])
    if not (1 < n <= _MAX_N and n & (n - 1) == 0 and 0 < r <= _MAX_R and 0 < p <= _MAX_P):
        raise ValueError("scrypt parameters out of range")
    salt, digest = bytes.fromhex(parts[4]), bytes.fromhex(parts[5])
    if not salt or len(digest) != DKLEN:
        raise ValueError("malformed scrypt password hash")
    return n, r, p, salt, digest


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of `password` against a stored hash. A malformed or
    unsupported stored value never verifies."""
    try:
        n, r, p, salt, digest = _parse(stored)
    except ValueError:
        return False
    return hmac.compare_digest(_derive(password, salt, n, r, p), digest)


if __name__ == "__main__":
    import getpass
    import sys

    first = getpass.getpass("Manager password: ")
    if not first:
        sys.exit("empty password refused")
    if getpass.getpass("Repeat: ") != first:
        sys.exit("passwords do not match")
    print(hash_password(first))
