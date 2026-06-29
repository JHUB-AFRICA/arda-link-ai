import { useEffect, useState, useCallback } from "react";
import { Globe, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";

interface OpenDataSource {
  id: string;
  name: string;
  baseUrl: string;
  auth: string;
  attribution: string;
  whatItGives: string;
  integratedAsOf: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

interface OpenDataSourcesResponse {
  sources: OpenDataSource[];
  totalHealthy: number;
  totalProviders: number;
  checkedAt: string;
}

interface YearOverYearResponse {
  current: {
    totalPrecipMm: number;
    rainyDays: number;
    meanTempC: number;
    moistureAdequacyIndex: number;
    droughtSeverity: string;
  };
  lastYear: {
    totalPrecipMm: number;
    moistureAdequacyIndex: number;
    droughtSeverity: string;
  };
  comparison: {
    precipDeltaMm: number;
    precipDeltaPct: number;
    tempDeltaC: number;
    severityShift: string;
    interpretation: string;
  };
}

interface AirQualityResponse {
  pm2_5UgM3: number;
  pm10UgM3: number;
}

export function OpenDataCard() {
  const [sources, setSources] = useState<OpenDataSourcesResponse | null>(null);
  const [yoy, setYoy] = useState<YearOverYearResponse | null>(null);
  const [air, setAir] = useState<AirQualityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sourcesRes, yoyRes, airRes] = await Promise.all([
        fetch("/api/open-data/sources"),
        fetch("/api/open-data/year-over-year?windowDays=30"),
        fetch("/api/open-data/air-quality"),
      ]);
      if (!sourcesRes.ok) throw new Error(`sources: ${sourcesRes.status}`);
      setSources(await sourcesRes.json());
      if (yoyRes.ok) setYoy(await yoyRes.json());
      if (airRes.ok) setAir(await airRes.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Refresh sources status every 5 minutes — these probes hit the
    // public open-data APIs and aren't worth hitting more often.
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  const sevColor = (s: string): string => {
    switch (s) {
      case "none":
        return "text-emerald-400";
      case "mild":
        return "text-yellow-300";
      case "moderate":
        return "text-orange-400";
      case "severe":
        return "text-red-400";
      default:
        return "text-red-500";
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="w-4 h-4 text-emerald-400 shrink-0" />
          <h3 className="text-sm font-semibold text-white truncate">
            Open data sources
          </h3>
          {sources && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-400 font-medium">
              {sources.totalHealthy}/{sources.totalProviders} healthy
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Re-probe open data sources"
          title="Re-probe open data sources"
          data-testid="btn-opendata-refresh"
          className="p-1.5 rounded-md bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-400 hover:text-emerald-300 transition-colors"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-1.5 text-xs text-red-300">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{error}</span>
        </div>
      )}

      {sources && (
        <ul className="space-y-1">
          {sources.sources.map((s) => (
            <li
              key={s.id}
              className="flex items-start gap-2 text-xs"
              data-testid={`opendata-row-${s.id}`}
            >
              {s.healthy ? (
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-red-400 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-gray-200 font-medium truncate">
                    {s.name}
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono">
                    {s.latencyMs}ms
                  </span>
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  {s.whatItGives}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {yoy && (
        <div className="bg-gray-950/50 border border-gray-800 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-200">
              Climate vs same window last year
            </span>
            <span
              className={`text-xs font-mono ${sevColor(yoy.current.droughtSeverity)}`}
            >
              {yoy.current.droughtSeverity.toUpperCase()}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <div className="text-gray-500">This 30 days</div>
              <div className="text-gray-100">
                {yoy.current.totalPrecipMm} mm · {yoy.current.rainyDays} rainy
                days · {yoy.current.meanTempC.toFixed(1)}°C
              </div>
            </div>
            <div>
              <div className="text-gray-500">Last year</div>
              <div className="text-gray-100">
                {yoy.lastYear.totalPrecipMm} mm · {yoy.lastYear.droughtSeverity}
              </div>
            </div>
          </div>
          <div className="text-[11px] text-gray-400 italic leading-snug">
            {yoy.comparison.interpretation}
          </div>
        </div>
      )}

      {air && (
        <div className="bg-gray-950/50 border border-gray-800 rounded-lg p-3 flex items-center justify-between">
          <span className="text-xs text-gray-400">Air quality (CAMS)</span>
          <span className="text-xs font-mono text-gray-200">
            PM2.5 {air.pm2_5UgM3.toFixed(1)} · PM10 {air.pm10UgM3.toFixed(1)} µg/m³
          </span>
        </div>
      )}
    </div>
  );
}

export default OpenDataCard;
