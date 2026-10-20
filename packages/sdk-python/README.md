# tredmail

Python SDK for TredMail, the transactional email API by Dovepeak Technologies. Python 3.9+, standard library only.

```python
from tredmail import TredMail, verify_webhook

client = TredMail(api_key=os.environ["TREDMAIL_API_KEY"])
client.emails.send({"from": "billing@your-domain.com", "to": "customer@example.com", "subject": "Receipt", "html": "<p>Thanks</p>"},
                   idempotency_key="receipt-10293")
```

Errors raise `TredMailError` (`status_code`, `code`, `message`). `verify_webhook()` checks Standard Webhooks signatures.

Install: `pip install path/to/packages/sdk-python`. Tests: `PYTHONPATH=. python -m unittest tests/test_tredmail.py`. Full guide: console `/docs/sdks`.
