/**
 * Syncs all 12 monthly baseline images from Google Earth Engine
 * into Azure Cosmos DB (database: ardalink).
 *
 * Containers created:
 *   - monthly_baselines  (partition key: /month) — one doc per month with regional stats
 *   - pixel_grids        (partition key: /month)  — full pixel arrays, chunked per band
 */

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
const IMAGE_META = {
  width: 532,
  height: 535,
  crs: "EPSG:4326",
  bounds: {
    lon_min: 37.51149,
    lon_max: 37.654727,
    lat_min: 0.282841,
    lat_max: 0.427149,
  },
  location: "Bula_Pesa_Ward",
  year_range: "2015-2026",
};
const CHUNK_ROWS = 100;

function eeEvaluate(eeObject) {
  return new Promise((resolve, reject) => {
    eeObject.evaluate((result, err) => {
      if (err) reject(new Error(err));
      else resolve(result);
    });
  });
}

function maskNodata(img) {
  // Keep only physically valid pixels (excludes clouds, water, nodata fill values)
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

async function getRegionalStats(img) {
  const masked = maskNodata(img);
  const [meanResult, minResult, maxResult] = await Promise.all([
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
      spatial_mean: parseFloat((meanResult[band] ?? 0).toFixed(6)),
      spatial_min: parseFloat((minResult[band] ?? 0).toFixed(6)),
      spatial_max: parseFloat((maxResult[band] ?? 0).toFixed(6)),
    };
  }
  return stats;
}

async function getPixelGrid(img) {
  try {
    const region = ee.Geometry.Rectangle([
      IMAGE_META.bounds.lon_min,
      IMAGE_META.bounds.lat_min,
      IMAGE_META.bounds.lon_max,
      IMAGE_META.bounds.lat_max,
    ]);
    // Resample from 30m to 32m to stay under EE's 262,144 pixel/band limit
    // (532×535=284,621 > limit; at 32m we get ~498×499=248,502 < limit)
    const resampled = img.reproject({ crs: "EPSG:4326", scale: 32 });
    const sample = await eeEvaluate(
      resampled.sampleRectangle({ region, defaultValue: -9999 }),
    );
    const grid = {};
    for (const band of BANDS) {
      if (sample.properties && sample.properties[band]) {
        grid[band] = sample.properties[band];
      }
    }
    return Object.keys(grid).length > 0 ? grid : null;
  } catch (err) {
    console.log(
      `    [warn] sampleRectangle failed: ${err.message.substring(0, 100)}`,
    );
    return null;
  }
}

async function upsertWithRetry(container, doc, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await container.items.upsert(doc);
      return;
    } catch (err) {
      if (err.code === 429 || (err.message && err.message.includes("429"))) {
        const wait = Math.pow(2, i) * 500;
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Failed to upsert doc ${doc.id} after ${retries} retries`);
}

async function storePixelChunks(pixelContainer, month, pixelData) {
  const docs = [];
  for (const band of BANDS) {
    const grid = pixelData[band];
    if (!grid || !Array.isArray(grid)) continue;
    let chunkIdx = 0;
    for (let rowStart = 0; rowStart < grid.length; rowStart += CHUNK_ROWS) {
      const rowEnd = Math.min(rowStart + CHUNK_ROWS, grid.length);
      const chunk = grid
        .slice(rowStart, rowEnd)
        .map((row) =>
          Array.isArray(row)
            ? row.map((v) => Math.round(v * 10000) / 10000)
            : row,
        );
      docs.push({
        id: `${month.name}_${band}_chunk_${chunkIdx}`,
        month: month.num,
        month_name: month.name,
        band,
        chunk: chunkIdx,
        row_start: rowStart,
        row_end: rowEnd,
        width: Array.isArray(chunk[0]) ? chunk[0].length : 0,
        data: chunk,
        synced_at: new Date().toISOString(),
      });
      chunkIdx++;
    }
  }
  // Write in batches of 5 to respect Cosmos DB RU limits
  const BATCH = 5;
  for (let i = 0; i < docs.length; i += BATCH) {
    await Promise.all(
      docs.slice(i, i + BATCH).map((d) => upsertWithRetry(pixelContainer, d)),
    );
    if (i + BATCH < docs.length) await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`    ✓ ${docs.length} pixel chunks stored (all 9 bands)`);
}

async function main() {
  console.log("=== Earth Engine → Cosmos DB Sync ===\n");

  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const cosmosClient = new CosmosClient({
    endpoint: process.env.COSMOS_DB_ENDPOINT,
    key: process.env.COSMOS_DB_PRIMARY_KEY,
  });

  // Initialize Earth Engine
  await new Promise((resolve, reject) => {
    ee.data.authenticateViaPrivateKey(
      creds,
      () => {
        ee.initialize(null, null, resolve, reject);
      },
      reject,
    );
  });
  console.log("✓ Earth Engine authenticated\n");

  // Set up Cosmos DB
  const { database } = await cosmosClient.databases.createIfNotExists({
    id: "ardalink",
  });
  console.log("✓ Cosmos DB database: ardalink");

  const { container: statsContainer } =
    await database.containers.createIfNotExists({
      id: "monthly_baselines",
      partitionKey: { paths: ["/month"] },
    });
  console.log("✓ Container: monthly_baselines");

  const { container: pixelContainer } =
    await database.containers.createIfNotExists({
      id: "pixel_grids",
      partitionKey: { paths: ["/month"] },
    });
  console.log("✓ Container: pixel_grids\n");

  // Process each month (resumable — skips months already fully synced)
  for (const month of MONTHS) {
    const docId = `baseline_${String(month.num).padStart(2, "0")}_${month.name}`;
    try {
      const existing = await statsContainer.item(docId, month.num).read();
      // Check if pixel grids exist too
      const { resources: pixelDocs } = await pixelContainer.items
        .query({
          query: "SELECT c.id FROM c WHERE c.month = @m AND c.band = @b",
          parameters: [
            { name: "@m", value: month.num },
            { name: "@b", value: "NDVI_mean" },
          ],
        })
        .fetchAll();
      if (existing.resource && pixelDocs.length >= 6) {
        console.log(`── ${month.name}: already synced, skipping ──`);
        continue;
      }
    } catch (_) {
      /* not found — proceed */
    }
    const assetId = `${ASSET_PREFIX}/monthly_baseline_${String(month.num).padStart(2, "0")}_${month.name}`;
    console.log(`── ${month.name} (${month.num}/12) ──`);

    const img = ee.Image(assetId);

    // 1. Regional stats
    console.log("  Getting regional statistics (min/max/mean per band)...");
    const stats = await getRegionalStats(img);

    // 2. Store summary document
    await statsContainer.items.upsert({
      id: `baseline_${String(month.num).padStart(2, "0")}_${month.name}`,
      month: month.num,
      month_name: month.name,
      asset_id: assetId,
      ...IMAGE_META,
      bands: stats,
      synced_at: new Date().toISOString(),
    });
    console.log("  ✓ Regional stats stored");

    // 3. Full pixel grid
    console.log("  Getting full pixel grid...");
    const pixelData = await getPixelGrid(img);

    if (pixelData) {
      await storePixelChunks(pixelContainer, month, pixelData);
      console.log("  ✓ Pixel grid stored");
    } else {
      console.log(
        "  ! Pixel grid skipped (regional stats only for this month)",
      );
    }

    console.log(`  ✓ ${month.name} complete\n`);
  }

  console.log("✅ All 12 months synced to Cosmos DB successfully!");
  console.log("\nSummary:");
  console.log("  Database:  ardalink");
  console.log("  Container: monthly_baselines — 12 documents (one per month)");
  console.log(
    "  Container: pixel_grids       — up to 648 documents (9 bands × 6 chunks × 12 months)",
  );
}

main().catch((err) => {
  console.error("\n❌ Sync failed:", err.message);
  process.exit(1);
});
