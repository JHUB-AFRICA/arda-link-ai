import {
  Satellite,
  Activity,
  MapPin,
  TrendingDown,
  Cloud,
  Droplets,
  Thermometer,
  Wind,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WardMapLive } from "@/components/WardMapLive";
import { MetricCard } from "./MetricCard";
import { Loader2 } from "lucide-react";

interface MapTabProps {
  loadingStatus: boolean;
  statusData: any;
  forecastData: any;
  pastoralistsData: any[];
  handleTriggerCheck: () => void;
  checkInFlight: boolean;
  waitingForBackgroundRun: boolean;
}

/** Map tab with live vegetation intelligence and metrics sidebar */
export function MapTab({
  loadingStatus,
  statusData,
  forecastData,
  pastoralistsData,
  handleTriggerCheck,
  checkInFlight,
  waitingForBackgroundRun,
}: MapTabProps) {
  const d = statusData?.last_run as any;
  const f = forecastData as any;

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0">
      <div className="flex-1 p-3 sm:p-6 min-h-0">
        <div className="h-full bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden relative flex flex-col items-center justify-center p-4">
          {loadingStatus && !d ? (
            <div className="flex flex-col items-center text-gray-500 gap-4">
              <Loader2 className="w-8 h-8 animate-spin" />
              Loading satellite data...
            </div>
          ) : !d ? (
            <div className="flex flex-col items-center text-gray-400 gap-4 max-w-md text-center px-4">
              <Satellite className="w-12 h-12 text-amber-500/70" />
              <div>
                <div className="text-lg font-semibold text-white mb-2">
                  See drought before the herders do.
                </div>
                <div className="text-sm text-gray-400 mb-4 leading-relaxed">
                  Pulls a live Sentinel-2 vegetation reading over Bula
                  Pesa Ward, compares it to 11 years of monthly
                  baselines in Azure Cosmos DB, and decides whether a
                  pastoralist needs to be called.
                </div>
                <Button
                  onClick={handleTriggerCheck}
                  disabled={checkInFlight}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  data-testid="btn-empty-trigger"
                >
                  {checkInFlight ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                      {waitingForBackgroundRun
                        ? "Waiting for background run…"
                        : "Fetching live satellite data…"}
                    </>
                  ) : (
                    <>
                      <Satellite className="w-4 h-4 mr-2" /> Run a live
                      satellite check
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : d?.live?.anomaly ? (
            <WardMapLive
              quadrants={
                d.live.anomaly.quadrantMeanAnomalyPct || {
                  NW: 0,
                  NE: 0,
                  SW: 0,
                  SE: 0,
                }
              }
              worstQuadrant={d.live.anomaly.worstQuadrant}
              timestamp={d.timestamp}
              pastoralists={pastoralistsData.map((p) => ({
                id: p.id,
                name: p.name,
                phone: p.phone,
                location: p.location ?? null,
                lastContactAt: p.lastContactAt
                  ? typeof p.lastContactAt === "string"
                    ? p.lastContactAt
                    : new Date(p.lastContactAt).toISOString()
                  : null,
                cattle: p.cattle ?? 0,
                goats: p.goats ?? 0,
                camels: p.camels ?? 0,
              }))}
            />
          ) : (
            <div className="text-gray-500">No satellite data available</div>
          )}
        </div>
      </div>

      <div className="w-full md:w-80 md:shrink-0 border-t md:border-t-0 md:border-l border-gray-800 bg-gray-900/40 md:overflow-y-auto p-3 sm:p-4 space-y-6">
        {loadingStatus && !d ? (
          Array(5)
            .fill(0)
            .map((_, i) => (
              <Skeleton
                key={i}
                className="h-20 w-full bg-gray-800 rounded-xl"
              />
            ))
        ) : d ? (
          <>
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Satellite className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                  Satellite
                </span>
              </div>
              <div className="space-y-2">
                <MetricCard
                  icon={<Activity className="w-4 h-4" />}
                  label="Stressed pixels"
                  value={`${d.live?.anomaly?.wardStressedPixelPct?.toFixed(1) || 0}%`}
                  sub="vs 11-yr norm"
                  accent="text-red-400"
                />
                <MetricCard
                  icon={<MapPin className="w-4 h-4" />}
                  label="Worst quadrant"
                  value={d.live?.anomaly?.worstQuadrant || "N/A"}
                  accent="text-red-400"
                />
                {typeof d.live?.anomaly?.NDVI?.p50 === "number" && (
                  <MetricCard
                    icon={<TrendingDown className="w-4 h-4" />}
                    label="NDVI vs baseline"
                    value={`${d.live.anomaly.NDVI.p50.toFixed(1)}%`}
                    sub={`Mean ${d.live.anomaly.NDVI.meanPct?.toFixed(1)}%`}
                    accent="text-orange-400"
                  />
                )}
              </div>
            </div>

            {d.climate && (
              <div>
                <div className="flex items-center gap-2 mb-3 mt-4 border-t border-gray-800 pt-4">
                  <Cloud className="w-4 h-4 text-sky-400" />
                  <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                    Climate (30d)
                  </span>
                </div>
                <div className="space-y-2">
                  <MetricCard
                    icon={<Thermometer className="w-4 h-4" />}
                    label="Avg Temp"
                    value={`${d.climate.rolling30Day?.meanTempC?.toFixed(1)}°C`}
                    sub={`Humidity ${d.climate.current?.humidityPct?.toFixed(0)}%`}
                    accent="text-orange-300"
                  />
                  <MetricCard
                    icon={<Droplets className="w-4 h-4" />}
                    label="Rainfall"
                    value={`${d.climate.rolling30Day?.totalPrecipMm?.toFixed(1)}mm`}
                    sub={`${d.climate.rolling30Day?.rainyDays} rainy days`}
                    accent="text-sky-400"
                  />
                  <MetricCard
                    icon={<Wind className="w-4 h-4" />}
                    label="ET₀ (Evap demand)"
                    value={`${d.climate.rolling30Day?.totalET0Mm?.toFixed(1)}mm`}
                    accent="text-yellow-400"
                  />
                </div>
              </div>
            )}

            {f?.forecast?.forecast14d && (
              <div>
                <div className="flex items-center gap-2 mb-3 mt-4 border-t border-gray-800 pt-4">
                  <TrendingDown className="w-4 h-4 text-green-400" />
                  <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                    14-Day Forecast
                  </span>
                </div>
                <div className="space-y-2">
                  <MetricCard
                    icon={<Cloud className="w-4 h-4" />}
                    label="Expected Rain"
                    value={`${f.forecast.forecast14d.totalPrecipMm?.toFixed(1)}mm`}
                    sub={`${f.forecast.forecast14d.rainyDays ?? 0} rainy days`}
                    accent="text-sky-400"
                  />
                  <MetricCard
                    icon={<Wind className="w-4 h-4" />}
                    label="Expected ET₀"
                    value={`${f.forecast.forecast14d.totalET0Mm?.toFixed(1)}mm`}
                    sub={`Effective rain ${f.forecast.forecast14d.effectiveRainMm?.toFixed(1)}mm`}
                    accent="text-yellow-400"
                  />
                  {f.forecast.outlook?.recommendation && (
                    <div className="mt-4 p-3 bg-blue-900/20 border border-blue-800/40 rounded-xl text-sm text-blue-200">
                      <strong>Rec:</strong> {f.forecast.outlook.recommendation}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
