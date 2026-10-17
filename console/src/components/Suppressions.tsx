import React, { useEffect, useState } from "react";
import { ShieldAlert, Plus, Trash2, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

interface SuppressionItem {
  id: string;
  email: string;
  reason: string;
  diagnostic?: string;
  created_at: string;
}

interface SuppressionsProps {
  apiKey: string;
}

export const Suppressions: React.FC<SuppressionsProps> = ({ apiKey }) => {
  const [suppressions, setSuppressions] = useState<SuppressionItem[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newReason, setNewReason] = useState<"MANUAL" | "HARD_BOUNCE" | "SPAM_COMPLAINT" | "UNSUBSCRIBE">("MANUAL");
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadSuppressions = async () => {
    try {
      const res = await fetch("/v1/suppressions", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSuppressions(data.data || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddSuppression = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail) return;

    try {
      const res = await fetch("/v1/suppressions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ email: newEmail, reason: newReason }),
      });

      if (res.ok) {
        setShowAddModal(false);
        setNewEmail("");
        setFeedback(`Blocked '${newEmail}' from receiving future emails.`);
        setTimeout(() => setFeedback(null), 3000);
        await loadSuppressions();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleUnblock = async (id: string, email: string) => {
    if (!confirm(`Unblock '${email}'? Future emails to this address will no longer be rejected.`)) {
      return;
    }

    try {
      const res = await fetch(`/v1/suppressions/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (res.ok) {
        setFeedback(`Unblocked '${email}'.`);
        setTimeout(() => setFeedback(null), 3000);
        await loadSuppressions();
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadSuppressions();
  }, [apiKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1.6rem", fontWeight: 700 }}>
            Suppression List & Reputation Guard
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: "4px" }}>
            TredMail automatically blocks sending to hard bounces and spam complaints to protect your IP sender score.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button className="btn btn-secondary btn-sm" onClick={loadSuppressions}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
            <Plus size={16} /> Block Recipient
          </button>
        </div>
      </div>

      {feedback && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(16, 185, 129, 0.1)",
            border: "1px solid rgba(16, 185, 129, 0.25)",
            borderRadius: "var(--radius-md)",
            fontSize: "0.88rem",
            color: "#34d399",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <CheckCircle2 size={16} />
          {feedback}
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Blocked Email</th>
              <th>Reason</th>
              <th>Diagnostic Info</th>
              <th>Blocked At</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {suppressions.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: "36px", color: "var(--text-muted)" }}>
                  No suppressed addresses found. Your sender reputation is pristine!
                </td>
              </tr>
            ) : (
              suppressions.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.email}</td>
                  <td>
                    <span
                      className={`badge ${
                        s.reason === "HARD_BOUNCE"
                          ? "badge-danger"
                          : s.reason === "SPAM_COMPLAINT"
                          ? "badge-danger"
                          : "badge-warning"
                      }`}
                    >
                      {s.reason.replace("_", " ")}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {s.diagnostic || "System automatic block"}
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {new Date(s.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleUnblock(s.id, s.email)}
                    >
                      Unblock
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Block Address Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Block Address from Deliveries</h3>
              <button className="copy-btn" onClick={() => setShowAddModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleAddSuppression}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Email Address</label>
                  <input
                    type="email"
                    placeholder="user@example.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label>Reason</label>
                  <select
                    value={newReason}
                    onChange={(e) => setNewReason(e.target.value as any)}
                  >
                    <option value="MANUAL">Manual Block</option>
                    <option value="HARD_BOUNCE">Hard Bounce (Invalid Mailbox)</option>
                    <option value="SPAM_COMPLAINT">Spam Complaint</option>
                    <option value="UNSUBSCRIBE">Unsubscribe</option>
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary btn-sm">
                  Add to Suppression List
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
