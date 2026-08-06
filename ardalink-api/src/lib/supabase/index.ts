/**
 * Supabase client barrel — re-exports the full public surface of the
 * domain modules in this directory. External callers should always
 * import from here (`./supabase/index.js`), never reach into a leaf
 * module directly, so the internal split can keep evolving without
 * touching every call site.
 *
 * Split out of a single 1942-line `supabase.ts` into domain modules
 * (client/wards/satelliteIndices/pastoralists/pastoralistLeads/
 * wardCells/groundTruth/leadInteractions/whatsapp/rpc), mirroring the
 * `src/lib/llm/` barrel pattern already used in this codebase.
 */

export {
  type SupabaseMode,
  isSupabaseConfigured,
  sbFetch,
  sbGet,
  sbInsert,
  clearSupabaseCache,
} from "./client.js";

export {
  type SbWard,
  type SbWardWithGeometry,
  type SbWardNeighbor,
  type SbLatestWeather,
  type SbNeighborAdvice,
  listWards,
  listActiveWards,
  listActiveWardsWithGeometry,
  listWardNeighbors,
  bestNeighborForAdvice,
  latestWeatherFor,
  latestWeatherAll,
} from "./wards.js";

export {
  type SbLatestSatelliteIndex,
  type WardMonthlyBaseline,
  type SatelliteVciSnapshotArgs,
  latestSatelliteFor,
  fetchWardMonthlyBaseline,
  computeVci,
  countWorseThanYears,
  persistSatelliteVciSnapshot,
} from "./satelliteIndices.js";

export {
  type SbPastoralist,
  type SbCallContext,
  pastoralistByPhone,
  callContextByPhone,
  upsertPastoralist,
  markPastoralistOptedOut,
  listAllPastoralists,
  listPastoralistsFull,
  updatePastoralistById,
  deletePastoralistById,
} from "./pastoralists.js";

export {
  type SbGroundTruthCallRead,
  type SbGroundTruthCallInsert,
  insertGroundTruthCall,
  recentGroundTruthCalls,
  type SbGroundTruthCorrection,
  type SbGroundTruthCorrectionInsert,
  type CorrectableGroundTruthField,
  CORRECTABLE_GROUND_TRUTH_FIELDS,
  insertGroundTruthCorrection,
  correctionsForCallIds,
  latestCorrectionFor,
} from "./groundTruth.js";

export {
  type SbPastoralistLead,
  type SbPhoneIdentity,
  identityForPhone,
  upsertPastoralistLead,
  setLeadStatus,
  recentLeads,
} from "./pastoralistLeads.js";

export {
  type SbPeerSignal,
  type SbWaterPointGroundTruth,
  type SbWardCell,
  type SbLatestCellSatelliteIndex,
  type SbWardCellStressSummary,
  peerSignalForWard,
  recentWaterPointGroundTruth,
  listWardCells,
  latestCellIndicesForWard,
  latestCellSnapshot,
  nearestCellForCoordinates,
  wardCellStressSummary,
} from "./wardCells.js";

export {
  type SbLeadInteractionInsert,
  type SbLeadInteractionRead,
  logLeadInteraction,
  recentLeadInteractions,
} from "./leadInteractions.js";

export {
  type SbWhatsappMessageInsert,
  type SbRecentWhatsappMessage,
  logWhatsappMessage,
  hasPriorWhatsappMessages,
  recentWhatsappMessages,
} from "./whatsapp.js";

export {
  type LocationSource,
  type SbLocationHistoryRow,
  type RecordLocationChangeInput,
  type SetCurrentLocationInput,
  recordLocationChange,
  listLocationHistory,
  setCurrentLocation,
} from "./locationHistory.js";

export {
  type UpsertSatelliteIndicesArgs,
  type UpsertSatelliteCellIndicesArgs,
  type UpsertWeatherDataArgs,
  refreshSatelliteIndicesLatest,
  upsertSatelliteIndices,
  upsertSatelliteCellIndices,
  upsertWeatherData,
  rebuildWardCells,
  sbQuery,
} from "./rpc.js";
