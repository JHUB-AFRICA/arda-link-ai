import { useState } from "react";
import { History } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { readToken } from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Every write anywhere in the operator console lands here — the
 * accountability surface tying Water Sources / Species Radii /
 * Ground Truth Audit / Pastoralists together. See migration 0008's
 * header: nothing else reads this table back, it's pure audit trail.
 */
const RESOURCE_FILTERS = [
  "all",
  "water_node",
  "species_ring_radii",
  "ground_truth_correction",
  "pastoralist",
  "pastoralist_lead",
] as const;

interface AuditEntry {
  id: number;
  actor_sub: string;
  tenant_id: string;
  resource: string;
  resource_id: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  created_at: string;
}

interface AuditLogResponse {
  count: number;
  entries: AuditEntry[];
}

function authHeaders(): Record<string, string> {
  const tok = readToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

function formatRel(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function AuditLogSection() {
  const [resource, setResource] = useState<string>("all");

  const logQ = useQuery<AuditLogResponse>({
    queryKey: ["ops-audit-log", resource],
    queryFn: async () => {
      const qs = new URLSearchParams({ limit: "100" });
      if (resource !== "all") qs.set("resource", resource);
      const r = await fetch(`/api/ops/audit-log?${qs.toString()}`, {
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error(`audit-log failed: ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const rows = logQ.data?.entries ?? [];

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <History className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Audit Log</h2>
            <p className="text-xs text-muted-foreground">
              Who changed what, when, why — every write in this console.
            </p>
          </div>
        </div>
        <Select value={resource} onValueChange={setResource}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOURCE_FILTERS.map((r) => (
              <SelectItem key={r} value={r}>
                {r === "all" ? "All resources" : r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {logQ.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No audit entries yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRel(e.created_at)}
                </TableCell>
                <TableCell className="text-xs">{e.actor_sub}</TableCell>
                <TableCell className="text-xs">
                  {e.resource} <span className="text-muted-foreground">/ {e.resource_id}</span>
                </TableCell>
                <TableCell className="text-xs capitalize">{e.action}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {e.reason ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
