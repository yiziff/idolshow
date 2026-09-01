/**
 * Build artists.js from seed + NetEase fan/avatar data.
 *
 * Usage: npm run fans:merge
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS_SEED } from "../src/data/artists.seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FANS_PATH = path.join(ROOT, "src/data/netease-fans.json");
const OUT = path.join(ROOT, "src/data/artists.js");

function main() {
  if (!fs.existsSync(FANS_PATH)) {
    console.error("Missing", FANS_PATH, "— run npm run fans:fetch first");
    process.exit(1);
  }
  const { byId = {} } = JSON.parse(fs.readFileSync(FANS_PATH, "utf8"));
  const merged = ARTISTS_SEED.map((seed) => {
    const fan = byId[seed.id];
    const row = { ...seed };
    if (fan?.fans) {
      row.neteaseArtistId = fan.neteaseArtistId || row.neteaseArtistId;
      row.fans = fan.fans;
      if (fan.avatar) row.avatar = fan.avatar;
      row.blurb = `${seed.tag || seed.kind || ""} · 粉丝 ${fan.fans.toLocaleString("zh-CN")} · 热门 Top50`.replace(/^ · /, "");
    }
    return row;
  }).sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0));

  const body = `/**
 * 内娱偶像 roster — NetEase 热门 + iTunes 试听优先。
 * Updated: ${new Date().toISOString()} · ${merged.length} artists
 */
export const ARTISTS = ${JSON.stringify(merged, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
  fs.writeFileSync(OUT, body, "utf8");
  const withFans = merged.filter((a) => a.fans > 0).length;
  console.log(`Built ${OUT} (${withFans}/${merged.length} with NetEase fans)`);
}

main();
