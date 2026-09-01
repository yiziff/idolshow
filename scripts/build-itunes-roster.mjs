/**
 * Build 内娱 idol roster + iTunes hot-top packs (offline).
 *
 * Usage: npm run roster:build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS_SEED } from "../src/data/artists.seed.js";
import {
  nameScore,
  norm,
} from "../src/itunes-match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "src/data/hot-tops");
const ARTISTS_OUT = path.join(ROOT, "src/data/artists.js");
const AUDIT_OUT = path.join(ROOT, "src/data/roster-audit.json");
const FANS_PATH = path.join(ROOT, "src/data/netease-fans.json");
const ITUNES = "https://itunes.apple.com";
const COUNTRIES = ["cn", "hk", "tw", "us", "jp"];
const LIMIT = Number(process.env.ITUNES_ROSTER_LIMIT || 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let backoffMs = Number(process.env.ITUNES_ROSTER_DELAY_MS || 800);

function itunesArt(url, size = 600) {
  if (!url) return "";
  return String(url).replace(/\d+x\d+bb/, `${size}x${size}bb`);
}

function yearOf(track) {
  const d = track?.releaseDate;
  if (!d) return "";
  return String(d).slice(0, 4);
}

function isNoiseTitle(title) {
  const t = String(title || "").toLowerCase();
  return /live|remix|instrumental|karaoke|伴奏|纯音乐|acoustic version|english version|japanese version|chinese version/.test(t);
}

async function itunesGet(pathname, query = {}) {
  const url = new URL(ITUNES + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url.toString());
    if (res.status === 429) {
      backoffMs = Math.min(backoffMs * 1.5, 8000);
      await sleep(backoffMs);
      continue;
    }
    if (!res.ok) throw new Error(`iTunes ${pathname} HTTP ${res.status}`);
    backoffMs = Math.max(600, backoffMs * 0.9);
    await sleep(backoffMs);
    return res.json();
  }
  throw new Error(`iTunes rate limited: ${pathname}`);
}

async function searchArtist(term, country, limit = 8) {
  const data = await itunesGet("/search", {
    term,
    entity: "musicArtist",
    limit,
    country,
  });
  const want = norm(term.split(/\s+/)[0] || term);
  return (data?.results || [])
    .filter((a) => a.artistId && a.artistName)
    .map((a) => ({
      id: String(a.artistId),
      name: a.artistName,
      score: nameScore(term, a.artistName),
    }))
    .sort((a, b) => b.score - a.score);
}

async function lookupSongs(artistId, country, limit = 50) {
  const data = await itunesGet("/lookup", {
    id: artistId,
    entity: "song",
    limit,
    country,
  });
  return (data?.results || []).filter((t) => t.wrapperType === "track" && t.kind === "song");
}

async function searchSongsByArtist(name, country, limit = 50) {
  const data = await itunesGet("/search", {
    term: name,
    entity: "song",
    attribute: "artistTerm",
    limit,
    country,
  });
  return data?.results || [];
}

function mapTrack(t, fallbackArtist = "") {
  return {
    id: String(t.trackId),
    itunesTrackId: String(t.trackId),
    itunesArtistId: t.artistId ? String(t.artistId) : "",
    title: t.trackName || "",
    artist: t.artistName || fallbackArtist,
    album: t.collectionName || "",
    collection: t.collectionName || "",
    cover: itunesArt(t.artworkUrl100 || t.artworkUrl60 || "", 600),
    coverSm: itunesArt(t.artworkUrl100 || t.artworkUrl60 || "", 200),
    previewUrl: t.previewUrl || "",
    trackViewUrl: t.trackViewUrl || t.collectionViewUrl || "",
    playSource: t.previewUrl ? "itunes" : "none",
    duration_ms: t.trackTimeMillis ?? null,
    year: yearOf(t),
  };
}

function dedupeTracks(tracks) {
  const byTitle = new Map();
  for (const t of tracks) {
    if (!t?.title || isNoiseTitle(t.title)) continue;
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

function searchTerms(seed) {
  const raw = String(seed.search || seed.name || "")
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const r of [seed.name, seed.search, ...raw]) {
    const key = norm(r);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.slice(0, 4);
}

async function resolveArtist(seed) {
  const terms = searchTerms(seed);
  const pooled = new Map();
  for (const term of terms) {
    for (const country of COUNTRIES) {
      try {
        const hits = await searchArtist(term, country, 6);
        for (const h of hits) {
          const prev = pooled.get(h.id);
          if (!prev || h.score > prev.score) pooled.set(h.id, { ...h, country });
        }
      } catch {
        /* next */
      }
    }
    const top = [...pooled.values()].sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= 80) break;
  }
  const candidates = [...pooled.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  if (!candidates.length) return null;

  let best = null;
  let bestSongs = [];
  for (const cand of candidates) {
    let tracks = [];
    for (const country of [cand.country, ...COUNTRIES.filter((c) => c !== cand.country)]) {
      try {
        const looked = await lookupSongs(cand.id, country, LIMIT + 20);
        tracks = tracks.concat(looked);
        if (tracks.length >= LIMIT) break;
      } catch {
        /* skip */
      }
    }
    if (tracks.length < 10) {
      for (const country of COUNTRIES) {
        try {
          const extra = await searchSongsByArtist(cand.name, country, LIMIT + 20);
          tracks = tracks.concat(
            extra.filter(
              (t) =>
                String(t.artistId) === String(cand.id) ||
                nameScore(cand.name, t.artistName) >= 60
            )
          );
        } catch {
          /* skip */
        }
      }
    }
    const mapped = dedupeTracks(tracks.map((t) => mapTrack(t, cand.name)));
    const previewCount = mapped.filter((s) => s.previewUrl).length;
    const bestPreview = bestSongs.filter((s) => s.previewUrl).length;
    if (!best || previewCount > bestPreview || (previewCount === bestPreview && mapped.length > bestSongs.length)) {
      best = cand;
      bestSongs = mapped;
    }
  }
  if (!best) return null;
  const withPreview = bestSongs.filter((s) => s.previewUrl);
  const without = bestSongs.filter((s) => !s.previewUrl);
  const songs = [...withPreview, ...without].slice(0, LIMIT);
  return {
    itunesArtistId: best.id,
    itunesArtistName: best.name,
    score: best.score,
    songs,
    avatar: songs.find((s) => s.cover)?.cover || "",
  };
}

function loadNeteaseFans() {
  if (!fs.existsSync(FANS_PATH)) return {};
  try {
    const { byId = {} } = JSON.parse(fs.readFileSync(FANS_PATH, "utf8"));
    return byId;
  } catch {
    return {};
  }
}

function withNeteaseFans(seed, extra = {}) {
  const fan = loadNeteaseFans()[seed.id];
  const row = { ...seed, ...extra };
  if (fan?.fans) {
    row.neteaseArtistId = fan.neteaseArtistId || row.neteaseArtistId;
    row.fans = fan.fans;
    if (fan.avatar) row.avatar = fan.avatar;
    const previewNote = extra.blurb?.match(/\d+ 首可试听/)?.[0] || "";
    row.blurb = previewNote
      ? `${seed.tag || seed.kind || ""} · 粉丝 ${fan.fans.toLocaleString("zh-CN")} · ${previewNote}`.replace(/^ · /, "")
      : `${seed.tag || seed.kind || ""} · 粉丝 ${fan.fans.toLocaleString("zh-CN")}`.replace(/^ · /, seed.blurb || "");
  }
  return row;
}

function writeArtistsJs(artists) {
  const sorted = [...artists].sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0));
  const body = `/**
 * 内娱偶像 roster — iTunes playback.
 * Generated: ${new Date().toISOString()} · ${sorted.length} artists
 */
export const ARTISTS = ${JSON.stringify(sorted, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
  fs.writeFileSync(ARTISTS_OUT, body, "utf8");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = { artists: {} };
  const audit = [];
  const roster = [];

  for (const seed of ARTISTS_SEED) {
    process.stdout.write(`→ ${seed.name} … `);
    let resolved = null;
    try {
      resolved = await resolveArtist(seed);
    } catch (e) {
      audit.push({ id: seed.id, name: seed.name, ok: false, error: String(e.message || e) });
      console.log("FAIL", e.message || e);
      roster.push(
        withNeteaseFans(seed, {
          source: "itunes",
          itunesArtistId: "",
          avatar: "",
          needsReview: true,
        })
      );
      continue;
    }
    if (!resolved?.songs?.length) {
      audit.push({ id: seed.id, name: seed.name, ok: false, error: "no songs" });
      console.log("MISS");
      roster.push(
        withNeteaseFans(seed, {
          source: "itunes",
          itunesArtistId: "",
          avatar: "",
          needsReview: true,
        })
      );
      continue;
    }
    const fanRow = loadNeteaseFans()[seed.id];
    const avatar = fanRow?.avatar || resolved.avatar;
    const pack = {
      id: seed.id,
      name: seed.name,
      itunesArtistId: resolved.itunesArtistId,
      neteaseArtistId: fanRow?.neteaseArtistId || "",
      avatar,
      songs: resolved.songs,
      updatedAt: new Date().toISOString(),
    };
    const fileId = seed.id;
    fs.writeFileSync(path.join(OUT_DIR, `${fileId}.json`), JSON.stringify(pack, null, 2), "utf8");
    index.artists[seed.id] = fileId;
    roster.push(
      withNeteaseFans(seed, {
        source: "itunes",
        itunesArtistId: resolved.itunesArtistId,
        avatar,
        blurb: `${seed.tag || seed.kind || ""} · ${resolved.songs.filter((s) => s.previewUrl).length} 首可试听`.replace(/^ · /, seed.blurb || ""),
      })
    );
    audit.push({
      id: seed.id,
      name: seed.name,
      ok: true,
      itunesArtistId: resolved.itunesArtistId,
      itunesArtistName: resolved.itunesArtistName,
      songs: resolved.songs.length,
      previews: resolved.songs.filter((s) => s.previewUrl).length,
      score: resolved.score,
    });
    console.log(`OK ${resolved.songs.length} songs (${resolved.itunesArtistId})`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2), "utf8");
  fs.writeFileSync(AUDIT_OUT, JSON.stringify(audit, null, 2), "utf8");
  writeArtistsJs(roster);
  const ok = audit.filter((a) => a.ok).length;
  console.log(`\nDone: ${ok}/${ARTISTS_SEED.length} artists with hot-tops → ${ARTISTS_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
