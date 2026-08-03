import { useState } from "react";
import { CircleDot, Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { readToken } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

/**
 * Species grazing-ring radii, per ward — the config that decides which
 * water points a herder's cattle/shoat/camel can actually reach (see
 * ardalink_engine's species_ring_radii table + grazing.py). Seeded with
 * placeholder values (cattle 5km, shoat 8km, camel 15km, uniform across
 * wards) pending real field/veterinary sign-off — this is where an
 * operator tunes them per ward as that data comes in.
 */
const ACTIVE_WARDS: Array<{ id: string; name: string }> = [
  { id: "241", name: "Wabera" },
  { id: "242", name: "Bulla Pesa" },
  { id: "245", name: "Ngare Mara" },
  { id: "246", name: "Burat" },
  { id: "247", name: "Oldonyiro" },
];

const SPECIES_GROUPS = ["cattle", "shoat", "camel"] as const;
type SpeciesGroup = (typeof SPECIES_GROUPS)[number];

function authHeaders(): Record<string, string> {
  const tok = readToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

export function SpeciesRadiiSection() {
  const { toast } = useToast();
  // Local-only draft values, keyed "wardId:species" — this panel doesn't
  // list current values from the engine (no GET endpoint for this table
  // exists yet), it's a direct-entry tuning form. An operator sets a new
  // radius; the engine returns and persists the authoritative value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const updateM = useMutation({
    mutationFn: async ({
      wardId,
      speciesGroup,
      radiusKm,
    }: {
      wardId: string;
      speciesGroup: SpeciesGroup;
      radiusKm: number;
    }) => {
      const r = await fetch(`/api/ops/species-ring-radii/${wardId}/${speciesGroup}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ radiusKm }),
      });
      if (!r.ok) throw new Error(`update failed: ${r.status}`);
      return r.json();
    },
    onSuccess: (_data, vars) => {
      const key = `${vars.wardId}:${vars.speciesGroup}`;
      setSavedKey(key);
      toast({ title: `${vars.speciesGroup} radius set to ${vars.radiusKm}km` });
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 2000);
    },
    onError: () => toast({ title: "Failed to update radius", variant: "destructive" }),
  });

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <CircleDot className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Species Grazing Radii</h2>
          <p className="text-xs text-muted-foreground">
            Trekking-distance radius (km) each species can reach from a water
            point, per ward. Placeholder defaults pending field validation —
            tune per ward as real data comes in.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {ACTIVE_WARDS.map((ward) => (
          <div key={ward.id} className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-medium">{ward.name}</div>
            <div className="grid grid-cols-3 gap-3">
              {SPECIES_GROUPS.map((species) => {
                const key = `${ward.id}:${species}`;
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-xs capitalize text-muted-foreground">
                      {species}
                    </span>
                    <Input
                      type="number"
                      step="0.5"
                      min="0"
                      placeholder="km"
                      className="h-8"
                      value={drafts[key] ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [key]: e.target.value }))
                      }
                    />
                    <Button
                      size="sm"
                      variant={savedKey === key ? "default" : "outline"}
                      disabled={!drafts[key] || updateM.isPending}
                      onClick={() =>
                        updateM.mutate({
                          wardId: ward.id,
                          speciesGroup: species,
                          radiusKm: Number(drafts[key]),
                        })
                      }
                    >
                      {updateM.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : savedKey === key ? (
                        "✓"
                      ) : (
                        "Set"
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
