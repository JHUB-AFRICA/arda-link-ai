/**
 * Herder identification + localization barrel — re-exports the public
 * surface every other channel uses. External callers should always
 * import from here (`./herderContext/index.js`), never reach into a
 * leaf module directly.
 *
 * Only 4 symbols cross this module's boundary: `resolveHerderContext`,
 * `buildLocalizedBrief`, `buildLocalizedVoiceOpener`, and the
 * `HerderContext` type. Everything else (overlays, local-mirror
 * fallback, base-context construction) is an internal implementation
 * detail free to reshape without touching a caller.
 *
 * Split out of a single 920-line `herderContext.ts`, mirroring the
 * `src/lib/llm/` barrel pattern already used in this codebase.
 * Internal submodules import Supabase symbols from the `../supabase/`
 * barrel, never a leaf module, so this split and the supabase.ts split
 * are fully decoupled from each other.
 */

export type { HerderContext } from "./types.js";
export { resolveHerderContext } from "./resolve.js";
export { buildLocalizedBrief, buildLocalizedVoiceOpener } from "./briefs.js";
