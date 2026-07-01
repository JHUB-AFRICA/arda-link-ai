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
