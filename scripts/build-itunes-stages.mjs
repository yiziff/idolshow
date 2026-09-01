/**
 * Build 梦回大厂 stage library: NetEase track as primary audio,
 * optional strict iTunes Live preview upgrade.
 *
 * Usage:
 *   NETEASE_API=http://127.0.0.1:3000 npm run stages:build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES_SEED } from "../src/data/stages.seed.js";
import { nameScore, titleCore } from "../src/itunes-match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const STAGES_OUT = path.join(ROOT, "src/data/stages.js");
const AUDIT_OUT = path.join(ROOT, "src/data/stages-audit.json");
const STAGE_NETEASE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/data/stages-netease.json"), "utf8")
);
const NETEASE = (process.env.NETEASE_API || "http://127.0.0.1:3000").replace(/\/+$/, "");
const ITUNES = "https://itunes.apple.com";
const COUNTRIES = ["cn", "hk"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let itunesBackoffMs = Number(process.env.ITUNES_STAGES_DELAY_MS || 700);

/** Minimum score to accept an iTunes hit (prevents Ei Ei → 耍帅勇士). */
const ITUNES_MIN_SCORE = 85;

function hiRes(url, size = 500) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function itunesArt(url, size = 600) {
  if (!url) return "";
  return String(url).replace(/\d+x\d+bb/, `${size}x${size}bb`);
}

async function neteaseGet(pathname, query = {}) {
  const url = new URL(NETEASE + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`NetEase ${pathname} HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`NetEase rate limited: ${pathname}`);
}

async function itunesGet(pathname, query = {}) {
  const url = new URL(ITUNES + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url.toString());
    if (res.status === 429) {
      itunesBackoffMs = Math.min(itunesBackoffMs * 1.5, 8000);
      await sleep(itunesBackoffMs);
      continue;
    }
    if (!res.ok) throw new Error(`iTunes ${pathname} HTTP ${res.status}`);
    itunesBackoffMs = Math.max(500, itunesBackoffMs * 0.9);
    await sleep(itunesBackoffMs);
    return res.json();
  }
  throw new Error(`iTunes rate limited: ${pathname}`);
}

async function loadNeteaseSong(id) {
  const data = await neteaseGet("/song/detail", { ids: id });
  const song = data?.songs?.[0];
  if (!song?.id) return null;
  const pic = song.al?.picUrl || "";
  return {
    neteaseId: String(song.id),
    cover: hiRes(pic, 600),
    coverSm: hiRes(pic, 200),
    neteaseTitle: song.name || "",
    neteaseArtistName: (song.ar || []).map((a) => a.name).join(", "),
  };
}

function scoreItunesTrack(stage, track) {
  if (!track?.trackName || !track?.previewUrl) return 0;
  const wantTitle = stage.title;
  const tcWant = titleCore(wantTitle);
  const tcHit = titleCore(track.trackName);
  let titleScore =
    tcWant && tcHit && tcWant === tcHit
      ? 100
      : nameScore(wantTitle, track.trackName);
  // Live / 偶像练习生 collection bonus
  const artist = String(track.artistName || "");
  const album = String(track.collectionName || "");
  let bonus = 0;
  if (/偶像练习生|nine percent|蔡徐坤|陈立农|范丞丞|朱正廷/i.test(artist)) bonus += 25;
  if (/偶像练习生|表演曲目|live/i.test(album)) bonus += 20;
  if (/\blive\b|现场/i.test(track.trackName)) bonus += 10;
  // Prefer performers overlap
  for (const p of stage.performers || []) {
    if (p && artist.includes(p)) bonus += 8;
  }
  return titleScore * 0.7 + bonus;
}

async function tryItunesUpgrade(stage) {
  const queries = [
    ...(stage.queries || []),
    { term: `偶像练习生 ${stage.title}`, artist: "偶像练习生" },
    { term: `${stage.title} Live`, artist: "偶像练习生" },
  ];
  let best = null;
  let bestScore = 0;

  for (const q of queries) {
    for (const country of COUNTRIES) {
      try {
        const term = q.artist ? `${q.term} ${q.artist}` : q.term;
        const data = await itunesGet("/search", {
          term,
          entity: "song",
          limit: 15,
          country,
        });
        for (const t of data?.results || []) {
          if (t.kind !== "song" && t.wrapperType !== "track") continue;
          const score = scoreItunesTrack(stage, t);
          if (score > bestScore) {
            bestScore = score;
            best = t;
          }
        }
      } catch {
        /* next */
      }
    }
    if (bestScore >= 110) break;
  }

  if (!best || bestScore < ITUNES_MIN_SCORE) {
    return null;
  }
  // Title must still vaguely match — blocks 耍帅勇士 for Ei Ei
  const titleOk =
    nameScore(stage.title, best.trackName) >= 55 ||
    titleCore(stage.title) === titleCore(best.trackName);
  if (!titleOk) return null;

  return {
    previewUrl: best.previewUrl || "",
    itunesTrackId: String(best.trackId || ""),
    trackViewUrl: best.trackViewUrl || best.collectionViewUrl || "",
    itunesTitle: best.trackName || "",
    itunesArtistName: best.artistName || "",
    cover: itunesArt(best.artworkUrl100 || "", 600),
    coverSm: itunesArt(best.artworkUrl100 || "", 200),
    matchScore: bestScore,
  };
}

function itunesFitsStage(stage, itunesArtistName) {
  const artist = String(itunesArtistName || "");
  if (!artist) return false;
  if (/偶像练习生/i.test(artist)) return true;
  const performers = stage.performers || [];
  for (const p of performers) {
    if (!p) continue;
    if (/练习生|前\s*20/.test(p)) continue;
    if (artist.includes(p)) return true;
  }
  // Group aliases
  if (performers.some((p) => /乐华/.test(p)) && /UNIQ|乐华/i.test(artist)) return true;
  if (performers.some((p) => /坤音|岳岳|木子洋|卜凡|灵超/.test(p)) && /ONER/i.test(artist)) {
    return true;
  }
  return false;
}

async function resolveStage(stage) {
  const neteaseId = String(
    stage.neteaseId || STAGE_NETEASE[stage.id] || ""
  ).trim();

  let ne = null;
  if (neteaseId) {
    try {
      ne = await loadNeteaseSong(neteaseId);
      await sleep(80);
    } catch (e) {
      console.warn(`  netease fail ${stage.id}:`, e.message || e);
    }
  }

  let itunes = null;
  try {
    itunes = await tryItunesUpgrade(stage);
  } catch {
    itunes = null;
  }

  // Prefer NetEase as identity; upgrade to iTunes only when artist fits the stage
  if (ne?.neteaseId) {
    const useItunes =
      Boolean(itunes?.previewUrl) && itunesFitsStage(stage, itunes.itunesArtistName);
    return {
      ...stage,
      neteaseId: ne.neteaseId,
      cover: (useItunes ? itunes.cover : "") || ne.cover || "",
      coverSm: (useItunes ? itunes.coverSm : "") || ne.coverSm || "",
      previewUrl: useItunes ? itunes.previewUrl : "",
      playSource: useItunes ? "itunes" : "netease",
      itunesTrackId: useItunes ? itunes.itunesTrackId : "",
      trackViewUrl: useItunes ? itunes.trackViewUrl : "",
      itunesTitle: useItunes ? itunes.itunesTitle : "",
      itunesArtistName: useItunes ? itunes.itunesArtistName : "",
      neteaseTitle: ne.neteaseTitle,
      neteaseArtistName: ne.neteaseArtistName,
      matchScore: useItunes ? itunes.matchScore : 0,
      updatedAt: new Date().toISOString(),
    };
  }

  // No NetEase: only keep high-confidence iTunes, else silent none
  if (itunes?.previewUrl) {
    return {
      ...stage,
      neteaseId: "",
      cover: itunes.cover || "",
      coverSm: itunes.coverSm || "",
      previewUrl: itunes.previewUrl,
      playSource: "itunes",
      itunesTrackId: itunes.itunesTrackId,
      trackViewUrl: itunes.trackViewUrl,
      itunesTitle: itunes.itunesTitle,
      itunesArtistName: itunes.itunesArtistName,
      matchScore: itunes.matchScore,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ...stage,
    neteaseId: "",
    cover: "",
    coverSm: "",
    previewUrl: "",
    playSource: "none",
    itunesTrackId: "",
    trackViewUrl: "",
    matchScore: 0,
    updatedAt: new Date().toISOString(),
  };
}

function writeStagesJs(stages) {
  const body = `/**
 * 梦回大厂舞台库 — NetEase primary + strict iTunes preview.
 * Generated: ${new Date().toISOString()} · ${stages.length} stages
 */
export const STAGES = ${JSON.stringify(stages, null, 2)};
`;
  fs.writeFileSync(STAGES_OUT, body, "utf8");
}

async function main() {
  console.log(`NetEase API: ${NETEASE}`);
  const audit = [];
  const stages = [];

  for (const seed of STAGES_SEED) {
    const label = `${seed.title}${seed.subtitle ? ` (${seed.subtitle})` : ""}`;
    process.stdout.write(`→ ${label} … `);
    try {
      const resolved = await resolveStage(seed);
      stages.push(resolved);
      audit.push({
        id: seed.id,
        title: seed.title,
        playSource: resolved.playSource,
        neteaseId: resolved.neteaseId || null,
        itunesTrackId: resolved.itunesTrackId || null,
        matchScore: resolved.matchScore || 0,
        neteaseTitle: resolved.neteaseTitle || null,
        itunesTitle: resolved.itunesTitle || null,
      });
      console.log(
        resolved.playSource === "none"
          ? "NONE"
          : `${resolved.playSource} ${resolved.neteaseId || resolved.itunesTrackId}`
      );
    } catch (e) {
      audit.push({ id: seed.id, title: seed.title, error: String(e.message || e) });
      stages.push({
        ...seed,
        neteaseId: STAGE_NETEASE[seed.id] || "",
        cover: "",
        coverSm: "",
        previewUrl: "",
        playSource: STAGE_NETEASE[seed.id] ? "netease" : "none",
        updatedAt: new Date().toISOString(),
      });
      console.log("FAIL", e.message || e);
    }
  }

  writeStagesJs(stages);
  fs.writeFileSync(AUDIT_OUT, JSON.stringify(audit, null, 2), "utf8");
  const ok = audit.filter((a) => a.playSource && a.playSource !== "none").length;
  console.log(`\nDone: ${ok}/${STAGES_SEED.length} playable → ${STAGES_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
