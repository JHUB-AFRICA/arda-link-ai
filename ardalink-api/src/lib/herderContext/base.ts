import { getLastResult } from "../intelligence.js";
import { wardIdForTenant } from "../wardMapping.js";
import type { HerderContext } from "./types.js";

export const DEFAULT_TENANT_ID =
  process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

export function canonicalize(phone: string): string {
  const trimmed = phone.replace(/\s+/g, "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("00")) return "+" + trimmed.slice(2);
  if (trimmed.startsWith("0")) return "+254" + trimmed.slice(1);
  if (/^\d+$/.test(trimmed)) return "+" + trimmed;
  return trimmed;
}

export function baseContext(rawPhone: string, tenantId: string): HerderContext {
  const canonicalPhone = canonicalize(rawPhone);
  const ward = getLastResult();
  const wardId = wardIdForTenant(tenantId);
  return {
    known: false,
    tier: "unknown",
    source: "none",
    phone: rawPhone,
    canonicalPhone,
    pastoralistId: null,
    name: null,
    location: null,
    preferredLanguage: null,
    herdSize: null,
    cattle: null,
    goats: null,
    camels: null,
    waterSource: null,
    lastContactAt: null,
    lastBcsScore: null,
    lastBcsSpecies: null,
    lastActionTag: null,
    lastReportedLocation: null,
    lastReportedQuadrant: null,
    lastReportAt: null,
    wardId,
    wardName: null,
    wardMonth: ward?.month_name ?? null,
    wardStressedPct: ward?.live?.anomaly?.wardStressedPixelPct ?? null,
    wardNdviPct: ward?.delta?.NDVI?.delta_pct ?? null,
    wardNdviMean: null,
    wardVci: null,
    wardRainfall30dMm: ward?.climate?.rolling30Day?.totalPrecipMm ?? null,
    wardTemperatureC: null,
    wardHumidityPct: null,
    wardEt0Mm: ward?.climate?.rolling30Day?.totalET0Mm ?? null,
    wardDroughtSeverity: ward?.climate?.rolling30Day?.droughtSeverity ?? null,
    wardRiskLevel: ward?.forecast?.outlook.riskLevel ?? null,
    wardRecommendation: ward?.forecast?.outlook.recommendation ?? null,
    neighborWardName: null,
    neighborNdviMean: null,
    neighborNdviDelta: null,
    nearestWaterPointName: null,
    nearestWaterPointDistanceKm: null,
    nearestWaterPointStatus: null,
    peerCallerCount: null,
    peerThinAnimalsCount: null,
    peerBrokenWaterCount: null,
    peerWindowDays: null,
    baselineMonth: null,
    baselineYears: null,
    ndviBaselineP50: null,
    ndviBaselineP5: null,
    ndviBaselineP95: null,
    vciDerived: null,
    worseThanYears: null,
    driestYearOnRecord: null,
    wardCellCount: null,
    wardStressedCellCount: null,
    wardCellNdviMedian: null,
    nearestCellId: null,
    nearestCellNdvi: null,
    nearestCellAnomaly: null,
  };
}
