import {
  ClipboardList,
  Activity,
  Heart,
  AlertTriangle,
  TrendingDown,
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
  useGetGroundTruthSummary,
  useListGroundTruthRecent,
  getGetGroundTruthSummaryQueryKey,
  getListGroundTruthRecentQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CostRailsCard } from "@/components/CostRailsCard";
import { OpenDataCard } from "@/components/OpenDataCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bcsBarColor } from "@/lib/dashboard-colors";
import { KpiCard } from "./KpiCard";

const QUADRANT_LABEL: Record<string, string> = {
  NW: "NW · Wabera",
  NE: "NE · Ngare Mara",
  SW: "SW · Bulla Pesa",
  SE: "SE · Kambi Garba",
};

/** Ground Truth Intelligence section with BCS charts, alerts, and reports table */
export function GroundTruthSection() {
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

  const bcsChartData: { name: string; bcs: number | null; samples: number }[] = (
    summary?.byQuadrant ?? []
  ).map((q) => ({
    name: QUADRANT_LABEL[q.quadrant] ?? q.quadrant,
    bcs: q.bcsAverage,
    samples: q.bcsSampleCount,
  }));

  const correlationData: {
    name: string;
    bcs: number | null;
    ndvi: number | null;
    samples: number;
  }[] = (summary?.byQuadrant ?? []).map((q) => ({
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
    <div className="p-4 sm:p-6 space-y-6" data-testid="section-ground-truth">
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
                      typeof value === "number" ? value.toFixed(2) : String(value);
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
                {reports.map(
                  (r: import("@workspace/api-client-react").GroundTruthReport) => (
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
                  ),
                )}
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
