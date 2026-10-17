import React, { useEffect, useState } from "react";
import { Key, Plus, Trash2, Copy, Check, ShieldCheck, AlertCircle } from "lucide-react";

interface ApiKeyItem {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt?: string;
  createdAt: string;
}

interface ApiKeysProps {
  apiKey: string;
  onUpdateActiveKey: (key: string) => void;
}

export const ApiKeys: React.FC<ApiKeysProps> = ({ apiKey, onUpdateActiveKey }) => {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = async () => {
    try {
      const res = await fetch("/v1/api-keys", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setKeys(data.data || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName) return;

    try {
      const res = await fetch("/v1/api-keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          name: newKeyName,
          scopes: ["email:send", "domains:read", "domains:write"],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setRevealedToken(data.token);
        setNewKeyName("");
        await loadKeys();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRevokeKey = async (id: string) => {
    if (!confirm("Are you sure you want to revoke this API key? Applications using it will lose access.")) {
      return;
    }

    try {
      const res = await fetch(`/v1/api-keys/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        await loadKeys();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    loadKeys();
  }, [apiKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1.6rem", fontWeight: 700 }}>
            API Keys & Authentication
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: "4px" }}>
            Create secret keys for backend services, microservices, and scripts to dispatch emails.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreateModal(true)}>
          <Plus size={16} /> Create API Key
        </button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Last Used</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)" }}>
                  No API keys registered.
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id}>
                  <td style={{ fontWeight: 600 }}>{k.name}</td>
                  <td>
                    <span className="code-box" style={{ display: "inline-block", padding: "4px 8px" }}>
                      {k.keyPrefix}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {k.scopes.map((s, idx) => (
                        <span key={idx} className="badge badge-info" style={{ fontSize: "0.68rem" }}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {new Date(k.createdAt).toLocaleDateString()}
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ color: "#ef4444" }}
                      onClick={() => handleRevokeKey(k.id)}
                    >
                      <Trash2 size={13} /> Revoke
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Secret Reveal Modal */}
      {revealedToken && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: "560px" }}>
            <div className="modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <ShieldCheck size={20} color="#34d399" />
                <h3 className="modal-title">API Key Created Successfully</h3>
              </div>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                Please copy your API key right now. For security purposes, <strong>it will never be displayed again</strong>.
              </p>

              <div className="code-box" style={{ padding: "14px", fontSize: "0.92rem", color: "#38bdf8", background: "#06090e" }}>
                <span>{revealedToken}</span>
                <button className="copy-btn" onClick={() => copyToClipboard(revealedToken)}>
                  {copied ? <Check size={16} color="#34d399" /> : <Copy size={16} />}
                </button>
              </div>

              <div
                style={{
                  padding: "12px",
                  background: "rgba(245, 158, 11, 0.1)",
                  border: "1px solid rgba(245, 158, 11, 0.2)",
                  borderRadius: "var(--radius-md)",
                  display: "flex",
                  gap: "10px",
                  fontSize: "0.8rem",
                  color: "#fbbf24",
                }}
              >
                <AlertCircle size={18} style={{ flexShrink: 0 }} />
                <span>Save this token securely in your environment variables (.env) as <code>TREDMAIL_API_KEY</code>.</span>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setRevealedToken(null);
                  setShowCreateModal(false);
                }}
              >
                I Have Saved My Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Key Modal */}
      {showCreateModal && !revealedToken && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Generate New API Key</h3>
              <button className="copy-btn" onClick={() => setShowCreateModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateKey}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Key Name / Description</label>
                  <input
                    type="text"
                    placeholder="e.g. Dovepeak Production Auth Service"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary btn-sm">
                  Generate Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
