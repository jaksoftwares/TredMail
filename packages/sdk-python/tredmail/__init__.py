"""TredMail Python SDK by Dovepeak Technologies.

    from tredmail import TredMail

    client = TredMail(api_key=os.environ["TREDMAIL_API_KEY"])
    email = client.emails.send({
        "from": "Dovepeak <billing@dovepeakdigital.com>",
        "to": "customer@example.com",
        "subject": "Your receipt",
        "html": "<p>Thank you</p>",
    })

Request bodies use the API's field names (snake_case). Errors raise TredMailError, which
carries the HTTP status and TredMail's error code. Standard library only; Python 3.9+.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Mapping, Optional, Union

__all__ = ["TredMail", "TredMailError", "WebhookVerificationError", "verify_webhook", "DEFAULT_BASE_URL"]
__version__ = "1.3.0"

DEFAULT_BASE_URL = "https://api.tredmail.dovepeakdigital.com/v1"

Json = Dict[str, Any]


class TredMailError(Exception):
    """An API error: `status_code` (0 for network failures), `code` and `message`."""

    def __init__(self, status_code: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(f"{status_code} {code}: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def _iso(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


def _prepare_email(email: Mapping[str, Any]) -> Json:
    body = {k: _iso(v) for k, v in email.items() if v is not None}
    attachments = body.get("attachments")
    if attachments:
        body["attachments"] = [
            {**a, "content": base64.b64encode(a["content"]).decode() if isinstance(a["content"], (bytes, bytearray)) else a["content"]}
            for a in attachments
        ]
    return body


class _Resource:
    def __init__(self, client: "TredMail") -> None:
        self._client = client


class Emails(_Resource):
    def send(self, email: Mapping[str, Any], idempotency_key: Optional[str] = None) -> Json:
        """Queue one email. `scheduled_at` may be a datetime. Attachment content may be bytes."""
        return self._client._request("POST", "/emails", _prepare_email(email), idempotency_key=idempotency_key)

    def batch(self, emails: Iterable[Mapping[str, Any]], idempotency_key: Optional[str] = None) -> Json:
        return self._client._request("POST", "/emails/batch", [_prepare_email(e) for e in emails], idempotency_key=idempotency_key)

    def get(self, email_id: str) -> Json:
        return self._client._request("GET", f"/emails/{urllib.parse.quote(email_id)}")

    def list(self, **filters: Any) -> Json:
        """Filters: status (str or list), q, domain, tag, template, after, before, limit, cursor."""
        if isinstance(filters.get("status"), (list, tuple)):
            filters["status"] = ",".join(filters["status"])
        return self._client._request("GET", "/emails", query={k: _iso(v) for k, v in filters.items()})

    def cancel(self, email_id: str) -> Json:
        return self._client._request("POST", f"/emails/{urllib.parse.quote(email_id)}/cancel")

    def reschedule(self, email_id: str, scheduled_at: Any) -> Json:
        return self._client._request("PATCH", f"/emails/{urllib.parse.quote(email_id)}", {"scheduled_at": _iso(scheduled_at)})


class Templates(_Resource):
    def list(self) -> Json:
        return self._client._request("GET", "/templates")

    def get(self, id_or_alias: str) -> Json:
        return self._client._request("GET", f"/templates/{urllib.parse.quote(id_or_alias)}")

    def create(self, template: Mapping[str, Any]) -> Json:
        return self._client._request("POST", "/templates", dict(template))

    def update(self, id_or_alias: str, changes: Mapping[str, Any]) -> Json:
        return self._client._request("PATCH", f"/templates/{urllib.parse.quote(id_or_alias)}", dict(changes))

    def remove(self, id_or_alias: str) -> Json:
        return self._client._request("DELETE", f"/templates/{urllib.parse.quote(id_or_alias)}")

    def preview(self, id_or_alias: str, variables: Optional[Mapping[str, Any]] = None) -> Json:
        return self._client._request("POST", f"/templates/{urllib.parse.quote(id_or_alias)}/preview", {"variables": dict(variables or {})})


class Domains(_Resource):
    def list(self) -> Json:
        return self._client._request("GET", "/domains")

    def get(self, domain_id: str) -> Json:
        return self._client._request("GET", f"/domains/{urllib.parse.quote(domain_id)}")

    def create(self, name: str) -> Json:
        return self._client._request("POST", "/domains", {"name": name})

    def verify(self, domain_id: str) -> Json:
        return self._client._request("POST", f"/domains/{urllib.parse.quote(domain_id)}/verify")

    def remove(self, domain_id: str) -> Json:
        return self._client._request("DELETE", f"/domains/{urllib.parse.quote(domain_id)}")

    def dmarc(self, domain_id: str, days: int = 30) -> Json:
        return self._client._request("GET", f"/domains/{urllib.parse.quote(domain_id)}/dmarc", query={"days": days})


class Webhooks(_Resource):
    def list(self) -> Json:
        return self._client._request("GET", "/webhooks")

    def create(self, url: str, events: Optional[List[str]] = None) -> Json:
        return self._client._request("POST", "/webhooks", {"url": url, "subscribed_to": events or ["email.delivered", "email.bounced"]})

    def update(self, webhook_id: str, **changes: Any) -> Json:
        """Changes: url, subscribed_to, is_active."""
        return self._client._request("PATCH", f"/webhooks/{urllib.parse.quote(webhook_id)}", changes)

    def remove(self, webhook_id: str) -> Json:
        return self._client._request("DELETE", f"/webhooks/{urllib.parse.quote(webhook_id)}")

    def test(self, webhook_id: str) -> Json:
        return self._client._request("POST", f"/webhooks/{urllib.parse.quote(webhook_id)}/test")

    def rotate_secret(self, webhook_id: str) -> Json:
        return self._client._request("POST", f"/webhooks/{urllib.parse.quote(webhook_id)}/rotate-secret")

    def deliveries(self, webhook_id: str, **filters: Any) -> Json:
        return self._client._request("GET", f"/webhooks/{urllib.parse.quote(webhook_id)}/deliveries", query=filters)

    def replay(self, webhook_id: str, delivery_id: str) -> Json:
        path = f"/webhooks/{urllib.parse.quote(webhook_id)}/deliveries/{urllib.parse.quote(delivery_id)}/replay"
        return self._client._request("POST", path)

    def replay_failed(self, webhook_id: str) -> Json:
        return self._client._request("POST", f"/webhooks/{urllib.parse.quote(webhook_id)}/replay-failed")


class Suppressions(_Resource):
    def list(self) -> Json:
        return self._client._request("GET", "/suppressions")

    def create(self, email: str, reason: str = "MANUAL") -> Json:
        return self._client._request("POST", "/suppressions", {"email": email, "reason": reason})

    def remove(self, suppression_id: str) -> Json:
        return self._client._request("DELETE", f"/suppressions/{urllib.parse.quote(suppression_id)}")


class Stats(_Resource):
    def get(self) -> Json:
        return self._client._request("GET", "/stats")

    def timeseries(self, days: int = 30, domain: Optional[str] = None) -> Json:
        return self._client._request("GET", "/stats/timeseries", query={"days": days, "domain": domain})

    def domains(self, days: int = 30) -> Json:
        return self._client._request("GET", "/stats/domains", query={"days": days})


class Usage(_Resource):
    def get(self) -> Json:
        """This month's usage against the workspace's plan (needs the stats:read scope)."""
        return self._client._request("GET", "/usage")


class Plans(_Resource):
    def list(self) -> Json:
        """The public price list. Amounts are in minor units (cents) of each plan's currency."""
        return self._client._request("GET", "/plans")


class TredMail:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 30.0) -> None:
        if not api_key:
            raise ValueError("TredMail API key is required: TredMail(api_key='tred_live_...')")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self.emails = Emails(self)
        self.templates = Templates(self)
        self.domains = Domains(self)
        self.webhooks = Webhooks(self)
        self.suppressions = Suppressions(self)
        self.stats = Stats(self)
        self.usage = Usage(self)
        self.plans = Plans(self)

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        if query:
            params = {k: v for k, v in query.items() if v is not None and v != ""}
            if params:
                url += "?" + urllib.parse.urlencode(params)
        headers = {"Authorization": f"Bearer {self._api_key}", "User-Agent": f"tredmail-python/{__version__}", "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = {}
            raise TredMailError(err.code, payload.get("error", "http_error"), payload.get("message", err.reason), payload.get("details")) from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise TredMailError(0, "network_error", str(getattr(err, "reason", err))) from None


class WebhookVerificationError(Exception):
    pass


def _header(headers: Mapping[str, Any], name: str) -> Optional[str]:
    for key, value in headers.items():
        if key.lower() == name:
            return value[0] if isinstance(value, (list, tuple)) else value
    return None


def verify_webhook(secret: str, headers: Mapping[str, Any], body: Union[str, bytes], tolerance_seconds: int = 300, now: Optional[float] = None) -> Json:
    """Verifies a TredMail webhook (Standard Webhooks) and returns the parsed event.

    Pass the raw request body exactly as received. Raises WebhookVerificationError when the
    signature does not match or the timestamp is more than `tolerance_seconds` off.
    """
    msg_id = _header(headers, "webhook-id")
    timestamp = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if not msg_id or not timestamp or not signatures:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header")
    try:
        ts = int(timestamp)
    except ValueError:
        raise WebhookVerificationError("Invalid webhook timestamp") from None
    current = int(now if now is not None else time.time())
    if abs(current - ts) > tolerance_seconds:
        raise WebhookVerificationError("Webhook timestamp is too old or in the future")

    text = body.decode() if isinstance(body, (bytes, bytearray)) else body
    key = base64.b64decode(secret[len("whsec_"):] if secret.startswith("whsec_") else secret)
    expected = base64.b64encode(hmac.new(key, f"{msg_id}.{timestamp}.{text}".encode(), hashlib.sha256).digest()).decode()
    for entry in signatures.split(" "):
        version, _, signature = entry.partition(",")
        if version == "v1" and hmac.compare_digest(signature, expected):
            return json.loads(text)
    raise WebhookVerificationError("Webhook signature does not match")
