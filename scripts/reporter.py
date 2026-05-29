"""Best-effort event reporting to report-center.

Reads MOKI_TOKEN from env. Failures (network, auth, JSON, anything) are
swallowed silently so reporting never disturbs training. All calls are
no-ops if the token is not set.
"""

import json
import logging
import os
import socket
import urllib.error
import urllib.request
from typing import Any, Optional

_BASE = os.environ.get("MOKI_BASE", "https://report-center.caat.workers.dev")
_TOKEN = os.environ.get("MOKI_TOKEN", "")
_TIMEOUT = float(os.environ.get("MOKI_TIMEOUT", "1.5"))
_DEFAULT_SOURCE = os.environ.get("MOKI_SOURCE", "sanma-train")

_log = logging.getLogger("reporter")


def enabled() -> bool:
    return bool(_TOKEN)


def _post(path: str, payload: Any) -> None:
    if not _TOKEN:
        return
    url = f"{_BASE}{path}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_TOKEN}",
            "User-Agent": "sanma-train-reporter/1.0 (+stallion)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            resp.read()
    except (urllib.error.URLError, socket.timeout, OSError, ValueError) as e:
        _log.debug("report failed (%s): %s", path, e)
    except Exception as e:  # last-resort: never propagate
        _log.debug("report unexpected error: %r", e)


def event(
    type_: str,
    *,
    source: Optional[str] = None,
    status: Optional[str] = None,
    severity: str = "info",
    message: Optional[str] = None,
    data: Optional[dict] = None,
    timeout_ms: int = 600_000,
    skip_notify: bool = False,
) -> None:
    """Fire a single event. Always swallows errors."""
    payload = {
        "source": source or _DEFAULT_SOURCE,
        "type": type_,
        "severity": severity,
        "timeout_ms": timeout_ms,
        "skip_notify": skip_notify,
    }
    if status is not None:
        payload["status"] = status
    if message is not None:
        payload["message"] = message
    if data is not None:
        payload["data"] = data
    _post("/api/events", payload)


def heartbeat(message: str = "alive", *, source: Optional[str] = None) -> None:
    if not _TOKEN:
        return
    _post(
        "/api/events/heartbeat",
        {
            "source": source or _DEFAULT_SOURCE,
            "message": message,
            "skip_notify": True,
        },
    )
