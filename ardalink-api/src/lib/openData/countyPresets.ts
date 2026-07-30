/**
 * Counties the choropleth is allowed to render. We deliberately do NOT
 * render all 48 — that produces a "huge, unreadable" map. The dashboard
 * presents two groups:
 *
 *   - **Pastoral demo** — always visible, always-on the map. Every
 *     demo tenant lives in one of these counties. (Bula Pesa, Garbatulla
 *     and Kinna are wards of Isiolo County, and the Merti Sub-County
 *     operator tenant sits here too, so for the demo we surface Isiolo
 *     as the home county.)
 *   - **Main reference** — selectable. The operator toggles these
 *     to set the comparison set. Nairobi is the canonical urban
 *     reference; Mombasa / Kisumu / Nakuru / Eldoret / Kakamega round
 *     out a representative cross-section of Kenya's diverse climates.
 */
export interface CountyPreset {
  name: string;
  displayName: string;
  group: "pastoral" | "main";
  /** Short rationale shown in the UI. */
  why: string;
}

export const COUNTY_PRESETS: CountyPreset[] = [
  { name: "ISIOLO", displayName: "Isiolo", group: "pastoral",
    why: "Bula Pesa · Garbatulla · Kinna wards + Merti Sub-County operator — all live here." },
  { name: "NAIROBI", displayName: "Nairobi", group: "main",
    why: "Urban reference (cool, green, high livestock density)." },
  { name: "MOMBASA", displayName: "Mombasa", group: "main",
    why: "Coastal — wetter climate, contrast for pastoral drylands." },
  { name: "KISUMU", displayName: "Kisumu", group: "main",
    why: "Lake Victoria basin — humid, intense rainfall." },
  { name: "NAKURU", displayName: "Nakuru", group: "main",
    why: "Rift Valley — mixed agro-pastoral, key transit county." },
  { name: "ELDORET", displayName: "Eldoret (Uasin Gishu)", group: "main",
    why: "Uasin Gishu — highland maize belt, contrast altitude." },
  { name: "KAKAMEGA", displayName: "Kakamega", group: "main",
    why: "Western — high rainfall, dense smallholder farming." },
  { name: "MARSABIT", displayName: "Marsabit", group: "main",
    why: "Pastoral neighbour to Isiolo — direct comparator." },
  { name: "SAMBURU", displayName: "Samburu", group: "main",
    why: "Pastoral neighbour to Isiolo — direct comparator." },
  { name: "LAIKIPIA", displayName: "Laikipia", group: "main",
    why: "Pastoral rangeland north of the equator — direct comparator." },
];

export const DEFAULT_MAIN_COUNTIES: string[] = [
  "NAIROBI", "MARSABIT", "SAMBURU",
];
