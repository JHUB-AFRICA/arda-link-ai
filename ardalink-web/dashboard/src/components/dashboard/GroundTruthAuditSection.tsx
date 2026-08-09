import { useState } from "react";
import { ShieldCheck, Loader2, Pencil } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { readToken } from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

/**
 * Ground-truth audit/correction panel. ground_truth_calls is deliberately
 * append-only (nothing here ever PATCHes it) — corrections are a
 * separate, additive layer (ground_truth_corrections, one row per
 * corrected field) that some downstream consumers (currently: the
 * water-point-status overlay used by herderContext) prefer over the raw
 * value when present. See migration 0009's header for the full rationale.
 */
const CORRECTABLE_FIELDS = [
  "bcs_score",
  "water_point_status",
  "mortality_rate",
  "offtake_rate",
  "milk_production_liters",
  "water_trek_distance_km",
] as const;

interface Correction {
  id: number;
  call_id: string;
  corrected_by: string;
  corrected_at: string;
  field: string;
  original_value: string | null;
  corrected_value: string;
  reason: string;
}

interface GroundTruthCallRow {
  call_id: string;
  ward_id: string;
  call_timestamp: string;
  bcs_score: number | null;
  water_point_name: string | null;
  water_point_status: string | null;
  mortality_rate: number | null;
  offtake_rate: number | null;
  channel: string | null;
  pastoralists?: { full_name: string | null; phone_number: string | null } | null;
  corrections: Correction[];
}

interface GroundTruthRecentResponse {
  ready: boolean;
  count: number;
  calls: GroundTruthCallRow[];
  reason?: string;
}

function authHeaders(): Record<string, string> {
  const tok = readToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

export function GroundTruthAuditSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [correcting, setCorrecting] = useState<GroundTruthCallRow | null>(null);
  const [field, setField] = useState<string>("water_point_status");
  const [correctedValue, setCorrectedValue] = useState("");
  const [reason, setReason] = useState("");

  const callsQ = useQuery<GroundTruthRecentResponse>({
    queryKey: ["ops-ground-truth-recent"],
    queryFn: async () => {
      const r = await fetch("/api/ops/ground-truth/recent?limit=30", {
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
  });

  const correctM = useMutation({
    mutationFn: async () => {
      if (!correcting) throw new Error("no call selected");
      const original = (correcting as unknown as Record<string, unknown>)[field];
      const r = await fetch(`/api/ops/ground-truth/${correcting.call_id}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          field,
          correctedValue,
          originalValue: original == null ? null : String(original),
          reason,
        }),
      });
      if (!r.ok) throw new Error(`correct failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Correction recorded" });
      setCorrecting(null);
      setCorrectedValue("");
      setReason("");
    },
    onError: () => toast({ title: "Failed to record correction", variant: "destructive" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["ops-ground-truth-recent"] }),
  });

  const rows = callsQ.data?.calls ?? [];

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Ground Truth Audit</h2>
          <p className="text-xs text-muted-foreground">
            LLM-extracted indicators flow in unreviewed. Correcting a field
            here never mutates the original call — it adds an attributed
            correction that downstream consumers prefer over the raw value.
          </p>
        </div>
      </div>

      {callsQ.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !callsQ.data?.ready ? (
        <p className="text-sm text-muted-foreground">
          Not ready: <span className="font-mono">{callsQ.data?.reason ?? "unknown"}</span>
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ground-truth calls yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Herder</TableHead>
              <TableHead>Ward</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Water point</TableHead>
              <TableHead>Water status</TableHead>
              <TableHead>BCS</TableHead>
              <TableHead>Corrections</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.call_id}>
                <TableCell className="text-xs">
                  {c.pastoralists?.full_name ?? c.pastoralists?.phone_number ?? "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{c.ward_id}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {c.channel ?? "voice"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {c.water_point_name ?? "—"}
                </TableCell>
                <TableCell className="text-xs">{c.water_point_status ?? "—"}</TableCell>
                <TableCell className="text-xs">{c.bcs_score ?? "—"}</TableCell>
                <TableCell>
                  {c.corrections.length > 0 ? (
                    <Badge variant="secondary">{c.corrections.length} correction(s)</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">none</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCorrecting(c);
                      setField("water_point_status");
                      setCorrectedValue("");
                      setReason("");
                    }}
                  >
                    <Pencil className="h-3 w-3" /> Correct
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={!!correcting} onOpenChange={(open) => !open && setCorrecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct ground-truth field</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Field</label>
              <Select value={field} onValueChange={setField}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CORRECTABLE_FIELDS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Corrected value
              </label>
              <Input
                value={correctedValue}
                onChange={(e) => setCorrectedValue(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Reason (required)
              </label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrecting(null)}>
              Cancel
            </Button>
            <Button
              disabled={correctM.isPending || !correctedValue.trim() || !reason.trim()}
              onClick={() => correctM.mutate()}
            >
              {correctM.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save correction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
