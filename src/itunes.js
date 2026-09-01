/**
 * iTunes Search / Lookup — public preview + artwork (MUSIC CUP style).
 * Dev: proxied via Vite /api/itunes → itunes.apple.com
 * Prod: direct https://itunes.apple.com
 */

import {
  norm,
  nameScore,
  expandArtistAliases,
  buildSearchTerms,
  createTrackMatchState,
  considerTrack,
  playSourcePatchFromTrack,
  playSourceCacheKey,
} from "./itunes-match.js";
import { lookupItunesMapEntry } from "./itunes-map.js";

// Dev: Worker proxies /api/itunes → Apple (avoids browser/CN reachability issues)
// Prod: browser hits Apple Search API directly (CORS-enabled)
const ITUNES_BASE = import.meta.env.DEV ? "/api/itunes" : "https://itunes.apple.com";
/** Prefer CN storefront first (same as heipaclub) — fewer requests, faster preview resolve. */
export const COUNTRIES = ["cn", "hk", "tw"];

export function itunesArt(url, size = 600) {
  if (!url) return "";
  return String(url).replace(/\d+x\d+bb/, `${size}x${size}bb`);
}

function yearOf(track) {
  const d = track?.releaseDate;
  if (!d) return "";
  return String(d).slice(0, 4);
}

async function itunesGet(pathname, query = {}, { timeoutMs = 10000 } = {}) {
  const url = new URL(ITUNES_BASE + pathname, window.location.origin);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`iTunes ${pathname} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function pingApi() {
  try {
    const data = await itunesGet("/search", { term: "a", entity: "song", limit: 1, country: "us" }, { timeoutMs: 8000 });
    return Array.isArray(data?.results);
  } catch {
    return false;
  }
}

/**
 * Search music artists. Fast path: cn first, then hk if needed.
 */
export async function searchArtist(keyword, { limit = 8, countries = ["cn"] } = {}) {
  const want = String(keyword || "").trim();
  if (!want) return [];
  const wantNorm = norm(want);
  const isShortLatin = /^[a-z0-9.$#\-_]{1,5}$/i.test(wantNorm);
  const pooled = new Map();

  for (const country of countries) {
    try {
      const data = await itunesGet("/search", {
        term: want,
        entity: "musicArtist",
        limit,
        country,
      });
      for (const a of data?.results || []) {
        if (!a.artistId || !a.artistName) continue;
        const id = String(a.artistId);
        const score = nameScore(want, a.artistName);
        // Short latin queries like "Lu1" need looser threshold.
        const minScore = isShortLatin ? 10 : 40;
        if (score < minScore) continue;
        const prev = pooled.get(id);
        if (!prev || score > prev.score) {
          pooled.set(id, {
            id: a.artistId,
            name: a.artistName,
            avatar: "",
            score,
            country,
          });
        }
      }
      // Good enough match in this storefront — stop early
      const top = [...pooled.values()].sort((a, b) => b.score - a.score)[0];
      if (top && top.score >= 80) break;
    } catch (_) {}
  }

  return [...pooled.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function lookupSongs(artistId, country, limit = 50) {
  const data = await itunesGet("/lookup", {
    id: artistId,
    entity: "song",
    limit: Math.min(limit, 200),
    country,
  });
  return (data?.results || []).filter((r) => r.wrapperType === "track");
}

async function searchSongsByArtist(artistName, country, limit = 50) {
  const data = await itunesGet("/search", {
    term: artistName,
    entity: "song",
    attribute: "artistTerm",
    limit,
    country,
  });
  return data?.results || [];
}

function mapTrack(t, fallbackArtist = "") {
  const cover = itunesArt(t.artworkUrl100 || t.artworkUrl60 || "", 600);
  const coverSm = itunesArt(t.artworkUrl100 || t.artworkUrl60 || "", 200);
  return {
    id: String(t.trackId),
    itunesTrackId: String(t.trackId),
    itunesArtistId: t.artistId ? String(t.artistId) : "",
    title: t.trackName || "",
    artist: t.artistName || fallbackArtist,
    album: t.collectionName || "",
    collection: t.collectionName || "",
    cover,
    coverSm,
    previewUrl: t.previewUrl || "",
    trackViewUrl: t.trackViewUrl || t.collectionViewUrl || "",
    duration_ms: t.trackTimeMillis ?? null,
    year: yearOf(t),
  };
}

function dedupeTracks(tracks) {
  const byTitle = new Map();
  for (const t of tracks) {
    if (!t?.title) continue;
    const key = norm(t.title);
    const prev = byTitle.get(key);
    if (prev?.previewUrl && !t.previewUrl) continue;
    if (prev && !prev.previewUrl && t.previewUrl) {
      byTitle.set(key, t);
      continue;
    }
    if (!prev) byTitle.set(key, t);
  }
  return [...byTitle.values()];
}

function uniqueQueries(artist) {
  const raw = [artist.search, artist.name].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const variants = [r, String(r).replace(/[（(].*$/, "").trim()];
    const latin = String(r).match(/[A-Za-z][A-Za-z0-9.$#]{1,}/g) || [];
    // Only keep longer latin tokens (avoid "L" from KEY.L)
    for (const t of latin) if (t.length >= 3) variants.push(t);
    for (const v of variants) {
      const key = norm(v);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out.slice(0, 3);
}

async function songsForCandidate(cand, limit) {
  const countries = [cand.country, ...COUNTRIES.filter((c) => c !== cand.country)].slice(0, 2);
  let bestMapped = [];
  let usedCountry = cand.country;

  for (const country of countries) {
    let tracks = await lookupSongs(cand.id, country, limit);
    tracks = tracks.filter(
      (t) =>
        !t.artistId ||
        String(t.artistId) === String(cand.id) ||
        nameScore(cand.name, t.artistName) >= 60
    );

    if (tracks.length < 10) {
      const extra = await searchSongsByArtist(cand.name, country, limit);
      tracks = [
        ...tracks,
        ...extra.filter(
          (t) =>
            String(t.artistId) === String(cand.id) ||
            nameScore(cand.name, t.artistName) >= 60
        ),
      ];
    }

    const mapped = dedupeTracks(tracks.map((t) => mapTrack(t, cand.name)));
    if (mapped.length > bestMapped.length) {
      bestMapped = mapped;
      usedCountry = country;
    }
    if (mapped.filter((s) => s.previewUrl).length >= 16) break;
  }

  return { songs: bestMapped, country: usedCountry };
}

/**
 * Resolve curated roster artist → iTunes avatar + top tracks with previews.
 */
export async function loadArtistCup(catalogArtist, { limit = 50 } = {}) {
  const queries = uniqueQueries(catalogArtist);
  const pooled = new Map();

  // Search with primary name first (fast), then one alternate if needed
  for (const q of queries) {
    const hits = await searchArtist(q, { limit: 5, countries: ["cn"] });
    for (const h of hits) {
      const id = String(h.id);
      const prev = pooled.get(id);
      if (!prev || h.score > prev.score) pooled.set(id, h);
    }
    const top = [...pooled.values()].sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= 80) break;
  }

  const candidates = [...pooled.values()].sort((a, b) => b.score - a.score).slice(0, 2);
  if (!candidates.length) {
    throw new Error(`iTunes 找不到歌手：${catalogArtist.name}`);
  }

  let best = null;
  let bestSongs = [];
  let usedCountry = "cn";

  for (const cand of candidates) {
    const { songs, country } = await songsForCandidate(cand, limit);
    const previewCount = songs.filter((s) => s.previewUrl).length;
    const bestPreview = bestSongs.filter((s) => s.previewUrl).length;
    if (!best || previewCount > bestPreview || (previewCount === bestPreview && songs.length > bestSongs.length)) {
      best = cand;
      bestSongs = songs;
      usedCountry = country;
    }
    if (previewCount >= 16) break;
  }

  if (!best || !bestSongs.length) {
    throw new Error(`iTunes 未拉到歌曲：${catalogArtist.name}`);
  }

  const withPreview = bestSongs.filter((s) => s.previewUrl);
  const without = bestSongs.filter((s) => !s.previewUrl);
  const songs = [...withPreview, ...without].slice(0, limit);

  return {
    ...catalogArtist,
    itunesArtistId: best.id,
    itunesArtistName: best.name,
    itunesCountry: usedCountry,
    avatar: catalogArtist.avatar || songs.find((s) => s.cover)?.cover || "",
    songs,
  };
}

const playSourceCache = new Map();

/**
 * Match a NetEase-picked song to an iTunes track with previewUrl.
 * Conservative thresholds: prefer miss → netease over wrong Apple track.
 */
export async function resolvePlaySource(
  song,
  artistName,
  {
    countries = ["cn"],
    artistAliases = [],
    mapArtistId = "",
    bypassCache = false,
    budgetMs = 2800,
  } = {}
) {
  const title = String(song?.title || "").trim();
  if (!title) {
    return { ...song, playSource: "netease", previewUrl: song?.previewUrl || "" };
  }

  if (song?.previewUrl && song?.playSource === "itunes") {
    return { ...song };
  }

  // Static map (heipaclub style): instant Apple preview when built offline
  const rosterId = String(mapArtistId || song?.rosterArtistId || "").trim();
  const neteaseId = String(song?.neteaseId || "").trim();
  if (rosterId && neteaseId) {
    const mapped = await lookupItunesMapEntry(rosterId, neteaseId);
    if (mapped?.kind === "hit") {
      return {
        ...song,
        playSource: "itunes",
        previewUrl: mapped.previewUrl || "",
        itunesTrackId: mapped.itunesTrackId || "",
        trackViewUrl: mapped.trackViewUrl || "",
      };
    }
    if (mapped?.kind === "miss") {
      return {
        ...song,
        playSource: "netease",
        previewUrl: "",
        itunesTrackId: "",
        trackViewUrl: "",
      };
    }
  }

  const artists = expandArtistAliases(artistName, song, artistAliases);
  const cacheKey = playSourceCacheKey(artists, title);
  if (!bypassCache && playSourceCache.has(cacheKey)) {
    const hit = playSourceCache.get(cacheKey);
    return { ...song, ...hit };
  }

  const started = Date.now();
  const timedOut = () => Date.now() - started >= budgetMs;
  const state = createTrackMatchState();
  const album = String(song?.album || song?.collection || "").trim();
  const primaryArtist = artists[0] || "";
  const searchTerms = buildSearchTerms(title, artists, album);

  for (const term of searchTerms) {
    if (timedOut() || (state.best && state.bestScore >= 95)) break;
    try {
      const batches = await Promise.all(
        countries.map((country) =>
          itunesGet(
            "/search",
            { term, entity: "song", limit: 12, country },
            { timeoutMs: 3500 }
          ).catch(() => null)
        )
      );
      for (const data of batches) {
        for (const t of data?.results || []) considerTrack(state, t, title, artists);
      }
    } catch {
      /* next term */
    }
  }

  if ((!state.best || state.bestScore < 95) && !timedOut()) {
    const artistIds = [];
    if (song?.itunesArtistId) artistIds.push(String(song.itunesArtistId));
    if (!artistIds.length && primaryArtist) {
      try {
        const hits = await searchArtist(primaryArtist, {
          limit: 2,
          countries: countries.slice(0, 2),
        });
        for (const h of hits.slice(0, 1)) {
          if (h?.id) artistIds.push(String(h.id));
        }
      } catch {
        /* skip */
      }
    }
    const id = artistIds[0];
    if (id && !timedOut()) {
      for (const country of countries) {
        if (timedOut() || (state.best && state.bestScore >= 95)) break;
        try {
          const tracks = await lookupSongs(id, country, 60);
          for (const t of tracks) considerTrack(state, t, title, artists, 70);
        } catch {
          /* skip */
        }
      }
    }
  }

  const full = playSourcePatchFromTrack(state.best);
  const patch = {
    playSource: full.playSource,
    previewUrl: full.previewUrl,
    itunesTrackId: full.itunesTrackId,
    trackViewUrl: full.trackViewUrl,
  };
  playSourceCache.set(cacheKey, patch);
  return { ...song, ...patch };
}

export async function enrichSongsPlaySource(
  songs,
  artistName,
  { concurrency = 5, artistAliases = [], mapArtistId = "" } = {}
) {
  const list = Array.isArray(songs) ? songs : [];
  if (!list.length) return [];
  const out = list.map((s) => ({ ...s }));
  let cursor = 0;
  const workers = Math.min(Math.max(1, concurrency), list.length);

  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      const resolved = await resolvePlaySource(list[idx], artistName, { artistAliases, mapArtistId });
      Object.assign(out[idx], {
        playSource: resolved.playSource,
        previewUrl: resolved.previewUrl || "",
        itunesTrackId: resolved.itunesTrackId || "",
        trackViewUrl: resolved.trackViewUrl || "",
      });
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

/**
 * Enrich first `readyCount` songs (enough to start), return immediately,
 * keep matching the rest in `background` (mutates song objects + onSong).
 */
export async function enrichSongsPlaySourceProgressive(
  songs,
  artistName,
  {
    concurrency = 2,
    artistAliases = [],
    mapArtistId = "",
    readyCount = 4,
    onSong = null,
  } = {}
) {
  const list = Array.isArray(songs) ? songs : [];
  const out = list.map((s) => ({ ...s, playSource: s.playSource || null }));
  if (!list.length) {
    return { songs: out, background: Promise.resolve(out) };
  }

  async function enrichIndex(idx) {
    const resolved = await resolvePlaySource(list[idx], artistName, { artistAliases, mapArtistId });
    Object.assign(out[idx], {
      playSource: resolved.playSource,
      previewUrl: resolved.previewUrl || "",
      itunesTrackId: resolved.itunesTrackId || "",
      trackViewUrl: resolved.trackViewUrl || "",
    });
    onSong?.(out[idx], idx);
    return out[idx];
  }

  async function runRange(start, end) {
    let cursor = start;
    const n = Math.max(0, end - start);
    if (!n) return;
    const workers = Math.min(Math.max(1, concurrency), n);
    async function worker() {
      while (cursor < end) {
        const idx = cursor++;
        await enrichIndex(idx);
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  const first = Math.min(Math.max(0, readyCount), list.length);
  await runRange(0, first);

  const background = runRange(first, list.length).then(() => out);
  return { songs: out, background };
}
