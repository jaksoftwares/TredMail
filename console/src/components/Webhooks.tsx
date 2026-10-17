import React, { useEffect, useState } from "react";
import { Webhook, Plus, Trash2, Send, Copy, Check, CheckCircle2, ShieldCheck, RefreshCw } from "lucide-react";

interface WebhookItem {
  id: string;
  url: string;
  secret: string;
  subscribed_to: string[];
  is_active: boolean;
  total_deliveries: number;
  created_at: string;
}

interface WebhooksProps {
  apiKey: string;
}

export const Webhooks: React.FC<WebhooksProps> = ({ apiKey }) => {
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["email.delivered", "email.bounced"]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pingStatus, setPingStatus] = useState<string | null>(null);

  const loadWebhooks = async () => {
    try {
      const res = await fetch("/v1/webhooks", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setWebhooks(data.data || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    try {
      const res = await fetch("/v1/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url, subscribed_to: events }),
      });

      if (res.ok) {
        setShowAddModal(false);
        setUrl("");
        await loadWebhooks();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    if (!confirm("Are you sure you want to delete this webhook endpoint?")) return;

    try {
      const res = await fetch(`/v1/webhooks/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        await loadWebhooks();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTestPing = async (id: string) => {
    setPingStatus("Dispatching ping...");
    try {
      const res = await fetch(`/v1/webhooks/${id}/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json();
      setPingStatus(data.message || "Test ping sent!");
      setTimeout(() => setPingStatus(null), 4000);
      await loadWebhooks();
    } catch (err: any) {
      setPingStatus("Failed to send ping: " + err.message);
    }
  };

  const copySecret = (secret: string, id: string) => {
    navigator.clipboard.writeText(secret);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleEvent = (evt: string) => {
    if (events.includes(evt)) {
      setEvents(events.filter((e) => e !== evt));
    } else {
      setEvents([...events, evt]);
    }
  };

  useEffect(() => {
    loadWebhooks();
  }, [apiKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1.6rem", fontWeight: 700 }}>
            Webhooks & Real-Time Event Stream
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: "4px" }}>
            Notify your backend services whenever an email is delivered, opened, clicked, or bounced.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button className="btn btn-secondary btn-sm" onClick={loadWebhooks}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
            <Plus size={16} /> Add Webhook Endpoint
          </button>
        </div>
      </div>

      {pingStatus && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(99, 102, 241, 0.1)",
            border: "1px solid rgba(99, 102, 241, 0.25)",
            borderRadius: "var(--radius-md)",
            fontSize: "0.88rem",
            color: "#818cf8",
          }}
        >
          {pingStatus}
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Endpoint URL</th>
              <th>Subscribed Events</th>
              <th>HMAC Secret</th>
              <th>Deliveries</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {webhooks.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "36px", color: "var(--text-muted)" }}>
                  No webhook endpoints configured. Add a webhook URL to receive live JSON event streams!
                </td>
              </tr>
            ) : (
              webhooks.map((w) => (
                <tr key={w.id}>
                  <td style={{ fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
                    {w.url}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {w.subscribed_to.map((evt, idx) => (
                        <span key={idx} className="badge badge-info" style={{ fontSize: "0.68rem" }}>
                          {evt}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ padding: "4px 8px", fontSize: "0.75rem" }}
                      onClick={() => copySecret(w.secret, w.id)}
                    >
                      {copiedId === w.id ? (
                        <>
                          <Check size={12} color="#34d399" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy size={12} /> Copy Secret
                        </>
                      )}
                    </button>
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>{w.total_deliveries} events</td>
                  <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {new Date(w.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleTestPing(w.id)}
                        title="Dispatch test event ping"
                      >
                        <Send size={12} /> Ping
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ color: "#ef4444" }}
                        onClick={() => handleDeleteWebhook(w.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add Webhook Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Register Webhook Endpoint</h3>
              <button className="copy-btn" onClick={() => setShowAddModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateWebhook}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Endpoint URL (Must be HTTPS in production)</label>
                  <input
                    type="url"
                    placeholder="https://api.yourdomain.com/webhooks/tredmail"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    required
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label>Subscribed Events</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "6px" }}>
                    {["email.delivered", "email.opened", "email.clicked", "email.bounced"].map((evt) => (
                      <label
                        key={evt}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "10px",
                          background: "var(--bg-input)",
                          borderRadius: "var(--radius-md)",
                          border: "1px solid var(--border-subtle)",
                          cursor: "pointer",
                          fontSize: "0.82rem",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={events.includes(evt)}
                          onChange={() => toggleEvent(evt)}
                          style={{ accentColor: "var(--accent-primary)" }}
                        />
                        {evt}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary btn-sm">
                  Register Endpoint
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
