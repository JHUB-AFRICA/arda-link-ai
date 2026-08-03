import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WaterSourcesSection } from "./WaterSourcesSection";
import { SpeciesRadiiSection } from "./SpeciesRadiiSection";
import { GroundTruthAuditSection } from "./GroundTruthAuditSection";
import { AuditLogSection } from "./AuditLogSection";

/**
 * Operator data-management console — edit water sources and species
 * radii, review/correct ground-truth insights, and see every write in
 * one audit trail. Pastoralist editing lives on the existing Herders tab
 * (PastoralistsTab.tsx) rather than duplicated here, since that's where
 * an operator already looks for herder records.
 */
export function AdminConsoleTab() {
  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-6">
      <Tabs defaultValue="water-sources" className="w-full">
        <TabsList>
          <TabsTrigger value="water-sources">Water Sources</TabsTrigger>
          <TabsTrigger value="species-radii">Species Radii</TabsTrigger>
          <TabsTrigger value="ground-truth">Ground Truth Audit</TabsTrigger>
          <TabsTrigger value="audit-log">Audit Log</TabsTrigger>
        </TabsList>
        <TabsContent value="water-sources" className="mt-4">
          <WaterSourcesSection />
        </TabsContent>
        <TabsContent value="species-radii" className="mt-4">
          <SpeciesRadiiSection />
        </TabsContent>
        <TabsContent value="ground-truth" className="mt-4">
          <GroundTruthAuditSection />
        </TabsContent>
        <TabsContent value="audit-log" className="mt-4">
          <AuditLogSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
