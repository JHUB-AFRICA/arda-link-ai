"use strict";

const ee = require("@google/earthengine");
const { CosmosClient } = require("@azure/cosmos");

const MONTHS = [
  { num: 1, name: "JAN" },
  { num: 2, name: "FEB" },
  { num: 3, name: "MAR" },
  { num: 4, name: "APR" },
  { num: 5, name: "MAY" },
  { num: 6, name: "JUN" },
  { num: 7, name: "JUL" },
  { num: 8, name: "AUG" },
  { num: 9, name: "SEP" },
  { num: 10, name: "OCT" },
  { num: 11, name: "NOV" },
  { num: 12, name: "DEC" },
];

const BANDS = [
  "NDVI_min",
  "NDVI_max",
  "NDVI_mean",
  "NDRE_min",
  "NDRE_max",
  "NDRE_mean",
  "RED_EDGE_min",
  "RED_EDGE_max",
  "RED_EDGE_mean",
];

const ASSET_PREFIX = "projects/ardalink-ai/assets/ardalink";

function eeEvaluate(obj) {
  return new Promise((resolve, reject) =>
    obj.evaluate((r, e) => (e ? reject(new Error(e)) : resolve(r))),
  );
}

function maskNodata(img) {
  const mask = img
    .select("NDVI_mean")
    .gte(-1.5)
    .and(img.select("NDVI_mean").lte(1.5))
    .and(img.select("NDRE_mean").gte(-1.5))
    .and(img.select("NDRE_mean").lte(1.5))
    .and(img.select("RED_EDGE_mean").gte(0))
    .and(img.select("RED_EDGE_mean").lte(1));
  return img.updateMask(mask);
}

async function getStats(img) {
  const masked = maskNodata(img);
  const [mean, min, max] = await Promise.all([
    eeEvaluate(
      masked.reduceRegion({
        reducer: ee.Reducer.mean(),
        bestEffort: true,
        maxPixels: 1e9,
      }),
    ),
    eeEvaluate(
      masked.reduceRegion({
        reducer: ee.Reducer.min(),
        bestEffort: true,
        maxPixels: 1e9,
      }),
    ),
    eeEvaluate(
      masked.reduceRegion({
        reducer: ee.Reducer.max(),
        bestEffort: true,
        maxPixels: 1e9,
      }),
    ),
  ]);
  const stats = {};
  for (const band of BANDS) {
    stats[band] = {
      spatial_mean: parseFloat((mean[band] ?? 0).toFixed(6)),
      spatial_min: parseFloat((min[band] ?? 0).toFixed(6)),
      spatial_max: parseFloat((max[band] ?? 0).toFixed(6)),
    };
  }
  return stats;
}

async function main() {
  console.log("=== Fixing masked regional stats for all 12 months ===\n");
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const cosmos = new CosmosClient({
    endpoint: process.env.COSMOS_DB_ENDPOINT,
    key: process.env.COSMOS_DB_PRIMARY_KEY,
  });

  await new Promise((resolve, reject) =>
    ee.data.authenticateViaPrivateKey(
      creds,
      () => ee.initialize(null, null, resolve, reject),
      reject,
    ),
  );
  console.log("✓ Earth Engine ready\n");

  const container = cosmos.database("ardalink").container("monthly_baselines");

  for (const month of MONTHS) {
    const assetId = `${ASSET_PREFIX}/monthly_baseline_${String(month.num).padStart(2, "0")}_${month.name}`;
    console.log(`Updating ${month.name}...`);
    const stats = await getStats(ee.Image(assetId));
    const { resource: existing } = await container
      .item(
        `baseline_${String(month.num).padStart(2, "0")}_${month.name}`,
        month.num,
      )
      .read();
    await container.items.upsert({
      ...existing,
      bands: stats,
      stats_fixed_at: new Date().toISOString(),
    });

    // Print sample for verification
    console.log(
      `  NDVI_mean → spatial_mean: ${stats.NDVI_mean.spatial_mean}, min: ${stats.NDVI_mean.spatial_min}, max: ${stats.NDVI_mean.spatial_max}`,
    );
    console.log(`  ✓ ${month.name} updated\n`);
  }

  console.log("✅ All 12 months corrected with masked stats!");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
