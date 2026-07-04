import { Satellite, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import { Sidebar } from "./Sidebar";

interface SidebarLayoutProps {
  tab: "map" | "pastoralists" | "groundtruth" | "demos";
  statusData: any;
  onNavigate: (next: "map" | "pastoralists" | "groundtruth" | "demos") => void;
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
}

/** Mobile header and sidebar layout wrapper */
export function SidebarLayout({
  tab,
  statusData,
  onNavigate,
  navOpen,
  setNavOpen,
}: SidebarLayoutProps) {
  return (
    <>
      {/* --- Mobile top bar (sidebar trigger) --- */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800 shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shrink-0">
            <Satellite className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-white truncate">
              ArdaLink AI
            </div>
            <div className="text-[10px] text-gray-500 truncate">
              Bula Pesa · Isiolo
            </div>
          </div>
        </div>
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="bg-gray-900 border-gray-700 text-gray-300"
              data-testid="btn-open-nav"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="p-0 w-64 bg-gray-900 border-gray-800 text-gray-100 flex flex-col"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Sidebar tab={tab} statusData={statusData} onNavigate={onNavigate} />
          </SheetContent>
        </Sheet>
      </div>

      {/* --- Desktop Sidebar --- */}
      <div className="hidden md:flex w-64 shrink-0 bg-gray-900 border-r border-gray-800 flex-col">
        <Sidebar tab={tab} statusData={statusData} onNavigate={onNavigate} />
      </div>
    </>
  );
}
