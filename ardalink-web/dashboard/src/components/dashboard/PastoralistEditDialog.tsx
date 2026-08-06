import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readToken } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { Pastoralist } from "./PastoralistsTab";

/**
 * Pastoralist edit — completes the create/delete-only surface that
 * existed before the operator data-management console. Uses a plain
 * fetch PATCH, matching the pattern already established for other
 * ops-panel action endpoints (LeadsSection.tsx's verify/decline).
 *
 * **Rewritten 2026-08-06** alongside the rest of the Pastoralists tab:
 * the real Supabase `pastoralists` table has one `herd_size` total, no
 * per-species breakdown, no `waterSource`, and no `alertsEnabled`
 * column at all (that field only exists on the separate
 * `pastoralist_leads` table) — the fields this dialog edited before
 * were the *local mirror's* shape, not the real one, and editing them
 * here had zero effect on what a herder actually experiences.
 */
export function PastoralistEditDialog({
  pastoralist,
  onClose,
}: {
  pastoralist: Pastoralist | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [herdSize, setHerdSize] = useState("");

  useEffect(() => {
    if (pastoralist) {
      setName(pastoralist.name);
      setPhone(pastoralist.phone);
      setLocation(pastoralist.location ?? "");
      setHerdSize(pastoralist.herdSize != null ? String(pastoralist.herdSize) : "");
    }
  }, [pastoralist]);

  const updateM = useMutation({
    mutationFn: async () => {
      if (!pastoralist) throw new Error("no pastoralist selected");
      const tok = readToken();
      const r = await fetch(`/api/pastoralists/${pastoralist.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          name,
          phone,
          location,
          herdSize: herdSize === "" ? undefined : Number(herdSize),
        }),
      });
      if (!r.ok) throw new Error(`update failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Pastoralist updated" });
      qc.invalidateQueries({ queryKey: ["pastoralists"] });
      onClose();
    },
    onError: () => toast({ title: "Failed to update pastoralist", variant: "destructive" }),
  });

  return (
    <Dialog open={!!pastoralist} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit herder</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" />
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location"
          />
          <Input
            type="number"
            min="0"
            value={herdSize}
            onChange={(e) => setHerdSize(e.target.value)}
            placeholder="Herd size"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={updateM.isPending || !name.trim()} onClick={() => updateM.mutate()}>
            {updateM.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
