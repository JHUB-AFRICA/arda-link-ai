import { UserPlus, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { readToken } from "@workspace/api-client-react";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Ops panel for pastoralist_leads. Table of self-enrolled subscribers
 * with verify / decline actions. Verify creates a real pastoralists
 * row via /api/ops/leads/:id/verify (which also sends the welcome
 * SMS); decline flips status='declined' so the identity view stops
 * routing them.
 */
interface LeadRow {
  lead_id: string;
  phone_number: string;
  full_name: string | null;
  preferred_language: "sw" | "en" | null;
  ward_id: string | null;
  location_text: string | null;
  enrollment_source: string;
  status: string;
  first_contact_at: string;
  last_contact_at: string;
  verified_at: string | null;
  verified_by: string | null;
  promoted_pastoralist_id: string | null;
  notes: string | null;
}

interface LeadsResponse {
  ready: boolean;
  count: number;
  leads: LeadRow[];
  reason?: string;
}

export default function LeadsSection() {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const leadsQ = useQuery<LeadsResponse>({
    queryKey: ["ops-leads"],
    queryFn: async () => {
      const tok = readToken();
      const r = await fetch("/api/ops/leads?limit=100", {
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const verifyM = useMutation({
    mutationFn: async (leadId: string) => {
      setBusyId(leadId);
      const tok = readToken();
      const r = await fetch(`/api/ops/leads/${leadId}/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`verify failed: ${r.status}`);
      return r.json();
    },
    onSettled: () => {
      setBusyId(null);
      qc.invalidateQueries({ queryKey: ["ops-leads"] });
    },
  });

  const declineM = useMutation({
    mutationFn: async (leadId: string) => {
      setBusyId(leadId);
      const tok = readToken();
      const r = await fetch(`/api/ops/leads/${leadId}/decline`, {
        method: "POST",
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
      if (!r.ok) throw new Error(`decline failed: ${r.status}`);
      return r.json();
    },
    onSettled: () => {
      setBusyId(null);
      qc.invalidateQueries({ queryKey: ["ops-leads"] });
    },
  });

  const rows = leadsQ.data?.leads ?? [];

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <UserPlus className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Leads</h2>
          <p className="text-xs text-muted-foreground">
            Self-enrolled via USSD / SMS. Verify to promote into
            pastoralists (fires a welcome SMS).
          </p>
        </div>
      </div>

      {leadsQ.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !leadsQ.data?.ready ? (
        <p className="text-sm text-muted-foreground">
          Not ready:{" "}
          <span className="font-mono">
            {leadsQ.data?.reason ?? "unknown"}
          </span>
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No leads yet. As herders self-enrol via USSD (5. Jisajili) they
          show up here.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phone</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Ward</TableHead>
              <TableHead>Lang</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.lead_id}>
                <TableCell className="font-mono text-xs">
                  {r.phone_number}
                </TableCell>
                <TableCell>{r.full_name ?? "—"}</TableCell>
                <TableCell>
                  {r.location_text ?? r.ward_id ?? "—"}
                </TableCell>
                <TableCell>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs uppercase">
                    {r.preferred_language ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.enrollment_source}
                </TableCell>
                <TableCell>
                  <StatusPill status={r.status} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRel(r.first_contact_at)}
                </TableCell>
                <TableCell className="text-right">
                  {r.status === "verified" ? (
                    <span className="text-xs text-emerald-600">✓ verified</span>
                  ) : r.status === "declined" ? (
                    <span className="text-xs text-muted-foreground">declined</span>
                  ) : (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={busyId === r.lead_id}
                        onClick={() => verifyM.mutate(r.lead_id)}
                      >
                        {busyId === r.lead_id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <CheckCircle className="h-3 w-3" /> Verify
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === r.lead_id}
                        onClick={() => declineM.mutate(r.lead_id)}
                      >
                        <XCircle className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls: Record<string, string> = {
    lead: "bg-amber-100 text-amber-800",
    contacted: "bg-blue-100 text-blue-800",
    verified: "bg-emerald-100 text-emerald-800",
    declined: "bg-slate-100 text-slate-600",
    opted_out: "bg-red-100 text-red-800",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs ${cls[status] ?? "bg-muted"}`}
    >
      {status}
    </span>
  );
}

function formatRel(ts: string): string {
  const d = new Date(ts).getTime();
  const diffMs = Date.now() - d;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}
