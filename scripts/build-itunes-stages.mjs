/**
 * Build iTunes preview mapping for 梦回大厂 stages (offline).
 *
 * Usage: npm run stages:build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES_SEED } from "../src/data/stages.seed.js";
import { nameScore, norm, titleCore } from "../src/itunes-match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const STAGES_OUT = path.join(ROOT, "src/data/stages.js");
const AUDIT_OUT = path.join(ROOT, "src/data/stages-audit.json");
const ITUNES = "https://itunes.apple.com";
const COUNTRIES = ["cn", "hk", "tw", "us", "jp"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let backoffMs = Number(process.env.ITUNES_STAGES_DELAY_MS || 700);

function itunesArt(url, size = 600) {
  if (!url) return "";
  return String(url).replace(/\d+x\d+bb/, `${size}x${size}bb`);
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
    backoffMs = Math.max(500, backoffMs * 0.9);
    await sleep(backoffMs);
    return res.json();
  }
  throw new Error(`iTunes rate limited: ${pathname}`);
}

async function searchSong(term, country, limit = 12) {
  const data = await itunesGet("/search", {
    term,
    entity: "song",
    limit,
    country,
  });
  return data?.results || [];
}

function scoreTrack(queryTerm, queryArtist, track) {
  if (!track?.trackName) return 0;
  const titleScore = titleCore(queryTerm) === titleCore(track.trackName) ? 100 : nameScore(queryTerm, track.trackName);
  let artistScore = 0;
  if (queryArtist) {
    artistScore = nameScore(queryArtist, track.artistName);
  }
  const previewBonus = track.previewUrl ? 15 : 0;
  return titleScore * 0.65 + artistScore * 0.35 + previewBonus;
}

async function resolveStage(stage) {
  const queries = stage.queries?.length ? stage.queries : [{ term: stage.title, artist: "" }];
  let best = null;
  let bestScore = 0;
  let matchedQuery = null;

  for (const q of queries) {
    for (const country of COUNTRIES) {
      try {
        const term = q.artist ? `${q.term} ${q.artist}` : q.term;
        const hits = await searchSong(term, country, 15);
        for (const t of hits) {
          if (t.kind !== "song" && t.wrapperType !== "track") continue;
          const score = scoreTrack(q.term, q.artist, t);
          if (score > bestScore) {
            bestScore = score;
            best = t;
            matchedQuery = q;
          }
        }
      } catch {
        /* next */
      }
    }
    if (best?.previewUrl && bestScore >= 70) break;
  }

  if (!best) {
    return {
      ...stage,
      cover: "",
      coverSm: "",
      previewUrl: "",
      playSource: "none",
      itunesTrackId: "",
      trackViewUrl: "",
      matchScore: 0,
      matchedQuery: null,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ...stage,
    cover: itunesArt(best.artworkUrl100 || best.artworkUrl60 || "", 600),
    coverSm: itunesArt(best.artworkUrl100 || best.artworkUrl60 || "", 200),
    previewUrl: best.previewUrl || "",
    playSource: best.previewUrl ? "itunes" : "none",
    itunesTrackId: String(best.trackId || ""),
    trackViewUrl: best.trackViewUrl || best.collectionViewUrl || "",
    itunesTitle: best.trackName || "",
    itunesArtistName: best.artistName || "",
    matchScore: bestScore,
    matchedQuery,
    updatedAt: new Date().toISOString(),
  };
}

function writeStagesJs(stages) {
  const body = `/**
 * 梦回大厂舞台库 — iTunes preview mapping.
 * Generated: ${new Date().toISOString()} · ${stages.length} stages
 */
export const STAGES = ${JSON.stringify(stages, null, 2)};
`;
  fs.writeFileSync(STAGES_OUT, body, "utf8");
}

async function main() {
  const audit = [];
  const stages = [];

  for (const seed of STAGES_SEED) {
    process.stdout.write(`→ ${seed.title}${seed.subtitle ? ` (${seed.subtitle})` : ""} … `);
    try {
      const resolved = await resolveStage(seed);
      stages.push(resolved);
      const ok = Boolean(resolved.previewUrl);
      audit.push({
        id: seed.id,
        title: seed.title,
        ok,
        previewUrl: resolved.previewUrl || null,
        itunesTrackId: resolved.itunesTrackId || null,
        matchScore: resolved.matchScore || 0,
        matchedQuery: resolved.matchedQuery || null,
      });
      console.log(ok ? `OK (${resolved.itunesTrackId})` : "NO PREVIEW");
    } catch (e) {
      audit.push({ id: seed.id, title: seed.title, ok: false, error: String(e.message || e) });
      stages.push({
        ...seed,
        cover: "",
        coverSm: "",
        previewUrl: "",
        playSource: "none",
        itunesTrackId: "",
        trackViewUrl: "",
        updatedAt: new Date().toISOString(),
      });
      console.log("FAIL", e.message || e);
    }
  }

  writeStagesJs(stages);
  fs.writeFileSync(AUDIT_OUT, JSON.stringify(audit, null, 2), "utf8");
  const ok = audit.filter((a) => a.ok).length;
  console.log(`\nDone: ${ok}/${STAGES_SEED.length} stages with preview → ${STAGES_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
