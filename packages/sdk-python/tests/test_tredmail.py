import base64
import hashlib
import hmac
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from tredmail import TredMail, TredMailError, WebhookVerificationError, verify_webhook


def sign(secret: str, msg_id: str, ts: int, body: str) -> str:
    key = base64.b64decode(secret.removeprefix("whsec_"))
    return "v1," + base64.b64encode(hmac.new(key, f"{msg_id}.{ts}.{body}".encode(), hashlib.sha256).digest()).decode()


class Handler(BaseHTTPRequestHandler):
    requests = []

    def _reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        Handler.requests.append((self.path, dict(self.headers), json.loads(self.rfile.read(length) or b"null")))
        self._reply(200, {"id": "e1", "status": "queued"})

    def do_GET(self):
        Handler.requests.append((self.path, dict(self.headers), None))
        self._reply(404, {"statusCode": 404, "error": "not_found", "message": "Email 'x' not found."})

    def log_message(self, *args):
        pass


class SdkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.client = TredMail(api_key="tred_live_x", base_url=f"http://127.0.0.1:{cls.server.server_port}/v1/")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_send_encodes_attachments_and_headers(self):
        result = self.client.emails.send(
            {"to": "a@b.c", "subject": "s", "text": "t", "attachments": [{"filename": "a.txt", "content": b"hi"}]},
            idempotency_key="order-1",
        )
        self.assertEqual(result, {"id": "e1", "status": "queued"})
        path, headers, body = Handler.requests[-1]
        self.assertEqual(path, "/v1/emails")
        self.assertEqual(headers["Authorization"], "Bearer tred_live_x")
        self.assertEqual(headers["Idempotency-Key"], "order-1")
        self.assertEqual(body["attachments"][0]["content"], "aGk=")

    def test_errors_raise_with_code(self):
        with self.assertRaises(TredMailError) as ctx:
            self.client.emails.get("x")
        self.assertEqual((ctx.exception.status_code, ctx.exception.code), (404, "not_found"))

    def test_list_joins_statuses(self):
        with self.assertRaises(TredMailError):
            self.client.emails.list(status=["bounced", "failed"], limit=5)
        self.assertEqual(Handler.requests[-1][0], "/v1/emails?status=bounced%2Cfailed&limit=5")

    def test_usage_and_plans_paths(self):
        for call, path in ((self.client.usage.get, "/v1/usage"), (self.client.plans.list, "/v1/plans")):
            with self.assertRaises(TredMailError):
                call()
            self.assertEqual(Handler.requests[-1][0], path)

    def test_verify_webhook(self):
        secret = "whsec_" + base64.b64encode(b"k" * 24).decode()
        body = json.dumps({"type": "email.bounced", "data": {"email_id": "e1"}})
        ts = int(time.time())
        headers = {"Webhook-Id": "msg_1", "Webhook-Timestamp": str(ts), "Webhook-Signature": sign(secret, "msg_1", ts, body)}
        self.assertEqual(verify_webhook(secret, headers, body.encode())["type"], "email.bounced")
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(secret, headers, body.replace("e1", "e2"))
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(secret, headers, body, now=ts + 600)


if __name__ == "__main__":
    unittest.main()
