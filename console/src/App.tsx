import React, { useState } from "react";
import {
  LayoutDashboard,
  Mail,
  Globe,
  Key,
  Send,
  ExternalLink,
  ShieldCheck,
  ShieldAlert,
  Webhook,
  ChevronRight,
} from "lucide-react";
import { Overview } from "./components/Overview";
import { Emails } from "./components/Emails";
import { Domains } from "./components/Domains";
import { ApiKeys } from "./components/ApiKeys";
import { SendTest } from "./components/SendTest";
import { Webhooks } from "./components/Webhooks";
import { Suppressions } from "./components/Suppressions";

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<
    "overview" | "emails" | "domains" | "keys" | "webhooks" | "suppressions" | "send"
  >("overview");
  const [apiKey, setApiKey] = useState<string>("tred_live_REDACTED_REVOKED");
  const [inspectedEmailId, setInspectedEmailId] = useState<string | null>(null);

  const handleSelectEmail = (id: string) => {
    setInspectedEmailId(id);
    setCurrentTab("emails");
  };

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-icon">
            <Mail size={20} />
          </div>
          <div className="brand-text">
            <h1>TredMail</h1>
            <span>Dovepeak Cloud</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div
            className={`nav-item ${currentTab === "overview" ? "active" : ""}`}
            onClick={() => setCurrentTab("overview")}
          >
            <LayoutDashboard size={18} />
            <span>Overview</span>
          </div>

          <div
            className={`nav-item ${currentTab === "emails" ? "active" : ""}`}
            onClick={() => setCurrentTab("emails")}
          >
            <Mail size={18} />
            <span>Emails</span>
          </div>

          <div
            className={`nav-item ${currentTab === "domains" ? "active" : ""}`}
            onClick={() => setCurrentTab("domains")}
          >
            <Globe size={18} />
            <span>Domains</span>
          </div>

          <div
            className={`nav-item ${currentTab === "keys" ? "active" : ""}`}
            onClick={() => setCurrentTab("keys")}
          >
            <Key size={18} />
            <span>API Keys</span>
          </div>

          <div
            className={`nav-item ${currentTab === "webhooks" ? "active" : ""}`}
            onClick={() => setCurrentTab("webhooks")}
          >
            <Webhook size={18} />
            <span>Webhooks</span>
          </div>

          <div
            className={`nav-item ${currentTab === "suppressions" ? "active" : ""}`}
            onClick={() => setCurrentTab("suppressions")}
          >
            <ShieldAlert size={18} />
            <span>Suppressions</span>
          </div>

          <div
            className={`nav-item ${currentTab === "send" ? "active" : ""}`}
            onClick={() => setCurrentTab("send")}
          >
            <Send size={18} />
            <span>Send Test</span>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="status-indicator">
            <div className="status-dot"></div>
            <span>MTA Operational</span>
          </div>
          <a
            href="http://localhost:8035"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--text-muted)", textDecoration: "none" }}
            title="Open Mailpit Web Interface"
          >
            <ExternalLink size={14} />
          </a>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-wrapper">
        <header className="top-bar">
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-muted)", fontSize: "0.85rem" }}>
            <span>Dovepeak Technology</span>
            <ChevronRight size={14} />
            <span style={{ color: "var(--text-primary)", fontWeight: 600, textTransform: "capitalize" }}>
              {currentTab}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span className="badge badge-success" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <ShieldCheck size={14} />
              DKIM RSA-2048 Active
            </span>
            <a
              href="http://localhost:8035"
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-sm"
              style={{ fontSize: "0.78rem" }}
            >
              Mailpit Inbox (:8035) <ExternalLink size={12} />
            </a>
          </div>
        </header>

        <div className="content-container">
          {currentTab === "overview" && (
            <Overview apiKey={apiKey} onSelectEmail={handleSelectEmail} />
          )}

          {currentTab === "emails" && (
            <Emails
              apiKey={apiKey}
              selectedEmailId={inspectedEmailId}
              onClearSelectedEmail={() => setInspectedEmailId(null)}
            />
          )}

          {currentTab === "domains" && <Domains apiKey={apiKey} />}

          {currentTab === "keys" && (
            <ApiKeys apiKey={apiKey} onUpdateActiveKey={setApiKey} />
          )}

          {currentTab === "webhooks" && <Webhooks apiKey={apiKey} />}

          {currentTab === "suppressions" && <Suppressions apiKey={apiKey} />}

          {currentTab === "send" && (
            <SendTest apiKey={apiKey} onEmailSent={handleSelectEmail} />
          )}
        </div>
      </main>
    </div>
  );
};
