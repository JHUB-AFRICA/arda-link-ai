import { ChevronRight } from "lucide-react";
import { IntelligenceBrief } from "@/components/IntelligenceBrief";

interface IntelligenceBriefHeaderProps {
  briefExpanded: boolean;
  setBriefExpanded: (expanded: boolean) => void;
  briefLang: "en" | "sw";
  setBriefLang: (lang: "en" | "sw") => void;
}

/** Collapsible AI Intelligence Brief header */
export function IntelligenceBriefHeader({
  briefExpanded,
  setBriefExpanded,
  briefLang,
  setBriefLang,
}: IntelligenceBriefHeaderProps) {
  return (
    <div className="border-b border-gray-800 bg-gray-950/40">
      <button
        onClick={() => setBriefExpanded(!briefExpanded)}
        className="w-full px-3 sm:px-6 py-2 flex items-center justify-between text-left hover:bg-gray-900/50 transition-colors"
      >
        <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
          Intelligence Brief
        </span>
        <ChevronRight
          className={`w-4 h-4 text-gray-500 transition-transform ${
            briefExpanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {briefExpanded && (
        <div className="px-3 sm:px-6 py-3 border-t border-gray-800">
          <IntelligenceBrief lang={briefLang} onLangChange={setBriefLang} />
        </div>
      )}
    </div>
  );
}
