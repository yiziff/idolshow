/**
 * Static NetEase→iTunes play-source map (built offline by scripts/build-itunes-map.mjs).
 * Loaded on demand via Vite glob so unused artist shards stay out of the main chunk.
 */

import index from "./data/itunes-map/index.json";

const loaders = import.meta.glob([
  "./data/itunes-map/*.json",
  "!./data/itunes-map/index.json",
]);

const packCache = new Map();

export function hasItunesMap(artistId) {
  return Boolean(index?.artists?.[artistId]);
}

/**
 * @returns {Promise<null | {
 *   artistId: string,
 *   itunesArtistId?: string,
 *   updatedAt?: string,
 *   byNeteaseId: Record<string, object>,
 *   missNeteaseIds: string[],
 * }>}
 */
export async function loadItunesMap(artistId) {
  const id = String(artistId || "");
  if (!id) return null;
  if (packCache.has(id)) return packCache.get(id);

  const fileId = index?.artists?.[id];
  if (!fileId) {
    packCache.set(id, null);
    return null;
  }
  const key = `./data/itunes-map/${fileId}.json`;
  const loader = loaders[key];
  if (!loader) {
    packCache.set(id, null);
    return null;
  }
  const mod = await loader();
  const pack = mod?.default || mod;
  if (!pack?.byNeteaseId && !pack?.missNeteaseIds) {
    packCache.set(id, null);
    return null;
  }
  packCache.set(id, pack);
  return pack;
}

/**
 * @returns {Promise<null | { kind: "hit", previewUrl: string, itunesTrackId: string, trackViewUrl: string } | { kind: "miss" }>}
 */
export async function lookupItunesMapEntry(artistId, neteaseId) {
  const pack = await loadItunesMap(artistId);
  if (!pack) return null;
  const nid = String(neteaseId || "");
  if (!nid) return null;
  const hit = pack.byNeteaseId?.[nid];
  if (hit?.playSource === "itunes" && hit.previewUrl) {
    return {
      kind: "hit",
      previewUrl: hit.previewUrl || "",
      itunesTrackId: String(hit.itunesTrackId || ""),
      trackViewUrl: hit.trackViewUrl || "",
    };
  }
  const misses = pack.missNeteaseIds;
  if (Array.isArray(misses) && misses.includes(nid)) {
    return { kind: "miss" };
  }
  // Also treat explicit netease entries in byNeteaseId as miss
  if (hit?.playSource === "netease") {
    return { kind: "miss" };
  }
  return null;
}
