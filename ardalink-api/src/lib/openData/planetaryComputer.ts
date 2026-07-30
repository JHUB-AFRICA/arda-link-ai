/**
 * Microsoft Planetary Computer STAC discovery — free, key-less
 * catalog search over Sentinel-2 L2A, MODIS MOD13Q1, JRC GSW, SMAP,
 * CHIRPS. Discovery only; asset signing is a separate step using the
 * collection-level SAS token endpoint.
 */

export const PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";

export type PlanetaryComputerCollection =
  | "sentinel-2-l2a"
  | "modis-13Q1-061"
  | "jrc-gsw"
  | "smap-msl"
  | "chirps-daygrid-001";

export interface StacItemSummary {
  id: string;
  collection: PlanetaryComputerCollection;
  datetime: string | null;
  cloudCover: number | null;
  bbox: [number, number, number, number] | null;
  assets: string[];
}

/**
 * Search Microsoft Planetary Computer for satellite scenes over the
 * given bbox + date range. Returns a normalised list of items (no
 * asset downloads — discovery only). Asset signing would be a separate
 * step using the collection-level SAS token from
 * https://planetarycomputer.microsoft.com/api/sas/v1/token/<collection>.
 */
export async function discoverPlanetaryComputer(
  collection: PlanetaryComputerCollection,
  bbox: [number, number, number, number],
  startDate: string,
  endDate: string,
  options: { maxCloudCoverPct?: number; limit?: number } = {},
): Promise<{ collection: PlanetaryComputerCollection; count: number; items: StacItemSummary[]; license: string }> {
  const { maxCloudCoverPct, limit = 10 } = options;

  const body: Record<string, unknown> = {
    collections: [collection],
    bbox,
    datetime: `${startDate}/${endDate}`,
    limit,
  };
  if (collection === "sentinel-2-l2a" && maxCloudCoverPct !== undefined) {
    body["query"] = { "eo:cloud_cover": { lt: maxCloudCoverPct } };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(PC_STAC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Planetary Computer ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    features: Array<{
      id: string;
      collection: string;
      properties: Record<string, unknown>;
      bbox?: [number, number, number, number];
      assets: Record<string, unknown>;
    }>;
  };

  const items: StacItemSummary[] = data.features.map((f) => {
    const cloud = f.properties["eo:cloud_cover"];
    return {
      id: f.id,
      collection: collection,
      datetime: (f.properties["datetime"] as string | null) ?? null,
      cloudCover: typeof cloud === "number" ? cloud : null,
      bbox: f.bbox ?? null,
      assets: Object.keys(f.assets),
    };
  });

  return {
    collection,
    count: items.length,
    items,
    license: "Microsoft Planetary Computer — various open licenses (CC-BY, CC0, etc.) per collection",
  };
}

/**
 * Discovery batch for the ward — useful for an "available satellite
 * scenes" widget on the dashboard.
 */
export async function discoverAllForWard(
  bbox: [number, number, number, number],
  lookbackDays = 60,
): Promise<
  Record<
    PlanetaryComputerCollection,
    { count: number; items: StacItemSummary[]; license: string }
  >
> {
  const endDate = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startDate = start.toISOString().slice(0, 10);

  const collections: PlanetaryComputerCollection[] = [
    "sentinel-2-l2a",
    "modis-13Q1-061",
    "jrc-gsw",
  ];
  const results = await Promise.all(
    collections.map((c) =>
      discoverPlanetaryComputer(c, bbox, startDate, endDate, {
        maxCloudCoverPct: c === "sentinel-2-l2a" ? 30 : undefined,
        limit: 5,
      }),
    ),
  );
  const out = {} as Record<
    PlanetaryComputerCollection,
    { count: number; items: StacItemSummary[]; license: string }
  >;
  for (const r of results) {
    out[r.collection] = {
      count: r.count,
      items: r.items,
      license: r.license,
    };
  }
  return out;
}
