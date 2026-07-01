import { useState, useRef, useEffect } from "react";
import {
  MapPin,
  Satellite,
  Cloud,
  MessageSquare,
  Users,
  Activity,
  TrendingDown,
  Droplets,
  Thermometer,
  Wind,
  AlertTriangle,
  ChevronRight,
  Send,
  Radio,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  Menu,
  ClipboardList,
  Heart,
  Globe,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  Legend,
  Label,
  ReferenceLine,
} from "recharts";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import { CostRailsCard } from "@/components/CostRailsCard";
import {
  useGetStatus,
  useGetForecast,
  useListPastoralists,
  useCreatePastoralist,
  useDeletePastoralist,
  useChatWithLand,
  useTriggerCheck,
  useListGroundTruthRecent,
  useGetGroundTruthSummary,
  useMintCallToken,
  getStatus,
  getGetStatusQueryKey,
  getListPastoralistsQueryKey,
  getGetForecastQueryKey,
  getListGroundTruthRecentQueryKey,
  getGetGroundTruthSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { CallModal } from "@/components/CallModal";
import { WardMapLive } from "@/components/WardMapLive";
import { IntelligenceBrief } from "@/components/IntelligenceBrief";
import { OpenDataCard } from "@/components/OpenDataCard";
import { Choropleth } from "@/components/Choropleth";
import { ChoroplethErrorBoundary } from "@/components/ChoroplethErrorBoundary";
import { UserMenu } from "@/components/UserMenu";
import { PhoneCall, ExternalLink } from "lucide-react";

// --- Helpers ---
function stressColor(pct: number) {
  if (pct < 25) return { fill: "#166534", stroke: "#22c55e", text: "#4ade80" };
  if (pct < 40) return { fill: "#713f12", stroke: "#eab308", text: "#fde047" };
  if (pct < 55) return { fill: "#7c2d12", stroke: "#f97316", text: "#fb923c" };
  return { fill: "#7f1d1d", stroke: "#ef4444", text: "#f87171" };
}

function riskBadge(level: string) {
  const map: Record<string, string> = {
    LOW: "bg-green-900 text-green-300 border-green-700",
    MODERATE: "bg-yellow-900 text-yellow-300 border-yellow-700",
    HIGH: "bg-orange-900 text-orange-300 border-orange-700",
    CRITICAL: "bg-red-900 text-red-300 border-red-700",
  };
  return map[level] ?? "bg-gray-800 text-gray-300 border-gray-600";
}

function MetricCard({
  icon,
  label,
  value,
  sub,
  accent = "text-amber-400",
}: {
  icon: React.ReactNode;
  label: string;
  value: string | React.ReactNode;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-3 flex items-start gap-3">
      <div className="text-gray-500 mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-gray-500 mb-0.5">{label}</div>
        <div
          className={`text-base font-bold font-mono ${accent} leading-tight`}
        >
          {value}
        </div>
        {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

// --- Legacy inline SVG map (replaced by WardMapLive). Kept to preserve git history; not referenced. ---
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _UnusedWardMap({
  quadrants,
  worstQuadrant,
}: {
  quadrants: { NW: number; NE: number; SW: number; SE: number };
  worstQuadrant: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const getLabel = (pct: number) => {
    if (pct < 25) return "Normal";
    if (pct < 40) return "Mild";
    if (pct < 55) return "High";
    return "Critical";
  };

  return (
    <div className="relative w-full h-full flex items-center justify-center min-h-[280px] sm:min-h-[400px]">
      <svg
        viewBox="0 0 400 380"
        className="w-full max-w-[500px] h-full drop-shadow-2xl"
      >
        <defs>
          <radialGradient id="terrain" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#1a2e1a" />
            <stop offset="100%" stopColor="#0a1a0a" />
          </radialGradient>
          <pattern
            id="grid"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 20 0 L 0 0 0 20"
              fill="none"
              stroke="#1f2d1f"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>
        <rect
          x="0"
          y="0"
          width="400"
          height="380"
          fill="url(#terrain)"
          rx="8"
        />
        <rect
          x="0"
          y="0"
          width="400"
          height="380"
          fill="url(#grid)"
          rx="8"
          opacity="0.4"
        />

        <rect
          x="30"
          y="30"
          width="340"
          height="320"
          fill="none"
          stroke="#374151"
          strokeWidth="1"
          strokeDasharray="4,4"
          rx="4"
        />

        {/* Quadrants */}
        {(
          [
            { id: "NW", x: 30, y: 30, tx: 115, ty: 95 },
            { id: "NE", x: 200, y: 30, tx: 285, ty: 95 },
            { id: "SW", x: 30, y: 190, tx: 115, ty: 257 },
            { id: "SE", x: 200, y: 190, tx: 285, ty: 257 },
          ] as const
        ).map((q) => {
          const val = quadrants[q.id as keyof typeof quadrants] || 0;
          const c = stressColor(val);
          const isHov = hovered === q.id;
          const isWorst = worstQuadrant === q.id;

          return (
            <g key={q.id}>
              <rect
                x={q.x}
                y={q.y}
                width="170"
                height="160"
                fill={c.fill}
                fillOpacity={isHov ? 0.9 : 0.7}
                stroke={c.stroke}
                strokeWidth={isWorst ? 2.5 : 1.5}
                className="cursor-pointer transition-all duration-200"
                onMouseEnter={() => setHovered(q.id)}
                onMouseLeave={() => setHovered(null)}
              />
              {isWorst && (
                <rect
                  x={q.x}
                  y={q.y}
                  width="170"
                  height="160"
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth="1"
                  strokeDasharray="3,2"
                />
              )}
              <text
                x={q.tx}
                y={q.ty}
                textAnchor="middle"
                fill={c.text}
                fontSize="11"
                fontWeight="600"
              >
                {q.id} {isWorst && "⚠"}
              </text>
              <text
                x={q.tx}
                y={q.ty + 17}
                textAnchor="middle"
                fill={c.text}
                fontSize="9"
                opacity="0.9"
              >
                {val.toFixed(1)}% stressed
              </text>
              <text
                x={q.tx}
                y={q.ty + 32}
                textAnchor="middle"
                fill={c.text}
                fontSize="9"
                opacity="0.7"
              >
                {getLabel(val)}
              </text>
            </g>
          );
        })}

        <line
          x1="200"
          y1="30"
          x2="200"
          y2="350"
          stroke="#374151"
          strokeWidth="1"
        />
        <line
          x1="30"
          y1="190"
          x2="370"
          y2="190"
          stroke="#374151"
          strokeWidth="1"
        />

        <circle
          cx="200"
          cy="190"
          r="6"
          fill="#f59e0b"
          stroke="#fbbf24"
          strokeWidth="1.5"
        />
        <circle
          cx="200"
          cy="190"
          r="12"
          fill="none"
          stroke="#f59e0b"
          strokeWidth="1"
          opacity="0.4"
        />

        <g opacity="0.85">
          <circle
            cx="90"
            cy="80"
            r="4"
            fill="#38bdf8"
            stroke="#7dd3fc"
            strokeWidth="1"
          />
          <circle
            cx="310"
            cy="65"
            r="4"
            fill="#38bdf8"
            stroke="#7dd3fc"
            strokeWidth="1"
          />
          <circle
            cx="70"
            cy="280"
            r="4"
            fill="#38bdf8"
            stroke="#7dd3fc"
            strokeWidth="1"
          />
          <circle
            cx="340"
            cy="310"
            r="3"
            fill="#94a3b8"
            stroke="#cbd5e1"
            strokeWidth="1"
          />
        </g>

        <text x="200" y="370" textAnchor="middle" fill="#4b5563" fontSize="8">
          Bula Pesa Ward · Isiolo, Kenya · 0.355°N 37.583°E
        </text>

        <g transform="translate(30, 358)">
          {[
            ["#22c55e", "<25%"],
            ["#eab308", "25-40%"],
            ["#f97316", "40-55%"],
            ["#ef4444", ">55%"],
          ].map(([color, label], i) => (
            <g key={i} transform={`translate(${i * 78}, 0)`}>
              <rect width="10" height="10" fill={color} opacity="0.7" rx="2" />
              <text x="13" y="9" fill="#6b7280" fontSize="7">
                {label}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

// --- Ground Truth Intelligence Section ---
function bcsBarColor(score: number | null): string {
  if (score == null) return "#374151";
  if (score <= 2) return "#ef4444";
  if (score < 3) return "#f97316";
  if (score < 4) return "#eab308";
  return "#22c55e";
}

const QUADRANT_LABEL: Record<string, string> = {
  NW: "NW · Wabera",
  NE: "NE · Ngare Mara",
  SW: "SW · Bulla Pesa",
  SE: "SE · Kambi Garba",
};

function GroundTruthSection() {
  const summaryQ = useGetGroundTruthSummary({
    query: {
      refetchInterval: 60_000,
      queryKey: getGetGroundTruthSummaryQueryKey(),
    },
  });
  const recentQ = useListGroundTruthRecent(
    { limit: 20 },
    {
      query: {
        refetchInterval: 60_000,
        queryKey: getListGroundTruthRecentQueryKey({ limit: 20 }),
      },
    },
  );

  const summary = summaryQ.data;
  const reports = recentQ.data ?? [];

  const bcsChartData = (summary?.byQuadrant ?? []).map((q) => ({
    name: QUADRANT_LABEL[q.quadrant] ?? q.quadrant,
    bcs: q.bcsAverage,
    samples: q.bcsSampleCount,
  }));

  // Keep nulls as nulls — Recharts will render gaps instead of misleading zero bars.
  const correlationData = (summary?.byQuadrant ?? []).map((q) => ({
    name: QUADRANT_LABEL[q.quadrant] ?? q.quadrant,
    bcs: q.bcsAverage,
    ndvi: q.ndviAverage,
    samples: q.bcsSampleCount,
  }));

  if (summaryQ.isLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <Skeleton className="h-32 w-full bg-gray-800" />
        <Skeleton className="h-64 w-full bg-gray-800" />
      </div>
    );
  }

  return (
    <div
      className="p-4 sm:p-6 space-y-6 md:overflow-y-auto"
      data-testid="section-ground-truth"
    >
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Total reports"
          value={summary?.totalReports ?? 0}
          icon={<ClipboardList className="w-4 h-4" />}
        />
        <KpiCard
          label="Last 7 days"
          value={summary?.reportsLast7Days ?? 0}
          icon={<Activity className="w-4 h-4" />}
          accent="text-amber-400"
        />
        <KpiCard
          label="Avg completeness"
          value={
            summary?.averageCompletenessPercent != null
              ? `${Math.round(summary.averageCompletenessPercent)}%`
              : "—"
          }
          icon={<Heart className="w-4 h-4" />}
          accent="text-emerald-400"
        />
        <KpiCard
          label="BCS follow-ups"
          value={summary?.bcsFollowupCount ?? 0}
          icon={<AlertTriangle className="w-4 h-4" />}
          accent={
            (summary?.bcsFollowupCount ?? 0) > 0
              ? "text-orange-400"
              : "text-gray-300"
          }
        />
      </div>

      {/* Cost rails (kill switch + daily budget) */}
      <CostRailsCard />

      {/* Open data sources — live probe of every free API we depend on */}
      <OpenDataCard />

      {/* Active alerts */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            Active stress alerts
            <span className="text-xs text-gray-500 font-normal">
              · last 14 days
            </span>
          </h3>
          <span className="text-xs text-gray-500">
            {summary?.alerts.length ?? 0} active
          </span>
        </div>
        {summary && summary.alerts.length > 0 ? (
          <div className="space-y-2" data-testid="alerts-list">
            {summary.alerts.slice(0, 8).map((a) => (
              <div
                key={`${a.id}-${a.kind}`}
                className={`flex items-start gap-3 p-3 rounded-lg border ${
                  a.severity === "red"
                    ? "bg-red-950/30 border-red-900/60"
                    : "bg-yellow-950/30 border-yellow-900/60"
                }`}
              >
                <span
                  className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                    a.severity === "red" ? "bg-red-400" : "bg-yellow-400"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-100">{a.message}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {a.location ? `${a.location} · ` : ""}
                    {a.quadrant ?? "unmapped"} ·{" "}
                    {new Date(a.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-500 italic py-4">
            No active alerts. Herd condition reports look stable.
          </div>
        )}
      </div>

      {/* BCS by quadrant */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
            <Heart className="w-4 h-4 text-emerald-400" /> Average Body
            Condition Score by area
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            ILRI/FAO Tropical Scale ·{" "}
            <span className="text-red-400">1 emaciated</span> →{" "}
            <span className="text-green-400">5 excellent</span>. Red bars =
            animals in crisis.
          </p>
          {bcsChartData.some((d) => d.bcs != null) ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={bcsChartData}
                margin={{ top: 5, right: 10, bottom: 20, left: 10 }}
              >
                <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="#6b7280" tick={{ fontSize: 11 }}>
                  <Label
                    value="Area of Bula Pesa Ward"
                    offset={-10}
                    position="insideBottom"
                    fill="#6b7280"
                    fontSize={11}
                  />
                </XAxis>
                <YAxis
                  domain={[0, 5]}
                  stroke="#6b7280"
                  tick={{ fontSize: 11 }}
                  ticks={[0, 1, 2, 3, 4, 5]}
                >
                  <Label
                    value="BCS (1–5)"
                    angle={-90}
                    position="insideLeft"
                    fill="#6b7280"
                    fontSize={11}
                    style={{ textAnchor: "middle" }}
                  />
                </YAxis>
                <ReferenceLine
                  y={2.5}
                  yAxisId={0}
                  stroke="#ef4444"
                  strokeDasharray="4 4"
                  label={{
                    value: "Crisis line",
                    fill: "#f87171",
                    fontSize: 10,
                    position: "insideTopRight",
                  }}
                />
                <RTooltip
                  contentStyle={{
                    background: "#111827",
                    border: "1px solid #374151",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(
                    value: unknown,
                    _name: unknown,
                    p: { payload?: { samples?: number } },
                  ) => [
                    `${typeof value === "number" ? value.toFixed(2) : value} (${p.payload?.samples ?? 0} reports)`,
                    "BCS avg",
                  ]}
                />
                <Bar
                  dataKey="bcs"
                  radius={[6, 6, 0, 0]}
                  name="Body Condition Score"
                >
                  {bcsChartData.map((d, i) => (
                    <Cell key={i} fill={bcsBarColor(d.bcs)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-sm text-gray-500 italic py-10 text-center">
              No BCS samples yet. Once herders answer the body-condition
              question on calls, this chart will populate.
            </div>
          )}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-amber-400" /> Satellite vs.
            herder ground truth
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            <span className="text-emerald-400">Green</span> = animals on the
            ground (BCS 1–5, higher is better) ·{" "}
            <span className="text-amber-400">Orange</span> = pasture from space
            (NDVI Δ%, more negative = drier than normal). Green low + orange
            deep negative → that area needs help now.
          </p>
          {correlationData.some((d) => d.samples > 0) ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={correlationData}
                margin={{ top: 5, right: 15, bottom: 30, left: 15 }}
              >
                <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="#6b7280" tick={{ fontSize: 11 }}>
                  <Label
                    value="Area of Bula Pesa Ward"
                    offset={-10}
                    position="insideBottom"
                    fill="#6b7280"
                    fontSize={11}
                  />
                </XAxis>
                <YAxis
                  yAxisId="left"
                  stroke="#22c55e"
                  tick={{ fontSize: 11 }}
                  domain={[0, 5]}
                  ticks={[0, 1, 2, 3, 4, 5]}
                >
                  <Label
                    value="BCS (herder, 1–5)"
                    angle={-90}
                    position="insideLeft"
                    fill="#22c55e"
                    fontSize={11}
                    style={{ textAnchor: "middle" }}
                  />
                </YAxis>
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#f59e0b"
                  tick={{ fontSize: 11 }}
                >
                  <Label
                    value="NDVI Δ% (satellite)"
                    angle={90}
                    position="insideRight"
                    fill="#f59e0b"
                    fontSize={11}
                    style={{ textAnchor: "middle" }}
                  />
                </YAxis>
                <ReferenceLine
                  yAxisId="right"
                  y={0}
                  stroke="#4b5563"
                  strokeDasharray="2 2"
                />
                <RTooltip
                  contentStyle={{
                    background: "#111827",
                    border: "1px solid #374151",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: unknown, name: unknown) => {
                    const v =
                      typeof value === "number"
                        ? value.toFixed(2)
                        : String(value);
                    return [v, String(name)];
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  iconType="circle"
                />
                <Bar
                  yAxisId="left"
                  dataKey="bcs"
                  fill="#22c55e"
                  radius={[4, 4, 0, 0]}
                  name="Herder BCS (1–5)"
                />
                <Bar
                  yAxisId="right"
                  dataKey="ndvi"
                  fill="#f59e0b"
                  radius={[4, 4, 0, 0]}
                  name="Satellite NDVI Δ%"
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-sm text-gray-500 italic py-10 text-center">
              Awaiting reports tagged to quadrants.
            </div>
          )}
        </div>
      </div>

      {/* Recent indicator table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">
            Recent ground-truth reports
          </h3>
          <span className="text-xs text-gray-500">{reports.length} shown</span>
        </div>
        {reports.length === 0 ? (
          <div className="text-sm text-gray-500 italic px-4 py-10 text-center">
            No reports yet. Trigger a satellite check and accept the demo call
            to populate.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-gray-800 hover:bg-transparent">
                  <TableHead className="text-gray-400">When</TableHead>
                  <TableHead className="text-gray-400">Where</TableHead>
                  <TableHead className="text-gray-400">BCS</TableHead>
                  <TableHead className="text-gray-400">Offtake</TableHead>
                  <TableHead className="text-gray-400">Mortality</TableHead>
                  <TableHead className="text-gray-400">Milk</TableHead>
                  <TableHead className="text-gray-400">Water point</TableHead>
                  <TableHead className="text-gray-400">Trust</TableHead>
                  <TableHead className="text-gray-400 text-right">
                    Filled
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((r) => (
                  <TableRow
                    key={r.id}
                    className="border-gray-800"
                    data-testid={`row-report-${r.id}`}
                  >
                    <TableCell className="text-xs text-gray-400 whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleDateString()}
                      <div className="text-[10px] text-gray-600">
                        {new Date(r.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-gray-300">
                      {r.reportedLocation ?? "—"}
                      <div className="text-[10px] text-gray-600">
                        {r.reportedQuadrant ?? "unmapped"}
                      </div>
                    </TableCell>
                    <TableCell>
                      {r.bcsScore != null ? (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium"
                          style={{
                            background: `${bcsBarColor(r.bcsScore)}22`,
                            color: bcsBarColor(r.bcsScore),
                          }}
                        >
                          {r.bcsScore.toFixed(1)}
                          {r.bcsFlagFollowup ? (
                            <AlertTriangle className="w-3 h-3" />
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-gray-300">
                      {r.offtakeRate ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-gray-300">
                      {r.mortalityRate ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-gray-300">
                      {r.milkProduction ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-gray-300">
                      {r.waterPointName ?? "—"}
                      {r.waterPointStatus ? (
                        <div className="text-[10px] text-gray-500">
                          {r.waterPointStatus}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {r.trustScore != null ? (
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                          style={
                            r.trustScore < 60
                              ? { background: "#facc1522", color: "#facc15" }
                              : { background: "#22c55e22", color: "#22c55e" }
                          }
                          title={
                            r.trustFlags && r.trustFlags.length > 0
                              ? r.trustFlags.join(", ")
                              : "No trust flags"
                          }
                          data-testid={`trust-${r.id}`}
                        >
                          {r.trustScore}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-gray-400 text-right">
                      {r.indicatorsCollected ?? 0}/7
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <p className="text-[10px] text-gray-600 text-center pt-2">
        Indicators follow ILRI/FAO Tropical BCS, FEWS NET Livestock, LEGS
        Emergency Guidelines, FAO Animal Welfare, and WFP Coping Strategy Index.
        All fields nullable — no value is ever invented.
      </p>
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-semibold ${accent ?? "text-white"}`}>
        {value}
      </div>
    </div>
  );
}

// --- Main Dashboard ---
export default function Dashboard({ session }: { session?: import("@/components/AuthGate").SessionInfo }) {
  const [tab, setTab] = useState<
    "map" | "pastoralists" | "groundtruth" | "chat" | "choropleth"
  >("map");
  // Ward selected in the Choropleth tab. Owned here so the selection
  // survives a tab switch.
  const [selectedWardId, setSelectedWardId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [mintingCall, setMintCall] = useState(false);
  const [briefLang, setBriefLang] = useState<"en" | "sw">("en");
  // Pre-minted token so the "Hear ArdaLink call you" button can open the
  // new tab INSTANTLY — no network roundtrip on click, no about:blank
  // splash. Refreshed in the background after each use. Tokens are
  // single-use with a 15-minute TTL, so we re-mint well before expiry.
  const prefetchedToken = useRef<{ token: string; expiresAt: number } | null>(
    null,
  );
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Mint a token in the background and stash it for the next click.
  // Failures are swallowed — the click handler has a synchronous fallback.
  // We use the api-client-react helper which attaches the Bearer token
  // from localStorage; without it, the api returns 401 (Missing Bearer).
  const mintMutation = useMintCallToken();
  const refreshPrefetchedToken = async () => {
    try {
      const data = await mintMutation.mutateAsync(undefined);
      prefetchedToken.current = {
        token: data.token,
        expiresAt: data.expiresAt,
      };
    } catch {
      /* offline / blocked — fallback path handles it */
    }
  };

  // Pre-mint one on mount so the first click is fast.
  useEffect(() => {
    void refreshPrefetchedToken();
  }, []);

  // Demo flow: open the herder-side incoming-call screen in a new tab.
  // Fast path: token pre-minted on mount → open the URL directly (instant)
  // and silently refresh for next time.
  // Slow path: pre-mint missed or expired → fall back to the about:blank
  // splash + synchronous mint.
  const handleHearTheCall = async () => {
    // Always open the tab SYNCHRONOUSLY inside the click handler so popup
    // blockers treat it as a user gesture, and always paint the "Dialling…"
    // splash for theatre. The difference between fast and slow paths is
    // *what we await* before navigating: a pre-minted token (instant) vs.
    // a fresh mint (network roundtrip).
    // NOTE: do NOT use `noopener` here — that nulls the returned window
    // reference, which we need to navigate the tab after the token is
    // ready. Always navigate with an ABSOLUTE URL — about:blank has no
    // base origin, so relative paths resolve to about:blank/… and stick.
    const win = window.open("about:blank", "_blank");
    if (!win) {
      toast({
        title: "Pop-up blocked",
        description: "Allow pop-ups for this site so ArdaLink can call you.",
        variant: "destructive",
      });
      return;
    }
    try {
      win.document.write(
        "<!doctype html><html><head><title>ArdaLink — dialling…</title>" +
          "<style>html,body{margin:0;height:100%;background:#0a0a0a;color:#fbbf24;" +
          "font-family:system-ui,sans-serif;display:flex;align-items:center;" +
          "justify-content:center;font-size:18px;letter-spacing:0.02em}" +
          ".dot{display:inline-block;width:8px;height:8px;border-radius:50%;" +
          "background:#fbbf24;margin:0 4px;animation:p 1.2s infinite ease-in-out}" +
          ".dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}" +
          "@keyframes p{0%,80%,100%{opacity:.2}40%{opacity:1}}</style>" +
          '</head><body><div>📡 Dialling your phone<span class="dot"></span>' +
          '<span class="dot"></span><span class="dot"></span></div></body></html>',
      );
      win.document.close();
    } catch {
      /* cross-origin write may fail — harmless */
    }
    setMintingCall(true);
    // Minimum splash time so the "📡 Dialling…" animation is always
    // perceptible — even on the fast path where the token is already in
    // hand and the URL could be set in a few milliseconds. Without this
    // the splash flickers; with it, the dialling beat lands.
    const SPLASH_MIN_MS = 750;
    const splashUntil = Date.now() + SPLASH_MIN_MS;
    try {
      // Fast path: a pre-minted token is ready → skip the network call.
      // Slow path: pre-mint missed/expired → mint synchronously now.
      const pre = prefetchedToken.current;
      const FRESH_MS = 60_000;
      let token: string;
      if (pre && pre.expiresAt - Date.now() > FRESH_MS) {
        prefetchedToken.current = null; // consume — never reuse
        token = pre.token;
        void refreshPrefetchedToken(); // ready for next click
      } else {
        // Slow path: synchronous mint with the Bearer token attached.
        const data = await mintMutation.mutateAsync(undefined);
        token = data.token;
      }
      // Hold the splash until SPLASH_MIN_MS has elapsed so the dialling
      // animation is always visible, even on the fast path.
      const remaining = splashUntil - Date.now();
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      // Absolute URL is essential — relative paths break from about:blank.
      const url = new URL(`/call/${token}`, window.location.origin).href;
      try {
        win.location.replace(url);
      } catch {
        // If the win.location setter is blocked (rare cross-origin edge case),
        // fall back to opening a fresh tab on the same gesture chain.
        window.open(url, "_blank");
        try {
          win.close();
        } catch {
          /* ignore */
        }
      }
      toast({
        title: "Your phone is ringing →",
        description: "Switch to the new tab and tap Accept to take the call.",
      });
    } catch (err) {
      try {
        win.close();
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : "Failed to start";
      toast({
        title: "Could not start the call",
        description: message,
        variant: "destructive",
      });
    } finally {
      setMintingCall(false);
    }
  };

  const {
    data: statusData,
    isLoading: loadingStatus,
    refetch: refetchStatus,
  } = useGetStatus({
    query: {
      refetchInterval: (query) => (query.state.data?.is_running ? 5000 : 30000),
      queryKey: getGetStatusQueryKey(),
    },
  });

  const { data: forecastData, isError: forecastError } = useGetForecast({
    query: { retry: false, queryKey: getGetForecastQueryKey() },
  });

  const triggerCheck = useTriggerCheck();
  const [waitingForBackgroundRun, setWaitingForBackgroundRun] = useState(false);
  const checkInFlight = triggerCheck.isPending || waitingForBackgroundRun;

  const handleTriggerCheck = () => {
    triggerCheck.mutate(
      { data: { dryRun: true, forceAlert: false } },
      {
        onSuccess: () => {
          toast({ title: "Satellite check complete" });
          queryClient.invalidateQueries({ queryKey: getGetStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        },
        onError: async (err) => {
          // Surface the real reason instead of a generic "failed" toast.
          // ApiError carries the server's { error: "..." } body in .data.
          const apiErr = err as {
            status?: number;
            data?: { error?: string };
            message?: string;
          };
          const status = apiErr.status;
          const serverMsg =
            (apiErr.data && typeof apiErr.data.error === "string"
              ? apiErr.data.error
              : undefined) ?? apiErr.message;

          // 409 = scheduler (or a previous click) is already running the pipeline.
          // Don't fail — wait for it to finish and refresh the dashboard.
          if (status === 409) {
            toast({
              title: "Satellite run already in progress",
              description: "Waiting for the current run to finish…",
            });
            setWaitingForBackgroundRun(true);
            const startedAt = Date.now();
            try {
              while (Date.now() - startedAt < 90_000) {
                await new Promise((r) => setTimeout(r, 2000));
                try {
                  const s = await getStatus();
                  if (!s.is_running) {
                    queryClient.invalidateQueries({
                      queryKey: getGetStatusQueryKey(),
                    });
                    queryClient.invalidateQueries({
                      queryKey: getGetForecastQueryKey(),
                    });
                    toast({ title: "Satellite check complete" });
                    return;
                  }
                } catch {
                  // transient — keep polling
                }
              }
              toast({
                title: "Satellite check timed out",
                description:
                  "The background run is taking longer than usual. Try again in a moment.",
                variant: "destructive",
              });
            } finally {
              setWaitingForBackgroundRun(false);
            }
            return;
          }

          toast({
            title: "Satellite check failed",
            description: serverMsg ?? "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const { data: pastoralistsData, isLoading: loadingPastoralists } =
    useListPastoralists({
      query: { queryKey: getListPastoralistsQueryKey() },
    });

  const deletePastoralist = useDeletePastoralist();

  const handleDeletePastoralist = (id: number) => {
    deletePastoralist.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Pastoralist removed" });
          queryClient.invalidateQueries({
            queryKey: getListPastoralistsQueryKey(),
          });
        },
        onError: () => {
          toast({
            title: "Failed to remove pastoralist",
            variant: "destructive",
          });
        },
      },
    );
  };

  // --- Pastoralist Form ---
  const pastoralistSchema = z.object({
    name: z.string().min(1, "Required"),
    phone: z.string().min(1, "Required"),
    location: z.string().optional(),
    cattle: z.coerce.number().optional(),
    goats: z.coerce.number().optional(),
    camels: z.coerce.number().optional(),
    waterSource: z.string().optional(),
    alertsEnabled: z.boolean().default(true),
  });

  const form = useForm<z.infer<typeof pastoralistSchema>>({
    resolver: zodResolver(pastoralistSchema),
    defaultValues: {
      name: "",
      phone: "",
      location: "",
      cattle: 0,
      goats: 0,
      camels: 0,
      waterSource: "Borehole",
      alertsEnabled: true,
    },
  });

  const createPastoralist = useCreatePastoralist();
  const onSubmitPastoralist = (data: z.infer<typeof pastoralistSchema>) => {
    createPastoralist.mutate(
      { data },
      {
        onSuccess: () => {
          toast({ title: "Pastoralist registered successfully" });
          form.reset();
          queryClient.invalidateQueries({
            queryKey: getListPastoralistsQueryKey(),
          });
        },
        onError: () => {
          toast({
            title: "Failed to register pastoralist",
            variant: "destructive",
          });
        },
      },
    );
  };

  // --- Chat ---
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<
    { role: "user" | "assistant" | "system"; content: string; context?: any }[]
  >([
    {
      role: "system",
      content: "ArdaLink is ready. Ask me anything about your land.",
    },
  ]);
  const chatMutation = useChatWithLand();
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, chatMutation.isPending]);

  const handleSendChat = (messageText: string = chatInput) => {
    if (!messageText.trim() || chatMutation.isPending) return;

    const userMsg = messageText.trim();
    setChatInput("");
    setChatHistory((prev) => [...prev, { role: "user", content: userMsg }]);

    const historyForApi = chatHistory
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    chatMutation.mutate(
      { data: { message: userMsg, history: historyForApi } },
      {
        onSuccess: (reply) => {
          setChatHistory((prev) => [
            ...prev,
            {
              role: "assistant",
              content: reply.reply,
              context: reply.context,
            },
          ]);
        },
        onError: () => {
          toast({ title: "Failed to send message", variant: "destructive" });
          setChatHistory((prev) => prev.slice(0, -1)); // Remove failed message
        },
      },
    );
  };

  const d = statusData?.last_run as any;
  const f = forecastData as any;

  const navigate = (next: "map" | "pastoralists" | "groundtruth" | "chat" | "choropleth") => {
    setTab(next);
    setNavOpen(false);
  };

  const sidebarInner = (
    <>
      <div className="px-4 py-5 border-b border-gray-800">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shrink-0">
            <Satellite className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-base text-white tracking-wide">
            ArdaLink AI
          </span>
        </div>
        <div className="text-xs text-gray-500 pl-10">
          Bula Pesa Ward · Isiolo
        </div>
      </div>

      <div className="mx-3 mt-4 px-3 py-2 bg-green-900/30 border border-green-800/50 rounded-lg flex items-center gap-2">
        {statusData?.is_running ? (
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-green-400" />
        )}
        <span
          className={`text-xs font-medium ${statusData?.is_running ? "text-amber-400" : "text-green-400"}`}
        >
          {statusData?.is_running ? "Running Analysis..." : "System Live"}
        </span>
      </div>

      <nav className="flex-1 px-3 py-6 space-y-1">
        <button
          data-testid="nav-map"
          onClick={() => navigate("map")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === "map" ? "bg-amber-600/20 text-amber-400 border border-amber-600/30" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"}`}
        >
          <Satellite className="w-4 h-4" /> Map & Conditions
        </button>
        <button
          data-testid="nav-pastoralists"
          onClick={() => navigate("pastoralists")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === "pastoralists" ? "bg-amber-600/20 text-amber-400 border border-amber-600/30" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"}`}
        >
          <Users className="w-4 h-4" /> Pastoralists
        </button>
        <button
          data-testid="nav-groundtruth"
          onClick={() => navigate("groundtruth")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === "groundtruth" ? "bg-amber-600/20 text-amber-400 border border-amber-600/30" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"}`}
        >
          <ClipboardList className="w-4 h-4" /> Ground Truth
        </button>
        <button
          data-testid="nav-choropleth"
          onClick={() => navigate("choropleth")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === "choropleth" ? "bg-amber-600/20 text-amber-400 border border-amber-600/30" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"}`}
        >
          <Globe className="w-4 h-4" /> Choropleth
        </button>
        <button
          data-testid="nav-chat"
          onClick={() => navigate("chat")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === "chat" ? "bg-amber-600/20 text-amber-400 border border-amber-600/30" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"}`}
        >
          <MessageSquare className="w-4 h-4" /> Chat with Land
        </button>
      </nav>

      {d?.triggered && d?.live?.anomaly && (
        <div className="mx-3 mb-6 p-3 bg-red-950/40 border border-red-900/50 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            <span className="text-xs font-semibold text-red-400">
              Active Alert
            </span>
          </div>
          <div className="text-xs text-gray-400 leading-relaxed">
            {d.live.anomaly.wardStressedPixelPct?.toFixed(1)}% of ward stressed
            · {d.live.anomaly.worstQuadrant} critical
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col md:flex-row min-h-[100dvh] md:h-screen w-full bg-gray-950 text-gray-100 font-sans md:overflow-hidden">
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
            {sidebarInner}
          </SheetContent>
        </Sheet>
      </div>

      {/* --- Desktop Sidebar --- */}
      <div className="hidden md:flex w-64 shrink-0 bg-gray-900 border-r border-gray-800 flex-col">
        {sidebarInner}
      </div>

      {/* --- Main Content --- */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-gray-800 bg-gray-900/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-semibold text-white">
              {tab === "map"
                ? "Live Vegetation Intelligence"
                : tab === "pastoralists"
                  ? "Herder Registry"
                  : tab === "groundtruth"
                    ? "Ground Truth Intelligence"
                    : "Chat with your Land"}
            </h1>
            <p className="text-xs sm:text-sm text-gray-500">
              {tab === "map" && d
                ? `Last updated: ${new Date(d.timestamp).toLocaleString()}`
                : tab === "pastoralists"
                  ? "Manage herders and alerts"
                  : tab === "groundtruth"
                    ? "Herder voice reports → ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI standards"
                    : "Ask anything in English or Swahili"}
            </p>
          </div>
          <div className="flex items-center flex-wrap gap-2 sm:gap-3">
            {f?.forecast?.outlook?.riskLevel && (
              <span
                className={`px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-full text-[10px] sm:text-xs font-semibold border ${riskBadge(f.forecast.outlook.riskLevel.toUpperCase())}`}
              >
                {f.forecast.outlook.riskLevel.toUpperCase()} RISK
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleTriggerCheck}
              disabled={checkInFlight}
              className="bg-amber-600/20 border-amber-700/50 text-amber-300 hover:bg-amber-600/30 hover:text-amber-200"
              data-testid="btn-trigger-check"
            >
              {checkInFlight ? (
                <>
                  <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" />{" "}
                  <span className="hidden sm:inline">
                    {waitingForBackgroundRun ? "Waiting…" : "Running…"}
                  </span>
                </>
              ) : (
                <>
                  <Satellite className="w-4 h-4 sm:mr-2" />{" "}
                  <span className="hidden sm:inline">Run satellite check</span>
                  <span className="sm:hidden ml-1">Check</span>
                </>
              )}
            </Button>
            <Button
              size="sm"
              onClick={handleHearTheCall}
              disabled={mintingCall}
              className="bg-green-600 hover:bg-green-700 text-white border border-green-500/60 shadow-lg shadow-green-900/40"
              data-testid="btn-hear-the-call"
              aria-label="Hear ArdaLink call you — opens an incoming-call demo in a new tab"
            >
              {mintingCall ? (
                <>
                  <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" />{" "}
                  <span className="hidden sm:inline">Dialling…</span>
                </>
              ) : (
                <>
                  <PhoneCall className="w-4 h-4 sm:mr-2" />{" "}
                  <span className="hidden sm:inline">
                    Hear ArdaLink call you
                  </span>
                  <span className="sm:hidden ml-1">Ring me</span>{" "}
                  <ExternalLink className="w-3 h-3 ml-1.5 opacity-70 hidden sm:inline" />
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCallOpen(true)}
              className="bg-gray-900 border-gray-700 text-gray-400 hover:text-white hidden md:inline-flex"
              data-testid="btn-open-call"
              aria-label="Open operator call console"
              title="Operator console — in-page WebRTC, AT sandbox, share link"
            >
              <Radio className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => refetchStatus()}
              disabled={loadingStatus}
              className="bg-gray-900 border-gray-700 text-gray-400 hover:text-white"
              data-testid="btn-refresh"
            >
              <RefreshCw
                className={`w-4 h-4 ${loadingStatus ? "animate-spin" : ""}`}
              />
            </Button>
            {session && <UserMenu session={session} />}
          </div>
        </div>
        <CallModal open={callOpen} onOpenChange={setCallOpen} />

        {/* --- Value proposition strip (visible on every tab so judges always see it) --- */}
        <div className="px-3 sm:px-6 py-3 border-b border-gray-800 bg-gradient-to-r from-amber-950/40 via-gray-900/60 to-gray-900/30 shrink-0">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="min-w-0 md:max-w-2xl">
              <p className="text-xs sm:text-sm text-gray-200 leading-snug">
                <span className="text-amber-400 font-semibold">
                  When pasture dies, herders are the last to know.
                </span>{" "}
                ArdaLink spots drought from satellites — then{" "}
                <span className="text-amber-300 font-medium">
                  phones each herder in their own language
                </span>
                .{" "}
                <span className="text-gray-300">Swahili and English today</span>
                <span className="text-gray-500">
                  {" "}
                  · Borana, Turkana, Samburu &amp; Somali next
                </span>
                .{" "}
                <span className="text-gray-400">
                  No smartphone. No app. Just a 2G voice call.
                </span>
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800/80 border border-gray-700 text-gray-400">
                  Satellite → AI → Voice call
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/40 border border-amber-700/50 text-amber-300 font-medium">
                  ● Live · Isiolo County, Kenya
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-900/40 border border-emerald-700/50 text-emerald-300 font-medium">
                  Multi-dialect ready
                </span>
              </div>
            </div>
            {d?.live?.anomaly && (
              <div className="md:text-right shrink-0 border-t md:border-t-0 md:border-l border-gray-800 md:pl-4 pt-2 md:pt-0">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">
                  Currently monitoring
                </div>
                <div className="text-sm font-semibold text-white">
                  {d.live.anomaly.wardStressedPixelPct?.toFixed(1)}% of ward
                  stressed
                </div>
                <div className="text-xs text-amber-300">
                  {d.live.anomaly.worstQuadrant} quadrant{" "}
                  {d.live.anomaly.quadrantMeanAnomalyPct?.[
                    d.live.anomaly.worstQuadrant
                  ]?.toFixed(1)}
                  % vs 11-yr norm
                </div>
              </div>
            )}
          </div>
        </div>

        {/* --- AI Intelligence Brief — always-visible hero card --- */}
        <div className="px-3 sm:px-6 py-3 border-b border-gray-800 bg-gray-950/40 shrink-0">
          <IntelligenceBrief
            lang={briefLang}
            onLangChange={setBriefLang}
          />
        </div>

        <div className="flex-1 md:overflow-hidden md:relative">
          {/* --- Tab: Map --- */}
          {tab === "map" && (
            <div className="md:absolute md:inset-0 flex flex-col md:flex-row">
              <div className="flex-1 p-3 sm:p-6 md:overflow-y-auto">
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
                      pastoralists={(pastoralistsData ?? []).map((p) => ({
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
                    <div className="text-gray-500">
                      No satellite data available
                    </div>
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
                              <strong>Rec:</strong>{" "}
                              {f.forecast.outlook.recommendation}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          )}

          {/* --- Tab: Pastoralists --- */}
          {tab === "pastoralists" && (
            <div className="md:absolute md:inset-0 flex flex-col md:flex-row p-3 sm:p-6 gap-4 sm:gap-6 md:overflow-y-auto">
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
                        <TableHead className="text-gray-400">
                          Name / Phone
                        </TableHead>
                        <TableHead className="text-gray-400">
                          Location
                        </TableHead>
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
                          <TableCell
                            colSpan={5}
                            className="text-center py-8 text-gray-500"
                          >
                            Loading...
                          </TableCell>
                        </TableRow>
                      ) : !pastoralistsData?.length ? (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="text-center py-8 text-gray-500"
                          >
                            No pastoralists registered.
                          </TableCell>
                        </TableRow>
                      ) : (
                        pastoralistsData.map((p) => (
                          <TableRow
                            key={p.id}
                            className="border-gray-800 hover:bg-gray-800/50"
                          >
                            <TableCell>
                              <div className="font-medium text-gray-200">
                                {p.name}
                              </div>
                              <div className="text-xs text-gray-500">
                                {p.phone}
                              </div>
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
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="w-full md:w-80 md:shrink-0 bg-gray-900 border border-gray-800 rounded-2xl p-4 sm:p-5 h-fit">
                <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
                  <Plus className="w-4 h-4" /> Register Herder
                </h3>
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(onSubmitPastoralist)}
                    className="space-y-4"
                  >
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-300">
                            Full Name
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              className="bg-gray-950 border-gray-700 text-white"
                              data-testid="input-name"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-300">
                            Phone Number
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder="+254..."
                              className="bg-gray-950 border-gray-700 text-white"
                              data-testid="input-phone"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="location"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-300">
                            Location / Area
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              className="bg-gray-950 border-gray-700 text-white"
                              data-testid="input-location"
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <FormField
                        control={form.control}
                        name="cattle"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-gray-400">
                              Cattle
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                {...field}
                                className="bg-gray-950 border-gray-700 text-white h-8"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="goats"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-gray-400">
                              Goats/Sheep
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                {...field}
                                className="bg-gray-950 border-gray-700 text-white h-8"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="camels"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-gray-400">
                              Camels
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                {...field}
                                className="bg-gray-950 border-gray-700 text-white h-8"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="waterSource"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-300">
                            Primary Water Source
                          </FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger className="bg-gray-950 border-gray-700 text-white">
                                <SelectValue placeholder="Select source" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent className="bg-gray-900 border-gray-700 text-white">
                              <SelectItem value="Borehole">Borehole</SelectItem>
                              <SelectItem value="River">River</SelectItem>
                              <SelectItem value="Dam">Dam / Pan</SelectItem>
                              <SelectItem value="Berkad">Berkad</SelectItem>
                              <SelectItem value="Other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="alertsEnabled"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between rounded-lg border border-gray-800 p-3 bg-gray-950/50">
                          <div className="space-y-0.5">
                            <FormLabel className="text-gray-300 text-sm">
                              SMS Alerts
                            </FormLabel>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              data-testid="switch-alerts"
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <Button
                      type="submit"
                      disabled={createPastoralist.isPending}
                      className="w-full bg-amber-600 hover:bg-amber-700 text-white"
                      data-testid="btn-submit-pastoralist"
                    >
                      {createPastoralist.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        "Register"
                      )}
                    </Button>
                  </form>
                </Form>
              </div>
            </div>
          )}

          {/* --- Tab: Ground Truth Intelligence --- */}
          {tab === "groundtruth" && <GroundTruthSection />}

          {/* --- Tab: Choropleth (Isiolo wards) --- */}
          {tab === "choropleth" && (
            <div className="p-3 sm:p-6 md:overflow-y-auto h-full">
              <ChoroplethErrorBoundary>
                <Choropleth
                  selectedWardId={selectedWardId}
                  onSelectWard={setSelectedWardId}
                />
              </ChoroplethErrorBoundary>
            </div>
          )}

          {/* --- Tab: Chat --- */}
          {tab === "chat" && (
            <div className="md:absolute md:inset-0 flex flex-col bg-gray-900 min-h-[60vh]">
              <div className="flex-1 md:overflow-y-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
                {chatHistory.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                        msg.role === "system"
                          ? "bg-blue-900/20 border border-blue-800/40 text-blue-200"
                          : msg.role === "user"
                            ? "bg-amber-600/20 border border-amber-600/30 text-amber-100 rounded-tr-sm"
                            : "bg-gray-800 border border-gray-700 text-gray-200 rounded-tl-sm flex gap-3 items-start"
                      }`}
                    >
                      {msg.role === "assistant" && (
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-green-600 to-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
                          <Radio className="w-3 h-3 text-green-100" />
                        </div>
                      )}
                      <div>
                        {msg.role === "system" && (
                          <span className="font-semibold text-blue-400 mr-2">
                            System:
                          </span>
                        )}
                        {msg.content}
                        {msg.context && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {msg.context.riskLevel && (
                              <span className="px-2 py-0.5 text-[10px] rounded-full bg-gray-900 text-gray-400 border border-gray-700">
                                Risk: {msg.context.riskLevel}
                              </span>
                            )}
                            {msg.context.worstQuadrant && (
                              <span className="px-2 py-0.5 text-[10px] rounded-full bg-gray-900 text-gray-400 border border-gray-700">
                                Worst: {msg.context.worstQuadrant}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {chatMutation.isPending && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] bg-gray-800 border border-gray-700 text-gray-400 rounded-2xl rounded-tl-sm px-4 py-3 text-sm flex items-center gap-3">
                      <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
                      Analyzing satellite + climate data...
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="p-4 bg-gray-950 border-t border-gray-800 shrink-0">
                <div className="flex flex-wrap gap-2 mb-3">
                  {[
                    "Je, mvua inakuja lini?",
                    "Where is the best pasture now?",
                    "Should I move my cattle from SE?",
                    "Hali ya maji Bula Pesa?",
                  ].map((q, i) => (
                    <button
                      key={i}
                      onClick={() => handleSendChat(q)}
                      className="px-3 py-1.5 bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-full text-xs text-gray-400 transition-colors"
                      data-testid={`btn-quick-chat-${i}`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendChat();
                  }}
                  className="flex items-end gap-3"
                >
                  <div className="flex-1 relative">
                    <Input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Ask about conditions, forecast, or recommendations..."
                      className="w-full bg-gray-900 border-gray-700 text-white h-12 pl-4 pr-12 rounded-xl focus-visible:ring-amber-500"
                      disabled={chatMutation.isPending}
                      data-testid="input-chat"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={!chatInput.trim() || chatMutation.isPending}
                    size="icon"
                    className="h-12 w-12 rounded-xl bg-amber-600 hover:bg-amber-700 shrink-0"
                    data-testid="btn-send-chat"
                  >
                    <Send className="w-5 h-5 text-white" />
                  </Button>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
