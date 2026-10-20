"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Circle, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { DnsRecord } from "@/lib/types";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, CopyButton, Dialog, PageHeader, Spinner, StatusBadge, Table, formatDate } from "@/components/ui";

interface DomainDetail {
  id: string;
  name: string;
  status: string;
  created_at: string;
  verified_at: string | null;
  last_checked_at: string | null;
  records: DnsRecord[];
}

interface VerifyReport {
  status: string;
  report: { records: { recordType: string; verified: boolean; found?: string; error?: string }[] };
}

interface DmarcSummary {
  report_count: number;
  message_count: number;
  pass_rate: number | null;
  published_policy: string | null;
  sources: { ip: string; count: number; pass: number; fail: number; reporters: string[] }[];
}

const RECORD_HELP: Record<string, { title: string; why: string; required: boolean }> = {
  DKIM: { title: "DKIM", why: "Proves messages from this domain were signed by TredMail.", required: true },
  SPF: {
    title: "SPF",
    why: "Authorises TredMail's servers to send for this domain. A domain can have only one SPF record: if one exists (Google Workspace, Zoho, Microsoft 365), add the include term to it instead of creating a second record.",
    required: true,
  },
  DMARC: {
    title: "DMARC",
    why: "Tells mailbox providers what to do with mail that fails the checks, and sends TredMail daily reports. If you already have a DMARC record, keep yours.",
    required: true,
  },
  RETURN_PATH: {
    title: "Return path",
    why: "Bounces come back through your own domain, so SPF aligns with your From address. Recommended: it improves inbox placement.",
    required: false,
  },
};

const AUTO_CHECK_MS = 60_000;
const AUTO_CHECK_LIMIT = 30;

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <section className={`rounded-lg border bg-surface ${active ? "border-navy" : "border-line"}`}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        {done ? (
          <CheckCircle2 className="size-5 text-green" aria-hidden />
        ) : (
          <span className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${active ? "bg-navy text-offwhite" : "bg-line text-muted"}`}>{n}</span>
        )}
        <h2 className="font-bold text-navy">{title}</h2>
        {done && <span className="text-sm font-semibold text-green">Done</span>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function DomainDetailPageContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, me } = useWorkspace();
  const { data: domain, error, mutate } = useApi<DomainDetail>(`/v1/domains/${id}`);
  const { data: dmarc } = useApi<DmarcSummary>(domain?.status === "verified" ? `/v1/domains/${id}/dmarc?days=30` : null);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [fullNames, setFullNames] = useState(false);
  const [testState, setTestState] = useState<{ tone: "success" | "danger"; text: string; id?: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const autoChecks = useRef(0);

  const verified = domain?.status === "verified";

  async function verify() {
    setChecking(true);
    setVerifyError(null);
    try {
      setReport(await api<VerifyReport>(`/v1/domains/${id}/verify`, { method: "POST", body: {} }));
      await mutate();
    } catch (err) {
      setVerifyError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  // While the page is open and the domain is pending, re-check once a minute for half an hour.
  useEffect(() => {
    if (!domain || verified || !can.manageDomains) return;
    const timer = setInterval(() => {
      if (autoChecks.current >= AUTO_CHECK_LIMIT || document.hidden) return;
      autoChecks.current++;
      void verify();
    }, AUTO_CHECK_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain?.id, verified, can.manageDomains]);

  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!domain) return <Spinner />;

  const resultFor = (type: string) => report?.report.records.find((r) => r.recordType === type);
  const isFound = (record: DnsRecord) => resultFor(record.recordType)?.verified ?? record.verified ?? false;
  const requiredDone = domain.records.filter((r) => RECORD_HELP[r.recordType]?.required).every(isFound);

  async function sendTest() {
    setTestState(null);
    try {
      const result = await api<{ id: string }>("/v1/emails", {
        method: "POST",
        body: {
          from: `TredMail test <test@${domain!.name}>`,
          to: me.user.email,
          subject: `Test from ${domain!.name}`,
          text: `This test was sent from ${domain!.name} through TredMail. If it reached your inbox, the domain is ready.`,
          html: `<p>This test was sent from <strong>${domain!.name}</strong> through TredMail.</p><p>If it reached your inbox, the domain is ready.</p>`,
          tags: [{ name: "category", value: "domain-test" }],
        },
      });
      setTestState({ tone: "success", text: `Sent to ${me.user.email}.`, id: result.id });
    } catch (err) {
      setTestState({ tone: "danger", text: errorMessage(err) });
    }
  }

  async function remove() {
    try {
      await api(`/v1/domains/${id}`, { method: "DELETE" });
      router.push("/domains");
    } catch (err) {
      setVerifyError(errorMessage(err));
      setDeleteOpen(false);
    }
  }

  return (
    <>
      <Link href="/domains" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-navy hover:underline">
        <ArrowLeft className="size-4" /> Domains
      </Link>
      <PageHeader
        title={domain.name}
        description={
          verified
            ? `Verified ${domain.verified_at ? formatDate(domain.verified_at) : ""}. You can send from any address at this domain.`
            : "Three steps: publish the records, verify, send a test."
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={domain.status} />
            {can.manageDomains && (
              <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="size-3.5" />Delete
              </Button>
            )}
          </div>
        }
      />
      {verifyError && <div className="mb-4"><Alert tone="danger">{verifyError}</Alert></div>}

      <div className="space-y-4">
        <Step n={1} title="Add these records at your DNS provider" done={requiredDone} active={!requiredDone}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm text-muted">
              In Namecheap, GoDaddy, Hostinger and most panels, put the <strong>Host</strong> value in the Host or Name field: the panel adds{" "}
              <span className="font-mono">{domain.name}</span> itself. In Cloudflare, set DKIM and the return path to <strong>DNS only</strong> (grey cloud).
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-orange" checked={fullNames} onChange={(e) => setFullNames(e.target.checked)} />
              Show full names
            </label>
          </div>
          <div className="space-y-4">
            {domain.records.map((record) => {
              const help = RECORD_HELP[record.recordType];
              const result = resultFor(record.recordType);
              const found = isFound(record);
              return (
                <Card key={record.recordType} className="p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {found ? <CheckCircle2 className="size-4 text-green" aria-label="Found" /> : <Circle className="size-4 text-subtle" aria-label="Not found yet" />}
                    <h3 className="font-bold">{help.title}</h3>
                    <Badge>{record.type}</Badge>
                    {!help.required && <Badge tone="info">recommended</Badge>}
                  </div>
                  <p className="mb-3 text-sm text-muted">{help.why}</p>
                  <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                    <RecordValue label={fullNames ? "Name" : "Host"} value={fullNames ? record.name : record.host} />
                    <RecordValue label="Value" value={record.expectedValue} />
                  </div>
                  {result && !result.verified && result.error && (
                    <p className="mt-2 flex items-start gap-1 text-xs text-danger"><XCircle className="mt-px size-3.5 shrink-0" />{result.error}</p>
                  )}
                </Card>
              );
            })}
          </div>
        </Step>

        <Step n={2} title="Verify" done={verified} active={requiredDone && !verified}>
          <div className="flex flex-wrap items-center gap-3">
            {can.manageDomains ? (
              <Button variant={verified ? "secondary" : "primary"} onClick={verify} loading={checking}>
                <RefreshCw className="size-4" />
                {verified ? "Re-check DNS" : "Verify now"}
              </Button>
            ) : (
              <p className="text-sm text-muted">Ask a workspace Owner or Admin to verify the domain.</p>
            )}
            <p className="text-sm text-muted">
              {verified
                ? "All required records were found."
                : `DNS changes usually appear within 30 minutes. This page re-checks every minute while it is open.${
                    domain.last_checked_at ? ` Last checked ${formatDate(domain.last_checked_at)}.` : ""
                  }`}
            </p>
          </div>
        </Step>

        <Step n={3} title="Send a test" done={testState?.tone === "success"} active={verified && testState?.tone !== "success"}>
          {verified ? (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                Sends a short message from <span className="font-mono">test@{domain.name}</span> to {me.user.email}. Check it arrived in the inbox, not spam.
              </p>
              {testState && (
                <Alert tone={testState.tone}>
                  {testState.text}{" "}
                  {testState.id && <Link href={`/emails/${testState.id}`} className="font-semibold underline">Follow its delivery</Link>}
                </Alert>
              )}
              {can.send && (
                <Button variant="secondary" onClick={sendTest}>
                  <Send className="size-4" />Send test email
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">Available once the domain is verified.</p>
          )}
        </Step>

        {verified && (
          <Card>
            <div className="border-b border-line px-4 py-3">
              <h2 className="font-bold text-navy">DMARC reports, last 30 days</h2>
              <p className="text-xs text-muted">Mailbox providers send these daily when the domain&apos;s DMARC record has TredMail&apos;s rua= address.</p>
            </div>
            {!dmarc ? (
              <Spinner />
            ) : dmarc.report_count === 0 ? (
              <p className="p-4 text-sm text-muted">No reports yet. The first ones usually arrive one to two days after you start sending.</p>
            ) : (
              <>
                <div className="grid gap-4 p-4 sm:grid-cols-3">
                  <Metric label="Messages reported" value={dmarc.message_count.toLocaleString()} />
                  <Metric label="Passed DMARC" value={dmarc.pass_rate === null ? "n/a" : `${dmarc.pass_rate}%`} />
                  <Metric label="Published policy" value={dmarc.published_policy ?? "n/a"} />
                </div>
                <Table head={["Sending IP", "Messages", "Passed", "Failed", "Reported by"]}>
                  {dmarc.sources.slice(0, 10).map((s) => (
                    <tr key={s.ip}>
                      <td className="px-4 py-2 font-mono text-xs">{s.ip}</td>
                      <td className="px-4 py-2">{s.count}</td>
                      <td className="px-4 py-2 text-green">{s.pass}</td>
                      <td className={`px-4 py-2 ${s.fail ? "font-semibold text-danger" : "text-muted"}`}>{s.fail}</td>
                      <td className="px-4 py-2 text-muted">{s.reporters.join(", ")}</td>
                    </tr>
                  ))}
                </Table>
                <p className="border-t border-line px-4 py-3 text-xs text-muted">
                  Failures from IPs you recognise mean another service sends as this domain without DKIM or SPF: add it to SPF or set up DKIM there. Unknown IPs may be spoofing; a{" "}
                  <span className="font-mono">p=quarantine</span> policy stops them.
                </p>
              </>
            )}
          </Card>
        )}
      </div>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title={`Delete ${domain.name}?`}>
        <p className="text-sm text-muted">Sending from this domain stops at once, and its email history in TredMail is deleted. You can add the domain again later, with new DNS records.</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteOpen(false)}>Keep it</Button>
          <Button variant="danger" onClick={remove}>Delete domain</Button>
        </div>
      </Dialog>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-2xl font-bold text-navy">{value}</p>
    </div>
  );
}

function RecordValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-offwhite px-3 py-2 font-mono text-xs">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

// useParams() reads URL data that only exists at request time, so it must render inside Suspense.
export default function DomainDetailPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <DomainDetailPageContent />
    </Suspense>
  );
}
