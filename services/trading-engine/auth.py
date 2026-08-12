import os

from fastapi import Header, HTTPException


def verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    """Shared internal-service-auth dependency for every non-health router.

    Fails CLOSED: if INTERNAL_SERVICE_TOKEN is not configured in the process
    environment, every request is rejected rather than silently allowed through.
    """
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=403, detail="INTERNAL_SERVICE_TOKEN is not configured")
    if x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")
