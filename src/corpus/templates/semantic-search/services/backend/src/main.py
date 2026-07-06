"""CloudGrid python-service entry point (services/backend/src/main.py).

Launches the FastAPI app (app/main.py) with uvicorn, binding to the platform's
injected PORT (default 8080). No secret is read here or at import time.
"""
import os

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, workers=1)
