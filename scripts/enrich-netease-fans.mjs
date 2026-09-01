/**
 * Fetch NetEase fan counts + artist avatars for idolshow roster.
 *
 * Usage:
 *   npm run fans:fetch
 *   NETEASE_API_BASE=https://heipaclub.com/api/netease npm run fans:fetch
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS_SEED } from "../src/data/artists.seed.js";
import { nameScore } from "../src/itunes-match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "src/data/netease-fans.json");
const API = process.env.NETEASE_API_BASE || "https://heipaclub.com/api/netease";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seed id → preferred NetEase search keyword */
const NETEASE_SEARCH = {
  "nine-percent": "NINE PERCENT",
  next: "乐华七子NEXT",
  oner: "ONER",
  justin: "黄明昊",
  "wang-lingkai": "王琳凯",
  "fan-chengcheng": "范丞丞",
  "lin-yanjun": "林彦俊",
};

/** Known NetEase artist ids (avoid ambiguous short Latin names). */
const NETEASE_ID = {
  "nine-percent": 15021166,
  next: 15021290,
  oner: 29148386,
};

function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function seedExpectsCjk(seed) {
  return hasCjk(seed.name) || hasCjk(seed.search) || hasCjk(NETEASE_SEARCH[seed.id]);
}

function hiRes(url, size = 400) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

async function fanCount(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await getJson(`/artist/follow/count?id=${id}`);
    if (data) return Number(data?.data?.fansCnt || 0);
  }
  return 0;
}

async function getJson(pathname) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${pathname}`);
    if (res.status === 429) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
    return res.json();
  }
  throw new Error(`HTTP 429 ${pathname}`);
}

async function searchArtists(keyword, limit = 8) {
  const data = await getJson(
    `/cloudsearch?keywords=${encodeURIComponent(keyword)}&type=100&limit=${limit}`
  );
  return data?.result?.artists || [];
}

function bestMatch(seed, artists) {
  const queries = [seed.name, ...(String(seed.search || "").split(/\s+/))].filter(Boolean);
  let best = null;
  for (const a of artists) {
    if (seedExpectsCjk(seed) && !hasCjk(a.name) && !(a.alias || a.alia || []).some(hasCjk)) {
      continue;
    }
    let score = 0;
    for (const q of queries) {
      score = Math.max(score, nameScore(q, a.name));
      for (const alias of a.alias || a.alia || []) {
        score = Math.max(score, nameScore(q, alias));
      }
    }
    if (!best || score > best.score) best = { artist: a, score };
  }
  return best?.score >= 55 ? best.artist : null;
}

async function resolveById(neteaseId, seed) {
  const data = await getJson(`/artist/detail?id=${neteaseId}`);
  const artist = data?.data?.artist;
  if (!artist?.id) {
    return { id: seed.id, name: seed.name, neteaseArtistId: 0, fans: 0, avatar: "", ok: false };
  }
  const fans = await fanCount(artist.id);
  await sleep(60);
  return {
    id: seed.id,
    name: seed.name,
    neteaseArtistId: artist.id,
    neteaseName: artist.name,
    fans,
    avatar: hiRes(artist.img1v1Url || artist.picUrl || "", 400),
    ok: fans > 0,
  };
}

async function resolveSeed(seed) {
  if (NETEASE_ID[seed.id]) {
    return resolveById(NETEASE_ID[seed.id], seed);
  }
  const extra = NETEASE_SEARCH[seed.id];
  const queries = [
    ...(extra ? [extra] : []),
    seed.name,
    ...String(seed.search || "").split(/\s+/),
  ]
    .filter((q) => q && q.length >= 2)
    .sort((a, b) => b.length - a.length);
  const uniqueQueries = [...new Set(queries)];
  let hit = null;
  for (const q of uniqueQueries) {
    const artists = await searchArtists(q, 8);
    const candidate = bestMatch(seed, artists);
    await sleep(60);
    if (!candidate) continue;
    const fans = await fanCount(candidate.id);
    await sleep(60);
    if (fans < 5000 && uniqueQueries.length > 1) continue;
    hit = { artist: candidate, fans };
    break;
  }
  if (!hit) {
    return { id: seed.id, name: seed.name, neteaseArtistId: 0, fans: 0, avatar: "", ok: false };
  }
  return {
    id: seed.id,
    name: seed.name,
    neteaseArtistId: hit.artist.id,
    neteaseName: hit.artist.name,
    fans: hit.fans,
    avatar: hiRes(hit.artist.img1v1Url || hit.artist.picUrl || "", 400),
    ok: hit.fans > 0,
  };
}

async function main() {
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const byId = { ...(prev.byId || {}) };
  const audit = [];

  console.log(`NetEase API: ${API}`);
  console.log(`Artists: ${ARTISTS_SEED.length}`);

  for (const seed of ARTISTS_SEED) {
    process.stdout.write(`→ ${seed.name} … `);
    if (byId[seed.id]?.fans > 0 && byId[seed.id]?.avatar && !process.env.FANS_FORCE) {
      console.log(`cached ${byId[seed.id].fans}`);
      audit.push({ ...byId[seed.id], cached: true });
      continue;
    }
    try {
      const row = await resolveSeed(seed);
      byId[seed.id] = row;
      audit.push(row);
      console.log(row.ok ? `${row.fans} (${row.neteaseName})` : "MISS");
    } catch (e) {
      const row = {
        id: seed.id,
        name: seed.name,
        neteaseArtistId: 0,
        fans: 0,
        avatar: "",
        ok: false,
        error: String(e.message || e),
      };
      byId[seed.id] = row;
      audit.push(row);
      console.log("ERR", e.message || e);
    }
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    api: API,
    byId,
    audit,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
  const ok = audit.filter((a) => a.fans > 0).length;
  console.log(`\nDone: ${ok}/${ARTISTS_SEED.length} with fans → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
