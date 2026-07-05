import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PastoralistForm } from "./PastoralistForm";

interface PastoralistsTabProps {
  pastoralistsData: any[] | undefined;
  loadingPastoralists: boolean;
  handleDeletePastoralist: (id: number) => void;
}

/** Herder registry tab with pastoralists table and registration form */
export function PastoralistsTab({
  pastoralistsData,
  loadingPastoralists,
  handleDeletePastoralist,
}: PastoralistsTabProps) {
  return (
    <div className="flex-1 flex flex-col md:flex-row p-3 sm:p-6 gap-4 sm:gap-6 overflow-y-auto">
      <div className="flex-1 bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden flex flex-col">
        <div className="p-4 border-b border-gray-800 bg-gray-900 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">
            Registered Herders
          </h2>
          <span className="text-sm text-gray-400">
            {pastoralistsData?.length || 0} total
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-gray-800 hover:bg-transparent">
                <TableHead className="text-gray-400">Name / Phone</TableHead>
                <TableHead className="text-gray-400">Location</TableHead>
                <TableHead className="text-gray-400">
                  Herd (C/G/C)
                </TableHead>
                <TableHead className="text-gray-400">Water</TableHead>
                <TableHead className="text-gray-400 text-right">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingPastoralists ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-gray-500">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : !pastoralistsData?.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-gray-500">
                    No pastoralists registered.
                  </TableCell>
                </TableRow>
              ) : (
                pastoralistsData.map(
                  (p: import("@workspace/api-client-react").Pastoralist) => (
                    <TableRow
                      key={p.id}
                      className="border-gray-800 hover:bg-gray-800/50"
                    >
                      <TableCell>
                        <div className="font-medium text-gray-200">{p.name}</div>
                        <div className="text-xs text-gray-500">{p.phone}</div>
                      </TableCell>
                      <TableCell className="text-gray-300">
                        {p.location || "-"}
                      </TableCell>
                      <TableCell className="text-gray-400">
                        {p.cattle}/{p.goats}/{p.camels}
                      </TableCell>
                      <TableCell className="text-gray-400">
                        {p.waterSource || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeletePastoralist(p.id)}
                          className="h-8 w-8 text-gray-500 hover:text-red-400 hover:bg-red-950/30"
                          data-testid={`btn-delete-${p.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ),
                )
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <PastoralistForm />
    </div>
  );
}
