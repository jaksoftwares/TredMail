import React, { useEffect, useState } from "react";
import { Mail, CheckCircle2, Clock, AlertCircle, Eye, ExternalLink, X, RefreshCw } from "lucide-react";

interface EmailEvent {
  id: string;
  type: string;
  timestamp: string;
  ip_address?: string;
  user_agent?: string;
  details?: any;
}

interface EmailDetails {
  id: string;
  domain: string;
  from: string;
  to: string[];
  subject: string;
  status: string;
  created_at: string;
  delivered_at?: string;
  smtp_response?: string;
  events: EmailEvent[];
}

interface EmailsProps {
  apiKey: string;
  selectedEmailId: string | null;
  onClearSelectedEmail: () => void;
}

export const Emails: React.FC<EmailsProps> = ({ apiKey, selectedEmailId, onClearSelectedEmail }) => {
  const [emails, setEmails] = useState<any[]>([]);
  const [activeDetails, setActiveDetails] = useState<EmailDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const loadEmails = async () => {
    try {
      const res = await fetch("/v1/stats", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setEmails(data.recentEmails || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const loadEmailDetails = async (id: string) => {
    setLoadingDetails(true);
    try {
      const res = await fetch(`/v1/emails/${id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setActiveDetails(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingDetails(false);
    }
  };

  useEffect(() => {
    loadEmails();
  }, [apiKey]);

  useEffect(() => {
    if (selectedEmailId) {
      loadEmailDetails(selectedEmailId);
    }
  }, [selectedEmailId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1.6rem", fontWeight: 700 }}>
            Live Email Inspector
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: "4px" }}>
            Inspect outbound message lifecycle, SMTP handshakes, and recipient tracking.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={loadEmails}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Recipient</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Delivered At</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {emails.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)" }}>
                  No emails logged yet.
                </td>
              </tr>
            ) : (
              emails.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "#38bdf8" }}>
                    {e.id.substring(0, 12)}...
                  </td>
                  <td style={{ fontWeight: 600 }}>{e.to.join(", ")}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{e.subject}</td>
                  <td>
                    <span className={`badge ${e.status === "DELIVERED" ? "badge-success" : e.status === "QUEUED" ? "badge-info" : "badge-danger"}`}>
                      {e.status}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {e.deliveredAt ? new Date(e.deliveredAt).toLocaleTimeString() : "Pending"}
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => loadEmailDetails(e.id)}
                    >
                      Audit Timeline
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal Inspector */}
      {activeDetails && (
        <div className="modal-overlay" onClick={() => setActiveDetails(null)}>
          <div className="modal-content" style={{ maxWidth: "720px" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Mail size={18} color="var(--accent-primary)" />
                <h3 className="modal-title">Email Delivery Audit</h3>
              </div>
              <button
                className="copy-btn"
                onClick={() => {
                  setActiveDetails(null);
                  onClearSelectedEmail();
                }}
              >
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {/* Core Details */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                <div className="form-group">
                  <label>Message ID</label>
                  <div className="code-box">{activeDetails.id}</div>
                </div>
                <div className="form-group">
                  <label>Sending Domain</label>
                  <div className="code-box">{activeDetails.domain}</div>
                </div>
                <div className="form-group">
                  <label>From</label>
                  <div className="code-box">{activeDetails.from}</div>
                </div>
                <div className="form-group">
                  <label>To</label>
                  <div className="code-box">{activeDetails.to.join(", ")}</div>
                </div>
              </div>

              {/* SMTP Handshake Diagnostic */}
              <div className="form-group">
                <label>SMTP Remote Response</label>
                <div className="code-box" style={{ color: "#34d399", background: "#06130d" }}>
                  {activeDetails.smtp_response || "In queue / Awaiting delivery"}
                </div>
              </div>

              {/* Chronological Event Timeline */}
              <div className="form-group">
                <label>Chronological Event Audit Trail</label>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "6px" }}>
                  {activeDetails.events.map((evt, idx) => (
                    <div
                      key={evt.id || idx}
                      style={{
                        padding: "12px 16px",
                        background: "var(--bg-card)",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--border-subtle)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        {evt.type === "delivered" ? (
                          <CheckCircle2 size={16} color="#34d399" />
                        ) : evt.type === "opened" ? (
                          <Eye size={16} color="#38bdf8" />
                        ) : evt.type === "bounced" ? (
                          <AlertCircle size={16} color="#ef4444" />
                        ) : (
                          <Clock size={16} color="#818cf8" />
                        )}
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.88rem", textTransform: "uppercase" }}>
                            {evt.type}
                          </div>
                          {evt.ip_address && (
                            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                              IP: {evt.ip_address}
                            </div>
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                        {new Date(evt.timestamp).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <a
                href="http://localhost:8035"
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary btn-sm"
              >
                Inspect in Mailpit <ExternalLink size={14} />
              </a>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setActiveDetails(null);
                  onClearSelectedEmail();
                }}
              >
                Close Audit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
