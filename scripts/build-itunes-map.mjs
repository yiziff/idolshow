/**
 * Build offline NetEase → iTunes play-source map for full roster × Top50.
 *
 * Usage:
 *   NETEASE_API=http://127.0.0.1:3000 npm run itunes:map
 *
 * Env:
 *   NETEASE_API          api-enhanced origin (default http://127.0.0.1:3000)
 *   ITUNES_MAP_LIMIT     songs per artist (default 50)
 *   ITUNES_MAP_CONCURRENCY artists in parallel (default 2)
 *   ITUNES_MAP_SONG_CONCURRENCY songs in parallel per artist (default 3)
 *   ITUNES_MAP_FORCE=1   rebuild even if shard exists
 *   ITUNES_MAP_ONLY=id1,id2  only these roster ids
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";
import {
  expandArtistAliases,
  buildSearchTerms,
  createTrackMatchState,
  considerTrack,
  playSourcePatchFromTrack,
  nameScore,
  norm,
} from "../src/itunes-match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "src/data/itunes-map");
const HOT_DIR = path.join(ROOT, "src/data/hot-tops");
const API = process.env.NETEASE_API || "http://127.0.0.1:3000";
const ITUNES = "https://itunes.apple.com";
const LIMIT = Number(process.env.ITUNES_MAP_LIMIT || 50);
const ARTIST_CONCURRENCY = Number(process.env.ITUNES_MAP_CONCURRENCY || 1);
const SONG_CONCURRENCY = Number(process.env.ITUNES_MAP_SONG_CONCURRENCY || 1);
const FORCE = process.env.ITUNES_MAP_FORCE === "1";
const ONLY = new Set(
  String(process.env.ITUNES_MAP_ONLY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const COUNTRIES = ["cn"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Start gentle to avoid Apple IP bans; shrinks slowly on success, grows on 429
let itunesBackoffMs = Number(process.env.ITUNES_MAP_DELAY_MS || 900);

function safeFileId(id) {
  return String(id || "")
    .replace(/[^\w\u4e00-\u9fff.-]+/g, "_")
    .slice(0, 80);
}

function hiRes(url, size = 500) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function titleDedupeKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s*[\(（][^）)]*[\)）]\s*/g, " ")
    .replace(/\s*(?:feat\.?|ft\.?|with)\s+.+$/i, "")
    .replace(/\s+/g, "")
    .replace(/[·．._\-#（）()']/g, "")
    .trim();
}

function dedupeByTitleKeepHotter(songs) {
  const seen = new Set();
  const out = [];
  for (const s of songs) {
    const key = titleDedupeKey(s.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function publishYear(ms) {
  const n = Number(ms);
  if (!n || n < 1e11) return "";
  try {
    return String(new Date(n).getFullYear());
  } catch {
    return "";
  }
}

async function netease(pathname, query = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 405 || res.status === 429 || res.status === 503) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${pathname} unavailable`);
}

async function itunesGet(pathname, query = {}, { timeoutMs = 15000 } = {}) {
  const url = new URL(ITUNES + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await sleep(itunesBackoffMs);
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 403 || res.status === 429) {
        itunesBackoffMs = Math.min(20000, Math.max(4000, itunesBackoffMs * 2));
        console.warn(`  iTunes ${res.status}, backoff ${itunesBackoffMs}ms`);
        await sleep(itunesBackoffMs);
        continue;
      }
      if (!res.ok) throw new Error(`iTunes ${pathname} HTTP ${res.status}`);
      const text = await res.text();
      if (!text) {
        itunesBackoffMs = Math.min(12000, itunesBackoffMs + 400);
        await sleep(itunesBackoffMs);
        continue;
      }
      itunesBackoffMs = Math.max(700, Math.floor(itunesBackoffMs * 0.95));
      return JSON.parse(text);
    } catch (e) {
      if (attempt === 7) throw e;
      await sleep(800 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`iTunes ${pathname} unavailable`);
}

async function fetchTopSongs(artistId) {
  const data = await netease("/artist/top/song", { id: artistId });
  const songs = data?.songs || data?.hotSongs || [];
  const mapped = songs.map((s) => {
    const pic = s.al?.picUrl || "";
    const publishMs = Number(s.publishTime || s.al?.publishTime || 0) || 0;
    return {
      id: String(s.id),
      neteaseId: String(s.id),
      title: s.name,
      artist: (s.ar || []).map((x) => x.name).join(", "),
      album: s.al?.name || "",
      collection: s.al?.name || "",
      cover: hiRes(pic, 500),
      coverSm: hiRes(pic, 200),
      duration_ms: s.dt ?? null,
      year: publishYear(publishMs),
      publishTime: publishMs || null,
    };
  });
  return dedupeByTitleKeepHotter(mapped).slice(0, LIMIT);
}

function loadHotTopSongs(artist) {
  const fileId = safeFileId(artist.id);
  const p = path.join(HOT_DIR, `${fileId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const pack = JSON.parse(fs.readFileSync(p, "utf8"));
    const songs = Array.isArray(pack?.songs) ? pack.songs : [];
    if (!songs.length) return null;
    return songs.slice(0, LIMIT);
  } catch {
    return null;
  }
}

async function searchItunesArtist(keyword, { limit = 5, countries = COUNTRIES } = {}) {
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
        const minScore = isShortLatin ? 10 : 40;
        if (score < minScore) continue;
        const prev = pooled.get(id);
        if (!prev || score > prev.score) {
          pooled.set(id, {
            id: a.artistId,
            name: a.artistName,
            score,
            country,
          });
        }
      }
      const top = [...pooled.values()].sort((a, b) => b.score - a.score)[0];
      if (top && top.score >= 80) break;
    } catch {
      /* next country */
    }
  }
  return [...pooled.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

async function lookupSongs(artistId, country, limit = 80) {
  const data = await itunesGet("/lookup", {
    id: artistId,
    entity: "song",
    limit: Math.min(limit, 200),
    country,
  });
  return (data?.results || []).filter((r) => r.wrapperType === "track");
}

async function loadArtistCatalog(artist, aliases) {
  const queries = [artist.name, artist.search, ...aliases].filter(Boolean);
  const seenQ = new Set();
  const uniq = [];
  for (const q of queries) {
    const k = norm(q);
    if (!k || seenQ.has(k)) continue;
    seenQ.add(k);
    uniq.push(q);
  }

  let bestCand = null;
  // One storefront first; only widen if needed
  for (const q of uniq.slice(0, 2)) {
    const hits = await searchItunesArtist(q, { limit: 3, countries: ["cn"] });
    const top = hits[0];
    if (top && (!bestCand || top.score > bestCand.score)) bestCand = top;
    if (bestCand && bestCand.score >= 80) break;
  }
  if (!bestCand) return { itunesArtistId: "", tracks: [] };

  const byId = new Map();
  for (const country of ["cn"]) {
    try {
      const tracks = await lookupSongs(bestCand.id, country, 120);
      for (const t of tracks) {
        if (!t?.trackId || !t.previewUrl) continue;
        const id = String(t.trackId);
        if (!byId.has(id)) byId.set(id, t);
      }
      if (byId.size >= 40) break;
    } catch {
      /* skip country */
    }
  }
  return { itunesArtistId: String(bestCand.id), tracks: [...byId.values()] };
}

async function resolveSongOffline(song, artistName, aliases, catalog, { allowSearch = true } = {}) {
  const title = String(song?.title || "").trim();
  if (!title) return playSourcePatchFromTrack(null);

  const artists = expandArtistAliases(artistName, song, aliases);
  const state = createTrackMatchState();

  for (const t of catalog.tracks || []) {
    considerTrack(state, t, title, artists, 70);
  }
  // Prefer catalog-only hits to avoid Search rate limits
  if (state.best && state.bestScore >= 85) {
    return playSourcePatchFromTrack(state.best);
  }

  if (!allowSearch) {
    return playSourcePatchFromTrack(state.best);
  }

  // One search term, one country — last resort for catalog misses
  const searchTerms = buildSearchTerms(title, artists, song?.album || "").slice(0, 1);
  for (const term of searchTerms) {
    try {
      const data = await itunesGet("/search", {
        term,
        entity: "song",
        limit: 10,
        country: "cn",
      });
      for (const t of data?.results || []) considerTrack(state, t, title, artists);
    } catch {
      /* miss */
    }
  }

  return playSourcePatchFromTrack(state.best);
}

async function mapPool(items, concurrency, fn) {
  let i = 0;
  const out = new Array(items.length);
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return out;
}

function pickArtists() {
  const seen = new Set();
  const list = [];
  for (const a of ARTISTS) {
    if (!a?.neteaseArtistId) continue;
    if (a.source === "itunes") continue;
    const id = String(a.id);
    if (seen.has(id)) continue;
    if (ONLY.size && !ONLY.has(id)) continue;
    seen.add(id);
    list.push(a);
  }
  return list;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = pickArtists();
console.log(
  `Building itunes-map for ${targets.length} artists · NetEase ${API} · concurrency=${ARTIST_CONCURRENCY}`
);

const ok = [];
const skipped = [];
const failed = [];

await mapPool(targets, ARTIST_CONCURRENCY, async (artist, idx) => {
  const fileId = safeFileId(artist.id);
  const outPath = path.join(OUT_DIR, `${fileId}.json`);
  if (!FORCE && fs.existsSync(outPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
      if (prev?.byNeteaseId || prev?.missNeteaseIds) {
        skipped.push(artist.id);
        ok.push({ id: artist.id, fileId, songs: Object.keys(prev.byNeteaseId || {}).length, skipped: true });
        console.log(`[${idx + 1}/${targets.length}] SKIP ${artist.name}`);
        return;
      }
    } catch {
      /* rebuild */
    }
  }

  try {
    let songs = loadHotTopSongs(artist);
    let songSource = "hot-tops";
    if (!songs?.length) {
      songs = await fetchTopSongs(artist.neteaseArtistId);
      songSource = "netease";
    }
    if (!songs?.length) throw new Error("empty top songs");

    const aliases = [artist.search, artist.name].filter(Boolean);
    const catalog = await loadArtistCatalog(artist, aliases);
    if (!catalog.tracks.length) {
      throw new Error("empty iTunes catalog (rate-limit or no artist match)");
    }

    const byNeteaseId = {};
    const missNeteaseIds = [];
    let hits = 0;
    const pendingSearch = [];

    // Pass 1: catalog-only (zero Search)
    for (const song of songs) {
      const nid = String(song.neteaseId || song.id || "");
      if (!nid) continue;
      const patch = await resolveSongOffline(song, artist.name, aliases, catalog, {
        allowSearch: false,
      });
      if (patch.playSource === "itunes" && patch.previewUrl) {
        byNeteaseId[nid] = {
          playSource: "itunes",
          itunesTrackId: patch.itunesTrackId,
          previewUrl: patch.previewUrl,
          trackViewUrl: patch.trackViewUrl,
          itunesTitle: patch.itunesTitle || "",
          itunesArtistName: patch.itunesArtistName || "",
        };
        hits += 1;
      } else {
        pendingSearch.push(song);
      }
    }

    // Pass 2: limited Search for catalog misses (cap per artist)
    const searchCap = Math.min(8, pendingSearch.length);
    for (let i = 0; i < pendingSearch.length; i++) {
      const song = pendingSearch[i];
      const nid = String(song.neteaseId || song.id || "");
      if (i < searchCap) {
        const patch = await resolveSongOffline(song, artist.name, aliases, catalog, {
          allowSearch: true,
        });
        if (patch.playSource === "itunes" && patch.previewUrl) {
          byNeteaseId[nid] = {
            playSource: "itunes",
            itunesTrackId: patch.itunesTrackId,
            previewUrl: patch.previewUrl,
            trackViewUrl: patch.trackViewUrl,
            itunesTitle: patch.itunesTitle || "",
            itunesArtistName: patch.itunesArtistName || "",
          };
          hits += 1;
          continue;
        }
      }
      missNeteaseIds.push(nid);
    }

    const payload = {
      artistId: artist.id,
      name: artist.name,
      neteaseArtistId: artist.neteaseArtistId,
      itunesArtistId: catalog.itunesArtistId || "",
      updatedAt: new Date().toISOString(),
      songSource,
      byNeteaseId,
      missNeteaseIds,
    };
    fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
    ok.push({ id: artist.id, fileId, songs: songs.length, hits, misses: missNeteaseIds.length });
    writeIndexFromDisk();
    console.log(
      `[${idx + 1}/${targets.length}] OK ${artist.name} (${songSource}) hit=${hits} miss=${missNeteaseIds.length}`
    );
  } catch (e) {
    failed.push({ id: artist.id, error: String(e.message || e) });
    console.warn(`[${idx + 1}/${targets.length}] FAIL ${artist.name}: ${e.message || e}`);
  }
  await sleep(800);
});

function writeIndexFromDisk() {
  const artistsIndex = {};
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
      const id = pack.artistId || path.basename(f, ".json");
      artistsIndex[id] = path.basename(f, ".json");
    } catch {
      /* skip bad */
    }
  }
  const index = {
    generatedAt: new Date().toISOString(),
    limit: LIMIT,
    artists: artistsIndex,
  };
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2), "utf8");
  return artistsIndex;
}

// Rebuild index from all shards on disk (supports resume)
const artistsIndex = writeIndexFromDisk();

console.log(
  `\nDone. ok=${ok.filter((x) => !x.skipped).length} skipped=${skipped.length} fail=${failed.length} index=${Object.keys(artistsIndex).length}`
);
if (failed.length) {
  console.log(failed.slice(0, 30));
  process.exitCode = 1;
}
