/**
 * Header — the Choropleth's control bar.
 *
 * Owns the metric and slice toggle groups plus the layer toggles.
 * Pure presentational component — every interaction is delegated via
 * callbacks so the orchestrator owns the state.
 */
import {
  Compass,
  Plane,
  Layers as LayersIcon,
  Users,
  MapPin,
} from "lucide-react";
import {
  TIME_SLICE_LABELS,
  type ChoroplethMetric,
  type TimeSlice,
} from "@workspace/api-client-react";

/** Ordered list of time slices shown in the slider. */
const SLICE_ORDER: TimeSlice[] = ["live", "7d", "30d", "90d", "1y", "all"];

/** Metric buttons shown in the header. */
const METRIC_OPTIONS: Array<{ value: ChoroplethMetric; label: string }> = [
  { value: "reports", label: "Reports" },
  { value: "bcs", label: "Avg BCS" },
  { value: "ndvi", label: "NDVI Δ" },
  { value: "herd", label: "Herd total" },
];

type LayerToggleProps = {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  count: number;
  onToggle: (next: boolean) => void;
  color: "emerald" | "amber";
};

/** Small pill button for a single layer toggle. */
function LayerToggle({ label, icon, active, count, onToggle, color }: LayerToggleProps) {
  const colors = {
    emerald: {
      active: "bg-emerald-600/30 border-emerald-600 text-emerald-200",
      inactive: "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200",
    },
    amber: {
      active: "bg-amber-600/30 border-amber-600 text-amber-200",
      inactive: "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200",
    },
  };
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      aria-pressed={active}
      data-testid={`choropleth-layer-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={
        "px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors flex items-center gap-1.5 " +
        (active ? colors[color].active : colors[color].inactive)
      }
    >
      {icon}
      <span>{label}</span>
      {count > 0 && (
        <span className="font-mono opacity-70">({count})</span>
      )}
    </button>
  );
}

type SliceSliderProps = {
  value: TimeSlice;
  onChange: (s: TimeSlice) => void;
  slices: TimeSlice[];
};

/** Time-travel slider — five ordered stops with quick-jump chips below. */
function SliceSlider({ value, onChange, slices }: SliceSliderProps) {
  const idx = slices.indexOf(value);
  return (
    <div className="flex flex-col gap-1 min-w-[260px] flex-1 max-w-[480px]">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
        <span className="inline-flex items-center gap-1">
          <Plane className="w-3 h-3" />
          Time travel
        </span>
        <span
          className="font-mono text-amber-300 normal-case tracking-normal"
          data-testid="choropleth-slice-label"
        >
          {TIME_SLICE_LABELS[value]}
        </span>
      </div>
      <div className="relative">
        <div
          aria-hidden
          className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-gradient-to-r from-emerald-500/30 via-amber-500/30 to-red-500/40 pointer-events-none"
        />
        <input
          type="range"
          min={0}
          max={slices.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(slices[Number(e.target.value)]!)}
          data-testid="choropleth-slice-slider"
          aria-label="Time travel"
          className="relative w-full appearance-none bg-transparent cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-amber-400
            [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_rgba(251,191,36,0.25)]
            [&::-webkit-slider-thumb]:cursor-grab
            [&::-webkit-slider-thumb]:transition-shadow
            [&::-webkit-slider-thumb]:hover:shadow-[0_0_0_6px_rgba(251,191,36,0.35)]
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-amber-400
            [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:cursor-grb"
        />
        <div className="flex justify-between mt-1 text-[9px] text-gray-500 font-mono">
          {slices.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange(s)}
              className={
                "px-1 rounded transition-colors " +
                (s === value
                  ? "text-amber-300"
                  : "hover:text-gray-300")
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type HeaderProps = {
  metric: ChoroplethMetric;
  onMetricChange: (m: ChoroplethMetric) => void;
  slice: TimeSlice;
  onSliceChange: (s: TimeSlice) => void;
  showHerderPins: boolean;
  onToggleHerderPins: (next: boolean) => void;
  showReportPins: boolean;
  onToggleReportPins: (next: boolean) => void;
  wardCount: number;
  pastoralistCount: number;
  reportCount: number;
};

/**
 * Header — controls for the Choropleth.
 *
 * Removed in the redesign:
 * - the wards/counties view toggle (counties view is gone)
 * - the "Tour wards" button (tour animation is gone)
 *
 * Removed props:
 * - `view` / `onViewChange`
 * - `onStartTour` / `touring`
 * - `viewReady`
 */
export function Header({
  metric,
  onMetricChange,
  slice,
  onSliceChange,
  showHerderPins,
  onToggleHerderPins,
  showReportPins,
  onToggleReportPins,
  wardCount,
  pastoralistCount,
  reportCount,
}: HeaderProps) {
  return (
    <div className="border-b border-gray-800 bg-gray-950/40">
      <div className="px-3 sm:px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Compass className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
            Live Choropleth
          </h2>
        </div>

        <div
          className="inline-flex rounded-md bg-gray-800 border border-gray-700 p-0.5"
          role="group"
          aria-label="View scope"
        >
          <button
            type="button"
            aria-pressed
            disabled
            className="px-2.5 py-1 text-[11px] font-semibold rounded bg-amber-600 text-white opacity-100 cursor-default"
            data-testid="choropleth-view-wards"
          >
            <LayersIcon className="w-3 h-3 inline mr-1" />
            Wards
          </button>
        </div>

        <SliceSlider value={slice} onChange={onSliceChange} slices={SLICE_ORDER} />

        <div
          className="inline-flex rounded-md bg-gray-800 border border-gray-700 p-0.5 flex-wrap"
          role="group"
          aria-label="Metric"
        >
          {METRIC_OPTIONS.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={metric === m.value}
              data-testid={`choropleth-metric-${m.value}`}
              onClick={() => onMetricChange(m.value)}
              className={
                "px-2.5 py-1 text-[11px] font-semibold rounded transition-colors " +
                (metric === m.value
                  ? "bg-amber-600 text-white"
                  : "text-gray-400 hover:text-gray-200")
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 sm:px-4 pb-3 flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
          Layers:
        </span>
        <LayerToggle
          label="Herder pins"
          icon={<Users className="w-3 h-3" />}
          active={showHerderPins}
          count={pastoralistCount}
          onToggle={onToggleHerderPins}
          color="emerald"
        />
        <LayerToggle
          label="Report pins"
          icon={<MapPin className="w-3 h-3" />}
          active={showReportPins}
          count={reportCount}
          onToggle={onToggleReportPins}
          color="amber"
        />
        <span className="text-[10px] text-gray-500 ml-auto">
          {wardCount > 0 && (
            <>
              <span className="font-mono">{wardCount}</span> wards ·{" "}
              <span className="font-mono">{pastoralistCount}</span> herders ·{" "}
              <span className="font-mono">{reportCount}</span> reports
            </>
          )}
        </span>
      </div>
    </div>
  );
}