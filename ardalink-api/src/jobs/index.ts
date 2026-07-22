/**
 * Jobs registry — all scheduled background jobs.
 *
 * Jobs are started from src/index.ts on server boot and can be
 * controlled via the exported start/stop functions.
 */

export {
  runSatelliteJob,
  startSatelliteJob,
  stopSatelliteJob,
  isSatelliteJobEnabled,
  getScheduleDescription,
} from "./satelliteJob.js";

export {
  runForecastJob,
  startForecastJob,
  stopForecastJob,
  isForecastJobEnabled,
} from "./forecastJob.js";

export {
  runVciBackfill,
  startVciBackfillJob,
  stopVciBackfillJob,
  isVciBackfillJobEnabled,
  type BackfillResult,
  type RunVciBackfillOptions,
} from "./vciBackfillJob.js";

export {
  runHeartbeat,
  startHeartbeatJob,
  stopHeartbeatJob,
  isHeartbeatJobEnabled,
  getLastHeartbeat,
  DEFAULT_CHECKS,
  type HeartbeatSnapshot,
  type TableHeartbeat,
  type TableCheck,
  type TableStatus,
  type PipelineStatus,
  type Role,
} from "./heartbeatJob.js";
