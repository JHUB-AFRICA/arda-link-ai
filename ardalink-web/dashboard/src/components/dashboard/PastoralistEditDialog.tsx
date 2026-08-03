import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readToken, getListPastoralistsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

/**
 * Pastoralist edit — completes the create/delete-only surface that
 * existed before the operator data-management console. Uses a plain
 * fetch PATCH (not @workspace/api-client-react's generated hooks, which
 * only cover GET/POST/DELETE for this resource) — matches the pattern
 * already established for other ops-panel action endpoints
 * (LeadsSection.tsx's verify/decline).
 */
interface Pastoralist {
  id: number;
  name: string;
  phone: string;
  location: string | null;
  waterSource: string | null;
  alertsEnabled: boolean;
}

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
  const [waterSource, setWaterSource] = useState("");
  const [alertsEnabled, setAlertsEnabled] = useState(true);

  useEffect(() => {
    if (pastoralist) {
      setName(pastoralist.name);
      setPhone(pastoralist.phone);
      setLocation(pastoralist.location ?? "");
      setWaterSource(pastoralist.waterSource ?? "");
      setAlertsEnabled(pastoralist.alertsEnabled);
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
        body: JSON.stringify({ name, phone, location, waterSource, alertsEnabled }),
      });
      if (!r.ok) throw new Error(`update failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Pastoralist updated" });
      qc.invalidateQueries({ queryKey: getListPastoralistsQueryKey() });
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
            value={waterSource}
            onChange={(e) => setWaterSource(e.target.value)}
            placeholder="Water source"
          />
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <span className="text-sm">SMS alerts</span>
            <Switch checked={alertsEnabled} onCheckedChange={setAlertsEnabled} />
          </div>
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
