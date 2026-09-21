/** Time-slice presets shared by the county-insights dashboard panels. */

export type TimeSlice =
  | "live" // last 24h
  | "7d"
  | "30d"
  | "90d"
  | "1y"
  | "all";

export const TIME_SLICE_LABELS: Record<TimeSlice, string> = {
  live: "Live (24h)",
  "7d": "Past 7 days",
  "30d": "Past 30 days",
  "90d": "Past 90 days",
  "1y": "Past year",
  all: "All time",
};

export function timeSliceStart(slice: TimeSlice): Date | null {
  const now = Date.now();
  switch (slice) {
    case "live":
      return new Date(now - 24 * 60 * 60 * 1000);
    case "7d":
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case "90d":
      return new Date(now - 90 * 24 * 60 * 60 * 1000);
    case "1y":
      return new Date(now - 365 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
  }
}
