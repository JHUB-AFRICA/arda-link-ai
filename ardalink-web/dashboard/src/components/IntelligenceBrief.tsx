import {
  Sparkles,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Languages,
  ListChecks,
  Database,
} from "lucide-react";
import {
  useIntelligenceBrief,
  type IntelligenceBriefResponse,
} from "@workspace/api-client-react";

interface IntelligenceBriefProps {
  lang?: "en" | "sw";
  onLangChange?: (lang: "en" | "sw") => void;
  defaultLang?: "en" | "sw";
  className?: string;
}

/**
 * IntelligenceBrief — the Tuesday-demo "wow moment" hero card.
 *
 * Reads from GET /api/intelligence/brief. The backend builds the brief
 * inside withTenantContext(tenantId, …) so a forged JWT can't make the
 * LLM see another tenant's data. The response includes the provider,
 * model, token count and latency so the audience can see exactly which
 * model produced the brief and how much it cost.
 *
 * Empty / loading / error states each render a usable surface — the
 * operator should never see a blank hero card during the demo.
 */
export function IntelligenceBrief({
  lang,
  onLangChange,
  defaultLang = "en",
  className = "",
}: IntelligenceBriefProps) {
  const effectiveLang = lang ?? defaultLang;
  const brief = useIntelligenceBrief({ lang: effectiveLang });

  return (
    <div
      data-testid="intelligence-brief"
      className={
        "bg-gradient-to-br from-gray-900 via-gray-900 to-amber-950/30 " +
        "border border-amber-700/40 rounded-xl p-3 sm:p-4 " +
        "shadow-lg shadow-amber-950/20 " +
        className
      }
    >
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
          <h2 className="text-xs sm:text-sm font-semibold text-amber-300 uppercase tracking-wider truncate">
            {effectiveLang === "sw" ? "Muhtasari wa Ujasusi" : "Intelligence Brief"}
          </h2>
          {brief.data?.cached && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-400 font-medium">
              cached
            </span>
          )}
          {brief.data && !brief.data.cached && brief.data.latency_ms > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-900/40 border border-emerald-700/50 text-emerald-300 font-medium">
              live · {brief.data.latency_ms}ms
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onLangChange && (
            <LangToggle
              lang={effectiveLang}
              onChange={onLangChange}
              disabled={brief.isFetching}
            />
          )}
          <button
            type="button"
            onClick={() => brief.refetch()}
            disabled={brief.isFetching}
            data-testid="btn-brief-refresh"
            aria-label="Regenerate brief"
            title="Regenerate brief (bypass cache)"
            className="p-1.5 rounded-md bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-400 hover:text-amber-300 transition-colors"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${brief.isFetching ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </header>

      <BriefBody brief={brief} lang={effectiveLang} />
    </div>
  );
}

function LangToggle({
  lang,
  onChange,
  disabled,
}: {
  lang: "en" | "sw";
  onChange: (lang: "en" | "sw") => void;
  disabled: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Brief language"
      className="inline-flex items-center rounded-md bg-gray-800 border border-gray-700 p-0.5"
    >
      {(["en", "sw"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          disabled={disabled}
          aria-pressed={lang === opt}
          className={
            "px-2 py-0.5 text-[10px] font-semibold rounded transition-colors " +
            (lang === opt
              ? "bg-amber-600 text-white"
              : "text-gray-400 hover:text-gray-200 disabled:opacity-50")
          }
        >
          <Languages className="w-2.5 h-2.5 inline mr-0.5" />
          {opt.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function BriefBody({
  brief,
  lang,
}: {
  brief: ReturnType<typeof useIntelligenceBrief>;
  lang: "en" | "sw";
}) {
  if (brief.isLoading) {
    return (
      <div
        data-testid="brief-loading"
        className="flex items-center gap-2 text-gray-400 text-xs py-3"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
        <span>
          {lang === "sw"
            ? "Inaandaa muhtasari…"
            : "Composing operational brief…"}
        </span>
      </div>
    );
  }

  if (brief.isError) {
    return (
      <div
        data-testid="brief-error"
        className="flex items-start gap-2 text-red-300 text-xs py-2"
      >
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="font-semibold">
            {lang === "sw" ? "Muhtasari haukuweza kupatikana" : "Brief unavailable"}
          </div>
          <div className="text-red-400/80 mt-0.5 break-words">
            {String(brief.error?.message ?? brief.error)}
          </div>
          <button
            type="button"
            onClick={() => brief.refetch()}
            className="mt-1 text-amber-400 hover:text-amber-300 underline text-[10px]"
          >
            {lang === "sw" ? "Jaribu tena" : "Retry"}
          </button>
        </div>
      </div>
    );
  }

  const data = brief.data;
  if (!data) {
    return (
      <div className="text-gray-500 text-xs py-3">
        {lang === "sw" ? "Hakuna data ya muhtasari." : "No brief data yet."}
      </div>
    );
  }

  return (
    <div data-testid="brief-content" className="space-y-2.5">
      <p
        data-testid="brief-summary"
        className="text-sm text-gray-100 leading-relaxed"
      >
        {data.summary}
      </p>

      {data.actions.length > 0 && (
        <div className="bg-gray-950/50 border border-gray-800 rounded-lg p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-400/80 mb-1.5 font-semibold">
            <ListChecks className="w-3 h-3" />
            {lang === "sw" ? "Vitendo vya wiki hii" : "This week's actions"}
          </div>
          <ol className="space-y-1 list-decimal list-inside text-xs text-gray-200">
            {data.actions.map((action, i) => (
              <li key={i} className="leading-snug">
                {action}
              </li>
            ))}
          </ol>
        </div>
      )}

      <BriefMetadata data={data} lang={lang} />
    </div>
  );
}

function BriefMetadata({
  data,
  lang,
}: {
  data: IntelligenceBriefResponse;
  lang: "en" | "sw";
}) {
  const generated = new Date(data.generated_at);
  const isMock = data.provider === "mock" || data.provider === "z" && data.model.includes("MOCK");
  const isZaiMock = data.provider === "z" && data.tokens === 0;
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 border-t border-gray-800 text-[10px] text-gray-500">
      <span className="inline-flex items-center gap-1">
        <Database className="w-2.5 h-2.5" />
        <span>
          {data.data_sources.join(" · ")}
        </span>
      </span>
      <span className="inline-flex items-center gap-1 font-mono">
        <span
          className={
            "inline-block w-1.5 h-1.5 rounded-full " +
            (isMock || isZaiMock ? "bg-amber-500" : "bg-emerald-400")
          }
          aria-hidden
        />
        <span className="text-gray-400">
          {data.provider}/{data.model}
        </span>
      </span>
      {data.tokens > 0 && (
        <span className="font-mono">{data.tokens} tok</span>
      )}
      <span className="font-mono">
        {generated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
      {(isMock || isZaiMock) && (
        <span
          title={
            lang === "sw"
              ? "LLM halijawekwa — inatumia jibu la mfano"
              : "No LLM key configured — using mock fallback"
          }
          className="text-amber-500/80"
        >
          [MOCK]
        </span>
      )}
    </footer>
  );
}

export default IntelligenceBrief;
