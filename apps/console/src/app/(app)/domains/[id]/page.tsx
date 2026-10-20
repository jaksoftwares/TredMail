"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { DomainRow } from "@/lib/types";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, CopyButton, PageHeader, Spinner, StatusBadge } from "@/components/ui";

interface VerifyReport {
  status: string;
  report: { records: { recordType: string; verified: boolean; found?: string; error?: string }[] };
}

const RECORD_HELP: Record<string, { title: string; why: string; required: boolean }> = {
  DKIM: { title: "DKIM", why: "Proves messages from this domain were signed by TredMail. Required.", required: true },
  SPF: {
    title: "SPF",
    why: "Authorises TredMail to send for this domain. A domain can have only one SPF record: if you already have one, add the include term to it instead of creating a second record.",
    required: true,
  },
  DMARC: {
    title: "DMARC",
    why: "Tells mailbox providers what to do with mail that fails checks. If you already have a DMARC record, keep yours.",
    required: true,
  },
  RETURN_PATH: {
    title: "Return path",
    why: "Routes bounces back to TredMail. Recommended now; it becomes required when bounce processing launches.",
    required: false,
  },
};

function DomainDetailPageContent() {
  const { id } = useParams<{ id: string }>();
  const { can } = useWorkspace();
  const { data, error, mutate } = useApi<{ data: DomainRow[] }>("/v1/domains");
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!data) return <Spinner />;
  const domain = data.data.find((d) => d.id === id);
  if (!domain) return <Alert tone="danger">This domain does not exist in the current workspace.</Alert>;

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

  const resultFor = (type: string) => report?.report.records.find((r) => r.recordType === type);
  const verified = domain.status === "verified";

  return (
    <>
      <Link href="/domains" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-navy hover:underline">
        <ArrowLeft className="size-4" /> Domains
      </Link>
      <PageHeader
        title={domain.name}
        description={
          verified
            ? "Verified. You can send from any address at this domain."
            : "Add these records at your DNS provider, then verify. Changes can take from a few minutes to a few hours to appear."
        }
        actions={
          <>
            <StatusBadge status={domain.status} />
            {can.manageDomains && (
              <Button variant={verified ? "secondary" : "primary"} onClick={verify} loading={checking}>
                <RefreshCw className="size-4" />
                {verified ? "Re-check DNS" : "Verify DNS records"}
              </Button>
            )}
          </>
        }
      />

      {verifyError && <div className="mb-4"><Alert tone="danger">{verifyError}</Alert></div>}
      {report && !verified && (
        <div className="mb-4">
          <Alert tone="warning">Some records are not visible yet. Fix the ones marked below, or wait for DNS to update and try again.</Alert>
        </div>
      )}

      <div className="space-y-4">
        {domain.records.map((record) => {
          const help = RECORD_HELP[record.recordType];
          const result = resultFor(record.recordType);
          return (
            <Card key={record.recordType} className="p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="font-bold">{help.title}</h2>
                <Badge>{record.type}</Badge>
                {!help.required && <Badge tone="info">recommended</Badge>}
                {result &&
                  (result.verified ? (
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-green"><CheckCircle2 className="size-4" />Found</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-danger"><XCircle className="size-4" />Not found</span>
                  ))}
              </div>
              <p className="mb-3 text-sm text-muted">{help.why}</p>
              <div className="space-y-2">
                <RecordValue label="Name / host" value={record.name} />
                <RecordValue label="Value" value={record.expectedValue} />
              </div>
              {result && !result.verified && result.error && <p className="mt-2 text-xs text-danger">{result.error}</p>}
            </Card>
          );
        })}
      </div>
    </>
  );
}

function RecordValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
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
