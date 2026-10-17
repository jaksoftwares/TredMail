import React, { useEffect, useState } from "react";
import { Globe, Plus, CheckCircle2, AlertCircle, Copy, Check, RefreshCw, ShieldAlert, ArrowRight } from "lucide-react";

interface DnsRecord {
  recordType: string;
  type: string;
  name: string;
  expectedValue: string;
  ttl: string;
}

interface DomainItem {
  id: string;
  name: string;
  status: string;
  region: string;
  created_at: string;
  records: DnsRecord[];
}

interface DomainsProps {
  apiKey: string;
}

export const Domains: React.FC<DomainsProps> = ({ apiKey }) => {
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<DomainItem | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newDomainName, setNewDomainName] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  const loadDomains = async () => {
    try {
      const res = await fetch("/v1/domains", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setDomains(data.data || []);
        if (data.data?.length > 0 && !selectedDomain) {
          setSelectedDomain(data.data[0]);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRegisterDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomainName) return;

    try {
      const res = await fetch("/v1/domains", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ name: newDomainName }),
      });

      if (res.ok) {
        const created = await res.json();
        setShowAddModal(false);
        setNewDomainName("");
        await loadDomains();
        setSelectedDomain(created);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleVerifyDns = async (domainId: string) => {
    setVerifying(true);
    setVerifyMessage(null);
    try {
      const res = await fetch(`/v1/domains/${domainId}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json();
      if (data.report?.isFullyVerified) {
        setVerifyMessage("✅ Domain fully verified! Cryptographic handshake confirmed.");
      } else {
        setVerifyMessage("ℹ️ DNS records not yet detected globally. In local environments, records take time to propagate.");
      }
      await loadDomains();
    } catch (err: any) {
      setVerifyMessage("Verification check failed: " + err.message);
    } finally {
      setVerifying(false);
    }
  };

  const copyToClipboard = (text: string, keyId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(keyId);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  useEffect(() => {
    loadDomains();
  }, [apiKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Top action header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1.6rem", fontWeight: 700 }}>
            Domain Authentication & DNS
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: "4px" }}>
            Manage DKIM, SPF, DMARC, and Return-Path records to guarantee 99%+ inbox placement.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
          <Plus size={16} /> Add Domain
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: "24px" }}>
        {/* Domain List Sidebar */}
        <div className="card" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", padding: "4px 8px" }}>
            Registered Domains ({domains.length})
          </div>
          {domains.map((dom) => (
            <div
              key={dom.id}
              onClick={() => setSelectedDomain(dom)}
              style={{
                padding: "12px 14px",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                background: selectedDomain?.id === dom.id ? "rgba(99, 102, 241, 0.12)" : "transparent",
                border: selectedDomain?.id === dom.id ? "1px solid rgba(99, 102, 241, 0.3)" : "1px solid transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Globe size={16} color={selectedDomain?.id === dom.id ? "#818cf8" : "#94a3b8"} />
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{dom.name}</span>
              </div>
              <span className={`badge ${dom.status === "verified" ? "badge-success" : "badge-warning"}`}>
                {dom.status}
              </span>
            </div>
          ))}
        </div>

        {/* Selected Domain DNS Config View */}
        {selectedDomain ? (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "16px" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <h3 style={{ fontFamily: "var(--font-heading)", fontSize: "1.3rem", fontWeight: 700 }}>
                    {selectedDomain.name}
                  </h3>
                  <span className={`badge ${selectedDomain.status === "verified" ? "badge-success" : "badge-warning"}`}>
                    {selectedDomain.status}
                  </span>
                </div>
                <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginTop: "4px" }}>
                  Region: {selectedDomain.region} • Added on {new Date(selectedDomain.created_at).toLocaleDateString()}
                </div>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => handleVerifyDns(selectedDomain.id)}
                disabled={verifying}
              >
                <RefreshCw size={14} className={verifying ? "animate-spin" : ""} />
                {verifying ? "Verifying..." : "Verify DNS Records"}
              </button>
            </div>

            {verifyMessage && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "var(--radius-md)",
                  background: "rgba(99, 102, 241, 0.1)",
                  border: "1px solid rgba(99, 102, 241, 0.2)",
                  fontSize: "0.88rem",
                }}
              >
                {verifyMessage}
              </div>
            )}

            {/* DNS Records Explanation */}
            <div>
              <p style={{ fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                Configure these 4 DNS records in your domain provider (Cloudflare, Namecheap, GoDaddy). Once propagated, Google and Yahoo will recognize your emails as 100% authentic.
              </p>
            </div>

            {/* DNS Records Cards */}
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {selectedDomain.records.map((rec, index) => (
                <div
                  key={index}
                  style={{
                    padding: "16px",
                    background: "var(--bg-secondary)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-subtle)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="badge badge-info">{rec.recordType}</span>
                      <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                        Type: {rec.type}
                      </span>
                    </div>
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>TTL: Auto</span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "10px" }}>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                        Host / Name
                      </div>
                      <div className="code-box">
                        <span>{rec.name}</span>
                        <button
                          className="copy-btn"
                          onClick={() => copyToClipboard(rec.name, `name-${index}`)}
                        >
                          {copiedKey === `name-${index}` ? <Check size={14} color="#34d399" /> : <Copy size={14} />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                        Value / Target
                      </div>
                      <div className="code-box">
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {rec.expectedValue}
                        </span>
                        <button
                          className="copy-btn"
                          onClick={() => copyToClipboard(rec.expectedValue, `val-${index}`)}
                        >
                          {copiedKey === `val-${index}` ? <Check size={14} color="#34d399" /> : <Copy size={14} />}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "60px" }}>
            <p style={{ color: "var(--text-muted)" }}>Select or add a domain to view configuration.</p>
          </div>
        )}
      </div>

      {/* Add Domain Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Register New Sending Domain</h3>
              <button className="copy-btn" onClick={() => setShowAddModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleRegisterDomain}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Domain Name</label>
                  <input
                    type="text"
                    placeholder="e.g. yourclient.com or mail.dovepeak.com"
                    value={newDomainName}
                    onChange={(e) => setNewDomainName(e.target.value)}
                    required
                    autoFocus
                  />
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "4px" }}>
                    TredMail will automatically generate a dedicated 2048-bit RSA DKIM keypair.
                  </span>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary btn-sm">
                  Generate Cryptographic Keys
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
