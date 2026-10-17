import React, { useEffect, useState } from "react";
import { Mail, CheckCircle2, Eye, MousePointerClick, AlertTriangle, ArrowUpRight, Server, ShieldCheck, RefreshCw } from "lucide-react";

interface Metrics {
  totalEmails: number;
  deliveredCount: number;
  bouncedCount: number;
  openedEvents: number;
  clickedEvents: number;
  deliveryRate: string;
  openRate: string;
  clickRate: string;
  bounceRate: string;
}

interface RecentEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  status: string;
  createdAt: string;
}

interface OverviewProps {
  apiKey: string;
  onSelectEmail: (id: string) => void;
}

export const Overview: React.FC<OverviewProps> = ({ apiKey, onSelectEmail }) => {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [recentEmails, setRecentEmails] = useState<RecentEmail[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    try {
      const res = await fetch("/v1/stats", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data.metrics);
        setRecentEmails(data.recentEmails || []);
      }
    } catch (err) {
      console.error("Failed to load stats", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000); // 5s auto-refresh
    return () => clearInterval(interval);
  }, [apiKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Header with live refresh */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1.6rem", fontWeight: 700 }}>
            System Performance & Deliverability
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: "4px" }}>
            Real-time telemetry from TredMail transactional cluster.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={fetchStats}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Primary KPI Grid */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-header">
            <span>Total Ingested</span>
            <Mail size={16} color="var(--accent-primary)" />
          </div>
          <div className="metric-value">{metrics?.totalEmails ?? 0}</div>
          <div className="metric-sub" style={{ color: "var(--text-muted)" }}>
            Lifetime volume
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Delivery Rate</span>
            <CheckCircle2 size={16} color="var(--accent-success)" />
          </div>
          <div className="metric-value" style={{ color: "#34d399" }}>
            {metrics?.deliveryRate ?? "100.0%"}
          </div>
          <div className="metric-sub">
            {metrics?.deliveredCount ?? 0} delivered
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Open Rate</span>
            <Eye size={16} color="var(--accent-secondary)" />
          </div>
          <div className="metric-value" style={{ color: "#38bdf8" }}>
            {metrics?.openRate ?? "0.0%"}
          </div>
          <div className="metric-sub">
            {metrics?.openedEvents ?? 0} opens tracked
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Bounce Rate</span>
            <AlertTriangle size={16} color="var(--accent-warning)" />
          </div>
          <div className="metric-value" style={{ color: "#f87171" }}>
            {metrics?.bounceRate ?? "0.00%"}
          </div>
          <div className="metric-sub" style={{ color: "var(--text-muted)" }}>
            Target &lt; 0.10%
          </div>
        </div>
      </div>

      {/* Infrastructure Node Health Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
        <div className="card" style={{ padding: "18px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Server size={18} color="#818cf8" />
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>PostgreSQL Cluster</div>
                <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Port :5435 (Docker)</div>
              </div>
            </div>
            <span className="badge badge-success">Online</span>
          </div>
        </div>

        <div className="card" style={{ padding: "18px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Server size={18} color="#06b6d4" />
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>Redis BullMQ Ingestion</div>
                <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Port :6389 (Active)</div>
              </div>
            </div>
            <span className="badge badge-success">Active</span>
          </div>
        </div>

        <div className="card" style={{ padding: "18px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <ShieldCheck size={18} color="#10b981" />
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>Mailpit Test Inbox</div>
                <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Port :1035 / Web :8035</div>
              </div>
            </div>
            <a
              href="http://localhost:8035"
              target="_blank"
              rel="noreferrer"
              className="badge badge-info"
              style={{ textDecoration: "none", cursor: "pointer" }}
            >
              Open Web UI <ArrowUpRight size={10} style={{ marginLeft: "2px" }} />
            </a>
          </div>
        </div>
      </div>

      {/* Recent Activity Table */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontFamily: "var(--font-heading)", fontSize: "1.05rem", fontWeight: 700 }}>
              Live Delivery Stream
            </h3>
            <p style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
              Recent emails processed by TredMail worker pipeline
            </p>
          </div>
        </div>

        <div className="table-container" style={{ border: "none", borderRadius: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Sent At</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {recentEmails.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)" }}>
                    No emails sent yet. Use the "Send Test Email" tool to send your first message!
                  </td>
                </tr>
              ) : (
                recentEmails.map((email) => (
                  <tr key={email.id}>
                    <td style={{ fontWeight: 600, color: "#f8fafc" }}>
                      {email.to.join(", ")}
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>{email.subject}</td>
                    <td>
                      <span className={`badge ${email.status === "DELIVERED" ? "badge-success" : email.status === "QUEUED" ? "badge-info" : "badge-danger"}`}>
                        {email.status}
                      </span>
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                      {new Date(email.createdAt).toLocaleTimeString()}
                    </td>
                    <td>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => onSelectEmail(email.id)}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
