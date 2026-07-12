import { TrendingUp, CloudRain } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Legend,
  Area,
  ComposedChart,
  Bar,
} from "recharts";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * NDVI history + rainfall forecast panels.
 *
 * Reads /api/wards/timeseries — a single request returns 12 months
 * of NDVI + 14 days of forecast for all 5 active wards. User picks
 * a ward via a chip; charts update.
 */
interface NdviRow {
  period_end: string;
  ndvi_mean: number | null;
  vci_value: number | null;
}
interface ForecastRow {
  target_date: string;
  rainfall_mm_p50: number;
  rainfall_mm_p95: number;
  precipitation_probability: number;
  temperature_c_max: number | null;
}
interface WardTS {
  ward_id: string;
  name: string;
  ndvi: NdviRow[];
  forecast: ForecastRow[];
}
interface TSResponse {
  ready: boolean;
  wards: WardTS[];
  reason?: string;
}

export default function TimeSeriesPanel() {
  const [wardId, setWardId] = useState<string>("242"); // Bulla Pesa default

  const q = useQuery<TSResponse>({
    queryKey: ["wards-timeseries"],
    queryFn: async () => {
      const r = await fetch("/api/wards/timeseries");
      return r.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!q.data?.ready) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
        Time series unavailable: {q.data?.reason ?? "unknown"}
      </div>
    );
  }

  const wards = q.data.wards;
  const selected = wards.find((w) => w.ward_id === wardId) ?? wards[0];
  if (!selected) return null;

  const ndviData = selected.ndvi.map((r) => ({
    date: r.period_end.slice(0, 7), // YYYY-MM
    ndvi: r.ndvi_mean,
  }));

  const forecastData = selected.forecast.map((r) => ({
    date: r.target_date.slice(5), // MM-DD
    rain: r.rainfall_mm_p50,
    rainHigh: r.rainfall_mm_p95,
    prob: Math.round(r.precipitation_probability * 100),
    tmax: r.temperature_c_max,
  }));

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">
              Ward signals — {selected.name}
            </h2>
            <p className="text-xs text-muted-foreground">
              12-month NDVI history · 14-day rainfall forecast
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          {wards.map((w) => (
            <button
              key={w.ward_id}
              onClick={() => setWardId(w.ward_id)}
              className={`rounded px-2 py-1 text-xs ${
                w.ward_id === selected.ward_id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {w.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="h-4 w-4 text-emerald-500" />
            NDVI history (12 mo)
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={ndviData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#1f2937" strokeDasharray="2 4" />
              <XAxis dataKey="date" fontSize={10} stroke="#9ca3af" />
              <YAxis
                domain={[0.1, 0.6]}
                fontSize={10}
                stroke="#9ca3af"
                width={30}
              />
              <RTooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #1f2937",
                  fontSize: 12,
                  color: "#e2e8f0",
                }}
              />
              <Line
                type="monotone"
                dataKey="ndvi"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 3, fill: "#10b981" }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Source: Sentinel-2 monthly composite via GEE →
            satellite_indices
          </p>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <CloudRain className="h-4 w-4 text-sky-500" />
            Rain forecast (14 days)
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart
              data={forecastData}
              margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
            >
              <CartesianGrid stroke="#1f2937" strokeDasharray="2 4" />
              <XAxis dataKey="date" fontSize={10} stroke="#9ca3af" />
              <YAxis
                yAxisId="mm"
                fontSize={10}
                stroke="#9ca3af"
                width={30}
                label={{
                  value: "mm",
                  fontSize: 9,
                  fill: "#9ca3af",
                  position: "insideLeft",
                }}
              />
              <YAxis
                yAxisId="prob"
                orientation="right"
                domain={[0, 100]}
                fontSize={10}
                stroke="#9ca3af"
                width={25}
              />
              <RTooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #1f2937",
                  fontSize: 12,
                  color: "#e2e8f0",
                }}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {/* p95 as area behind the p50 bar, gives a visual CI */}
              <Area
                yAxisId="mm"
                type="monotone"
                dataKey="rainHigh"
                stroke="none"
                fill="#0ea5e9"
                fillOpacity={0.18}
                name="p95"
              />
              <Bar
                yAxisId="mm"
                dataKey="rain"
                fill="#0ea5e9"
                fillOpacity={0.85}
                name="p50 rain"
              />
              <Line
                yAxisId="prob"
                type="monotone"
                dataKey="prob"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={{ r: 2, fill: "#f59e0b" }}
                name="prob %"
              />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Source: Open-Meteo daily forecast (persisted 6h) →
            weather_forecast
          </p>
        </div>
      </div>
    </section>
  );
}
