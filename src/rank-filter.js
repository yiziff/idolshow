/**
 * Client-side rank filters: 团体 / 个人 via roster kind.
 */
import { ARTISTS } from "./data/artists.js";

export const KIND_FILTERS = [
  { id: "all", label: "全部" },
  { id: "group", label: "团体" },
  { id: "solo", label: "个人" },
];

/** @deprecated alias for home-view migration */
export const GENERATION_FILTERS = KIND_FILTERS;

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._#()（）[\]【】]/g, "");
}

let _maps = null;
function rosterMaps() {
  if (_maps) return _maps;
  const byItunesId = new Map();
  const byName = new Map();
  const byRosterId = new Map();
  for (const a of ARTISTS) {
    const kind = a.kind || "all";
    if (a.itunesArtistId) byItunesId.set(String(a.itunesArtistId), kind);
    if (a.id) byRosterId.set(String(a.id), kind);
    const keys = [a.name, a.search, a.id].map(norm).filter(Boolean);
    for (const k of keys) {
      if (!byName.has(k)) byName.set(k, kind);
    }
  }
  _maps = { byItunesId, byName, byRosterId };
  return _maps;
}

export function artistKindOf({ artistId, name, rosterId } = {}) {
  const { byItunesId, byName, byRosterId } = rosterMaps();
  const rid = String(rosterId || "").trim();
  if (rid && byRosterId.has(rid)) return byRosterId.get(rid);
  const id = String(artistId || "").trim();
  if (id && byItunesId.has(id)) return byItunesId.get(id);
  const n = norm(name);
  if (n && byName.has(n)) return byName.has(n) ? byName.get(n) : "all";
  return "all";
}

export function filterRankItemsByKind(items, kindFilter, kind) {
  const mode = kindFilter === "all" ? "all" : kindFilter;
  if (mode === "all") return items || [];
  return (items || []).filter((item) => {
    if (kind === "songs") {
      return artistKindOf({ artistId: item.artistId, name: item.artist }) === mode;
    }
    return artistKindOf({ artistId: item.artistId, name: item.name, rosterId: item.rosterArtistId }) === mode;
  });
}

/** @deprecated use filterRankItemsByKind */
export function filterRankItemsByGeneration(items, generation, kind) {
  return filterRankItemsByKind(items, generation, kind);
}

export function filterRankItemsByQuery(items, q = "", kind = "songs") {
  const needle = norm(q);
  if (!needle) return items || [];
  return (items || []).filter((item) => {
    if (kind === "songs") {
      return (
        norm(item.title).includes(needle) ||
        norm(item.artist).includes(needle) ||
        norm(item.songId).includes(needle)
      );
    }
    return norm(item.name).includes(needle) || norm(item.artistId).includes(needle);
  });
}

export function kindFilterMeta(id) {
  return KIND_FILTERS.find((f) => f.id === id) || KIND_FILTERS[0];
}

/** @deprecated use kindFilterMeta */
export function generationFilterMeta(id) {
  return kindFilterMeta(id);
}

export function filterArtistsByKind(artists, kind = "all") {
  if (!kind || kind === "all") return [...(artists || [])];
  return (artists || []).filter((a) => String(a.kind || "") === kind);
}

/** @deprecated use filterArtistsByKind */
export function filterArtistsByGeneration(artists, generation = "all") {
  return filterArtistsByKind(artists, generation);
}
