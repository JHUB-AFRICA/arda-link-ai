import { useEffect, useState } from "react";

interface StatusResponse {
  is_running: boolean;
  last_run: {
    timestamp?: string;
    month?: string;
    live?: {
      imageDates?: string[];
      anomaly?: {
        wardStressedPixelPct?: number;
        worstQuadrant?: string;
        NDVI?: { p50?: number; p5?: number };
        quadrantMeanAnomalyPct?: Record<string, number>;
      };
    };
    climate?: {
      rolling30Day?: {
        meanTempC?: number;
        totalPrecipMm?: number;
        rainyDays?: number;
        meanSoilMoisture?: number;
        moistureAdequacyIndex?: number;
        droughtSeverity?: string;
      };
    };
    forecast?: {
      outlook?: {
        riskLevel?: string;
        stressDirection?: string;
        estimatedRecoveryDays?: number | null;
        recommendation?: string;
      };
      forecast14d?: {
        totalPrecipMm?: number;
        forecastMAI?: number;
      };
    };
  } | null;
}

function riskColor(level: string | undefined): string {
  switch ((level ?? "").toLowerCase()) {
    case "critical":
      return "bg-red-100 text-red-800 border-red-300";
    case "high":
      return "bg-orange-100 text-orange-800 border-orange-300";
    case "moderate":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "low":
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    default:
      return "bg-stone-100 text-stone-700 border-stone-300";
  }
}

function fmtPct(n: number | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`;
}
function fmtNum(n: number | undefined, digits = 1, suffix = ""): string {
  return n == null || !Number.isFinite(n)
    ? "—"
    : `${n.toFixed(digits)}${suffix}`;
}

export default function EnvPanel() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as StatusResponse;
        if (!cancelled) {
          setData(json);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "load failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const last = data?.last_run ?? null;
  const anomaly = last?.live?.anomaly;
  const climate = last?.climate?.rolling30Day;
  const forecast = last?.forecast;

  return (
    <div className="space-y-4">
      {/* Map (static Bula Pesa centred OSM tile via Leaflet-style image) */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
        <div className="aspect-[16/10] bg-stone-100 relative">
          <iframe
            title="Bula Pesa Ward map"
            src="https://www.openstreetmap.org/export/embed.html?bbox=37.50%2C0.28%2C37.66%2C0.43&layer=mapnik&marker=0.355%2C37.583"
            className="absolute inset-0 w-full h-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
        <div className="px-4 py-3 border-t border-stone-200">
          <p className="text-sm font-semibold text-stone-900">
            Bula Pesa Ward · Isiolo
          </p>
          <p className="text-[11px] text-stone-500">0.355°N · 37.583°E</p>
        </div>
      </div>

      {loading && !data && (
        <div className="bg-white rounded-2xl border border-stone-200 p-6 text-center text-sm text-stone-500">
          Inapakia data… · Loading environmental data…
        </div>
      )}

      {error && !data && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">
          Hatukuweza kupata data ya satelaiti sasa. · Could not load satellite
          data right now.
        </div>
      )}

      {!loading && data && !last && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 text-sm text-stone-600">
          <p className="font-medium text-stone-800 mb-1">
            Hakuna data ya satelaiti bado.
          </p>
          <p className="text-stone-500 text-xs">
            No satellite check has run yet — please check back shortly.
          </p>
        </div>
      )}

      {/* Risk badge */}
      {forecast?.outlook?.riskLevel && (
        <div
          className={`rounded-2xl border p-4 ${riskColor(forecast.outlook.riskLevel)}`}
        >
          <p className="text-[10px] uppercase tracking-wider opacity-70 mb-1">
            14-day outlook · Mtazamo wa siku 14
          </p>
          <p className="text-xl font-bold capitalize">
            {forecast.outlook.riskLevel} risk
          </p>
          {forecast.outlook.stressDirection && (
            <p className="text-xs mt-1 opacity-90 capitalize">
              {forecast.outlook.stressDirection.replace(/_/g, " ")}
            </p>
          )}
          {forecast.outlook.recommendation && (
            <p className="text-xs mt-2 leading-snug">
              {forecast.outlook.recommendation}
            </p>
          )}
        </div>
      )}

      {/* Satellite */}
      {anomaly && (
        <div className="bg-white rounded-2xl border border-stone-200 p-4 shadow-sm">
          <p className="text-[10px] uppercase tracking-wider text-stone-500 mb-2">
            Satelaiti · Satellite (Sentinel-2)
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[11px] text-stone-500">Stressed pixels</p>
              <p className="font-semibold text-stone-900">
                {fmtPct(anomaly.wardStressedPixelPct)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Worst quadrant</p>
              <p className="font-semibold text-stone-900">
                {anomaly.worstQuadrant ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Median NDVI Δ</p>
              <p className="font-semibold text-stone-900">
                {fmtPct(anomaly.NDVI?.p50)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Worst 5% NDVI Δ</p>
              <p className="font-semibold text-stone-900">
                {fmtPct(anomaly.NDVI?.p5)}
              </p>
            </div>
          </div>
          {last?.live?.imageDates?.[0] && (
            <p className="text-[10px] text-stone-400 mt-3">
              Image: {last.live.imageDates[0]}
            </p>
          )}
        </div>
      )}

      {/* Climate */}
      {climate && (
        <div className="bg-white rounded-2xl border border-stone-200 p-4 shadow-sm">
          <p className="text-[10px] uppercase tracking-wider text-stone-500 mb-2">
            Hali ya hewa · Climate (30-day)
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[11px] text-stone-500">Temperature</p>
              <p className="font-semibold text-stone-900">
                {fmtNum(climate.meanTempC, 1, "°C")}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Rainfall</p>
              <p className="font-semibold text-stone-900">
                {fmtNum(climate.totalPrecipMm, 1, " mm")}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Rainy days</p>
              <p className="font-semibold text-stone-900">
                {climate.rainyDays ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Soil moisture</p>
              <p className="font-semibold text-stone-900">
                {climate.meanSoilMoisture != null
                  ? `${(climate.meanSoilMoisture * 100).toFixed(1)}%`
                  : "—"}
              </p>
            </div>
            <div className="col-span-2">
              <p className="text-[11px] text-stone-500">
                Drought severity · Ukame
              </p>
              <p className="font-semibold text-stone-900 capitalize">
                {climate.droughtSeverity ?? "—"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Forecast */}
      {forecast?.forecast14d && (
        <div className="bg-white rounded-2xl border border-stone-200 p-4 shadow-sm">
          <p className="text-[10px] uppercase tracking-wider text-stone-500 mb-2">
            Utabiri wa siku 14 · 14-day forecast
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[11px] text-stone-500">Rain expected</p>
              <p className="font-semibold text-stone-900">
                {fmtNum(forecast.forecast14d.totalPrecipMm, 1, " mm")}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Forecast MAI</p>
              <p className="font-semibold text-stone-900">
                {fmtNum(forecast.forecast14d.forecastMAI, 3)}
              </p>
            </div>
            {forecast.outlook?.estimatedRecoveryDays != null && (
              <div className="col-span-2">
                <p className="text-[11px] text-stone-500">Estimated recovery</p>
                <p className="font-semibold text-stone-900">
                  {forecast.outlook.estimatedRecoveryDays} days
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {last?.timestamp && (
        <p className="text-[10px] text-stone-400 text-center">
          Updated · Imesasishwa {new Date(last.timestamp).toLocaleString()}
        </p>
      )}
    </div>
  );
}
