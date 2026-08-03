import { useState } from "react";
import { Droplets, CheckCircle, XCircle, Trash2, Loader2, Pencil } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

/**
 * Water sources tab — the console entry point that actually motivated the
 * whole operator data-management build: water_nodes silently mixes real
 * WPDx/OSM points with fabricated seed data, with zero prior way to see
 * which is which or stop a fictional point from anchoring a herder-facing
 * piosphere-ring advisory. Only `verified` points are ever eligible there
 * (see ardalink_engine/src/api/grazing.py) — this is where an operator
 * grants or revokes that.
 */
interface WaterNode {
  wpdxId: string;
  name: string;
  latitude: number;
  longitude: number;
  waterSourceType: string;
  functionalStatus: string;
  source: string | null;
  verified: boolean;
  deletedAt: string | null;
}

interface WaterNodesResponse {
  count: number;
  waterNodes: WaterNode[];
}

function authHeaders(): Record<string, string> {
  const tok = readToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

function SourceBadge({ source }: { source: string | null }) {
  if (source === "wpdx") return <Badge variant="secondary">WPDx</Badge>;
  if (source === "osm") return <Badge variant="secondary">OSM</Badge>;
  return (
    <Badge variant="destructive" title="No import source — likely fabricated seed data">
      unverified seed data
    </Badge>
  );
}

export function WaterSourcesSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WaterNode | null>(null);
  const [editName, setEditName] = useState("");

  const nodesQ = useQuery<WaterNodesResponse>({
    queryKey: ["ops-water-nodes"],
    queryFn: async () => {
      const r = await fetch("/api/ops/water-nodes", { headers: authHeaders() });
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["ops-water-nodes"] });

  const verifyM = useMutation({
    mutationFn: async ({ wpdxId, verify }: { wpdxId: string; verify: boolean }) => {
      setBusyId(wpdxId);
      const r = await fetch(
        `/api/ops/water-nodes/${encodeURIComponent(wpdxId)}/${verify ? "verify" : "unverify"}`,
        { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() } },
      );
      if (!r.ok) throw new Error(`${verify ? "verify" : "unverify"} failed: ${r.status}`);
      return r.json();
    },
    onSuccess: (_data, vars) =>
      toast({ title: vars.verify ? "Marked verified" : "Marked unverified" }),
    onError: (_err, vars) =>
      toast({ title: `Failed to ${vars.verify ? "verify" : "unverify"}`, variant: "destructive" }),
    onSettled: () => {
      setBusyId(null);
      invalidate();
    },
  });

  const deleteM = useMutation({
    mutationFn: async (wpdxId: string) => {
      setBusyId(wpdxId);
      const r = await fetch(`/api/ops/water-nodes/${encodeURIComponent(wpdxId)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error(`delete failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => toast({ title: "Water point removed" }),
    onError: () => toast({ title: "Failed to remove water point", variant: "destructive" }),
    onSettled: () => {
      setBusyId(null);
      invalidate();
    },
  });

  const editM = useMutation({
    mutationFn: async ({ wpdxId, name }: { wpdxId: string; name: string }) => {
      const r = await fetch(`/api/ops/water-nodes/${encodeURIComponent(wpdxId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`update failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Water point updated" });
      setEditing(null);
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
    onSettled: invalidate,
  });

  const rows = nodesQ.data?.waterNodes ?? [];
  // Unverified-and-not-deleted first — that's the queue an operator
  // actually needs to work through; verified/deleted rows are reference.
  const sorted = [...rows].sort((a, b) => {
    const rank = (n: WaterNode) => (n.deletedAt ? 2 : n.verified ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <Droplets className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Water Sources</h2>
          <p className="text-xs text-muted-foreground">
            Only <span className="font-medium">verified</span> points can ever
            anchor a piosphere-ring grazing advisory. Fabricated seed data
            (no import source) starts unverified — review and promote or
            delete each one.
          </p>
        </div>
      </div>

      {nodesQ.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No water sources imported yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Coordinates</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((n) => (
              <TableRow key={n.wpdxId} className={n.deletedAt ? "opacity-50" : undefined}>
                <TableCell className="font-medium">{n.name}</TableCell>
                <TableCell>
                  <SourceBadge source={n.source} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {n.waterSourceType}
                </TableCell>
                <TableCell>
                  {n.deletedAt ? (
                    <span className="text-xs text-muted-foreground">deleted</span>
                  ) : n.verified ? (
                    <span className="text-xs text-emerald-600">✓ verified</span>
                  ) : (
                    <span className="text-xs text-amber-600">unverified</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {n.latitude.toFixed(4)}, {n.longitude.toFixed(4)}
                </TableCell>
                <TableCell className="text-right">
                  {n.deletedAt ? null : (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === n.wpdxId}
                        onClick={() => {
                          setEditing(n);
                          setEditName(n.name);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant={n.verified ? "outline" : "default"}
                        disabled={busyId === n.wpdxId}
                        onClick={() =>
                          verifyM.mutate({ wpdxId: n.wpdxId, verify: !n.verified })
                        }
                      >
                        {busyId === n.wpdxId ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : n.verified ? (
                          <>
                            <XCircle className="h-3 w-3" /> Unverify
                          </>
                        ) : (
                          <>
                            <CheckCircle className="h-3 w-3" /> Verify
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === n.wpdxId}
                        onClick={() => deleteM.mutate(n.wpdxId)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit water point</DialogTitle>
          </DialogHeader>
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={editM.isPending || !editName.trim()}
              onClick={() =>
                editing && editM.mutate({ wpdxId: editing.wpdxId, name: editName.trim() })
              }
            >
              {editM.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
