import React, { useState } from "react";
import { Send, CheckCircle2, AlertTriangle, ExternalLink, Sparkles } from "lucide-react";

interface SendTestProps {
  apiKey: string;
  onEmailSent: (id: string) => void;
}

export const SendTest: React.FC<SendTestProps> = ({ apiKey, onEmailSent }) => {
  const [from, setFrom] = useState("Dovepeak System <system@dovepeak.com>");
  const [to, setTo] = useState("client@example.com");
  const [subject, setSubject] = useState("Your Account is Ready - Dovepeak Cloud");
  const [html, setHtml] = useState(
    `<h2>Welcome to Dovepeak!</h2>\n<p>Your subscription has been provisioned successfully.</p>\n<p><a href="https://dovepeak.com/login" style="background:#6366f1;color:#fff;padding:8px 16px;text-decoration:none;border-radius:6px;display:inline-block;">Access Your Workspace</a></p>`
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (type: "welcome" | "otp" | "invoice") => {
    if (type === "welcome") {
      setSubject("Welcome to Dovepeak Cloud Platform");
      setHtml(`<h2>Welcome to Dovepeak!</h2>\n<p>Your subscription has been provisioned successfully.</p>\n<p><a href="https://dovepeak.com/login" style="background:#6366f1;color:#fff;padding:8px 16px;text-decoration:none;border-radius:6px;display:inline-block;">Access Your Workspace</a></p>`);
    } else if (type === "otp") {
      setSubject("Your Security Verification Code: 849201");
      setHtml(`<h3>Dovepeak Security Verification</h3>\n<p>Use the following 6-digit one-time code to authenticate:</p>\n<h1 style="letter-spacing:6px;color:#6366f1;">849201</h1>\n<p style="color:#64748b;font-size:12px;">This code expires in 10 minutes.</p>`);
    } else if (type === "invoice") {
      setSubject("Invoice #INV-2026-1049 from Dovepeak Technology");
      setHtml(`<h3>Thank you for your business!</h3>\n<p>Please find details of your recent transaction below:</p>\n<table style="width:100%;border-collapse:collapse;margin-top:10px;">\n<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0;">TredMail Enterprise Plan</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">$0.00 (Self-Hosted)</td></tr>\n</table>\n<p style="margin-top:20px;"><a href="https://dovepeak.com/invoices" style="color:#6366f1;">Download PDF Receipt</a></p>`);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch("/v1/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from,
          to,
          subject,
          html,
          headers: {
            "X-Source": "TredMail-Console-Tester",
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Failed to dispatch email");
      } else {
        setResult(data);
        onEmailSent(data.id);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div>
        <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1.6rem", fontWeight: 700 }}>
          Interactive Email Dispatcher
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: "4px" }}>
          Test the end-to-end ingestion, DKIM signing, and delivery pipeline in real-time.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "24px" }}>
        {/* Form Card */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>
              Quick Templates
            </span>
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => applyPreset("welcome")}>
                Welcome
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => applyPreset("otp")}>
                OTP Code
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => applyPreset("invoice")}>
                Invoice
              </button>
            </div>
          </div>

          <form onSubmit={handleSend} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="form-group">
              <label>From (Must match verified domain e.g. dovepeak.com)</label>
              <input
                type="text"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>To (Recipient Address)</label>
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>HTML Content</label>
              <textarea
                rows={7}
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.84rem", lineHeight: 1.5 }}
                required
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={loading} style={{ marginTop: "8px" }}>
              <Send size={16} />
              {loading ? "Queueing Message..." : "Dispatch Transactional Email"}
            </button>
          </form>
        </div>

        {/* Live Feedback / Inspector Card */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {result && (
            <div
              className="card"
              style={{
                borderColor: "rgba(16, 185, 129, 0.4)",
                background: "rgba(16, 185, 129, 0.05)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                <CheckCircle2 size={20} color="#34d399" />
                <h4 style={{ fontSize: "1rem", fontWeight: 700, color: "#34d399" }}>
                  Dispatched to BullMQ Queue!
                </h4>
              </div>
              <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                Email accepted and signed with RSA-2048 DKIM key.
              </p>
              <div className="form-group" style={{ marginTop: "12px" }}>
                <label>Message ID</label>
                <div className="code-box">{result.id}</div>
              </div>
              <div style={{ marginTop: "16px" }}>
                <a
                  href="http://localhost:8035"
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-secondary btn-sm"
                  style={{ width: "100%" }}
                >
                  View in Mailpit Web Inbox <ExternalLink size={14} />
                </a>
              </div>
            </div>
          )}

          {error && (
            <div
              className="card"
              style={{
                borderColor: "rgba(239, 68, 68, 0.4)",
                background: "rgba(239, 68, 68, 0.05)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <AlertTriangle size={18} color="#ef4444" />
                <h4 style={{ fontSize: "0.95rem", fontWeight: 700, color: "#ef4444" }}>
                  Delivery Failed
                </h4>
              </div>
              <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>{error}</p>
            </div>
          )}

          <div className="card">
            <h4 style={{ fontSize: "0.95rem", fontWeight: 700, marginBottom: "8px" }}>
              Local Mailpit Environment
            </h4>
            <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
              All emails sent locally are captured safely by the Mailpit container on port 1035 with zero risk of spamming real inboxes.
            </p>
            <div style={{ marginTop: "14px" }}>
              <a
                href="http://localhost:8035"
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary btn-sm"
                style={{ width: "100%" }}
              >
                Open Mailpit Dashboard (:8035) <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
