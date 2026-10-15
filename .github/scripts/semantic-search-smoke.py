#!/usr/bin/env python3
"""Install-and-import smoke for one semantic-search template service.

The semantic-search template ships Python services with exact-pinned
requirements.txt files, and builders start from them. A broken pin does not
fail our build; it fails on the builder's machine at first run. So this runs
in CI against the template files themselves, after `pip install -r` of that
service's requirements:

  1. imports every module under the service's `app` package, which catches an
     unresolvable pin, a dropped symbol and a Python-version break; and
  2. for the PDF path, runs the template's own `extract_text` on a committed
     PDF and compares the result with a stored SHA-256. pypdf can change its
     OUTPUT without changing its API, and the extracted text is what gets
     embedded, so a whitespace or ligature change would re-rank every search
     while importing cleanly. Only a golden output sees that.

If the golden hash changes after a pypdf bump, do not just update it: diff the
old and new text first (run with --print) and decide whether the change is one
builders should get.

Usage: semantic-search-smoke.py <service-dir> [--print]
Same file in cloudgrid-io/mcp and cloudgrid-io/skills.
"""
from __future__ import annotations

import hashlib
import importlib
import pkgutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / "fixtures" / "semantic-search" / "sample.pdf"

# sha256 of extract_text("sample.pdf", <fixture bytes>) under pypdf 6.19.0.
GOLDEN_SHA256 = "4d29c14e6f6c964543d46cd5ac42c56c5ff2fd5ca1114b4e49d1f2c6e6a95059"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    service = Path(sys.argv[1]).resolve()
    src = service / "src"
    if not (src / "app" / "__init__.py").is_file():
        print(f"no app package under {src}")
        return 2
    # No __pycache__ inside the template: in mcp the template sits under src/,
    # which is the published package, and in both repos it is a twinned tree.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(src))

    import app  # noqa: E402

    names = sorted(m.name for m in pkgutil.iter_modules(app.__path__))
    for name in names:
        importlib.import_module(f"app.{name}")
        print(f"ok    import app.{name}")

    if "source" not in names:
        print("no app.source module: skipping the PDF golden check")
        return 0

    from app.source import extract_text  # noqa: E402

    text = extract_text("sample.pdf", FIXTURE.read_bytes())
    if "--print" in sys.argv:
        print(text)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if digest != GOLDEN_SHA256:
        print(
            "FAIL  PDF extraction output changed.\n"
            f"      expected {GOLDEN_SHA256}\n"
            f"      got      {digest}\n"
            "      The extracted text is what the template embeds, so a change here\n"
            "      re-ranks every builder's search. Diff it with --print before\n"
            "      updating GOLDEN_SHA256."
        )
        return 1
    print(f"ok    PDF golden output ({len(text)} chars, sha256 {digest[:12]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
