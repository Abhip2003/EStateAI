"""Service-to-service authentication.

Every ``/v1`` route depends on ``require_service_token``: a constant-time
comparison of the ``X-Service-Token`` header against the configured
secret. The token is never logged (the logging redactor scrubs the
header name too).
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from app.config import get_settings


async def require_service_token(x_service_token: str | None = Header(default=None)) -> None:
    expected = get_settings().ai_service_token
    if not x_service_token or not hmac.compare_digest(x_service_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing X-Service-Token",
        )
