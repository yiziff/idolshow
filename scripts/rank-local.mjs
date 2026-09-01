/**
 * Local anonymous rank API (MUSIC CUP style).
 * Same contract as Cloudflare Worker — for npm run rank:dev
 *
 *   GET  /api/rank/songs?limit=150&q=
 *   GET  /api/rank/artists?limit=100&q=
 *   GET  /api/rank/meta
 *   POST /api/rank/win  { songId, artistId, title, artist, cover, artistName?, avatar? }
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const STORE = path.join(ROOT, "data/rank-store.json");
const PORT = Number(process.env.RANK_PORT || 8788);

const rate = new Map(); // ip -> { count, reset }

function load() {
  if (!fs.existsSync(STORE)) {
    return { songs: {}, artists: {}, artistsPk: {}, stages: {}, activityDaily: {}, updatedAt: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (!data.artistsPk) data.artistsPk = {};
    if (!data.stages) data.stages = {};
    if (!data.activityDaily) data.activityDaily = {};
    return data;
  } catch {
    return { songs: {}, artists: {}, artistsPk: {}, stages: {}, activityDaily: {}, updatedAt: null };
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2), "utf8");
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function clampStr(s, n) {
  return String(s || "").trim().slice(0, n);
}

function allow(ip) {
  const now = Date.now();
  let row = rate.get(ip);
  if (!row || now > row.reset) {
    row = { count: 0, reset: now + 60_000 };
    rate.set(ip, row);
  }
  row.count += 1;
  return row.count <= 20;
}

function listSongs(db, { limit = 150, q = "" } = {}) {
  const needle = q.trim().toLowerCase();
  let rows = Object.values(db.songs);
  if (needle) {
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(needle) ||
        r.artist.toLowerCase().includes(needle)
    );
  }
  return rows
    .sort((a, b) => b.wins - a.wins || a.title.localeCompare(b.title, "zh"))
    .slice(0, Math.min(200, Math.max(1, limit)));
}

function listArtists(db, { limit = 100, q = "" } = {}) {
  const needle = q.trim().toLowerCase();
  let rows = Object.values(db.artists);
  if (needle) {
    rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
  }
  return rows
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name, "zh"))
    .slice(0, Math.min(200, Math.max(1, limit)));
}

function listStages(db, { limit = 100, q = "" } = {}) {
  const needle = q.trim().toLowerCase();
  let rows = Object.values(db.stages || {});
  if (needle) {
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(needle) ||
        String(r.artist || "").toLowerCase().includes(needle)
    );
  }
  return rows
    .sort((a, b) => b.wins - a.wins || a.title.localeCompare(b.title, "zh"))
    .slice(0, Math.min(200, Math.max(1, limit)));
}

function listArtistsPk(db, { limit = 100, q = "" } = {}) {
  const needle = q.trim().toLowerCase();
  let rows = Object.values(db.artistsPk || {});
  if (needle) {
    rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
  }
  return rows
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name, "zh"))
    .slice(0, Math.min(200, Math.max(1, limit)));
}

function dayKeyUTC8(d = new Date()) {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function lastNDaysUTC8(n = 7) {
  const days = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    days.push(dayKeyUTC8(new Date(now - i * 86400000)));
  }
  return days;
}

function bumpActivityDaily(db, { artistId, name, avatar }) {
  const id = String(artistId || "").trim();
  if (!/^\d+$/.test(id)) return;
  if (!db.activityDaily) db.activityDaily = {};
  const day = dayKeyUTC8();
  const key = `${day}|${id}`;
  const row = db.activityDaily[key] || {
    day,
    artistId: id,
    name: name || "未知歌手",
    avatar: avatar || "",
    wins: 0,
  };
  if (name) row.name = name;
  if (avatar) row.avatar = avatar;
  row.wins += 1;
  db.activityDaily[key] = row;
}

function listWeeklyHot(db) {
  const days = lastNDaysUTC8(7);
  const daySet = new Set(days);
  const totals = new Map();
  for (const row of Object.values(db.activityDaily || {})) {
    if (!daySet.has(row.day)) continue;
    const cur = totals.get(row.artistId) || {
      artistId: row.artistId,
      name: row.name,
      avatar: row.avatar || "",
      total: 0,
      byDay: {},
    };
    cur.total += row.wins || 0;
    cur.byDay[row.day] = (cur.byDay[row.day] || 0) + (row.wins || 0);
    if (row.name) cur.name = row.name;
    if (row.avatar) cur.avatar = row.avatar;
    totals.set(row.artistId, cur);
  }
  const artists = [...totals.values()]
    .sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name), "zh"))
    .slice(0, 5)
    .map((a) => ({
      artistId: a.artistId,
      name: a.name || "未知歌手",
      avatar: a.avatar || "",
      total: a.total,
      series: days.map((d) => a.byDay[d] || 0),
    }));
  return { days, artists, since: "2026-08-27" };
}

function applyWin(db, body, city = "") {
  const songId = clampStr(body.songId, 32);
  const artistId = clampStr(body.artistId, 32);
  const title = clampStr(body.title, 120);
  const cupType = clampStr(body.cupType, 32);
  const isDreamFactory = cupType === "dream-factory";
  const chapter = clampStr(body.chapter, 32);
  // Prefer cup host artist name over NetEase collab credit string
  const artist = clampStr(body.artistName || body.artist, 120);
  const cover = clampStr(body.cover, 500);
  const avatar = clampStr(body.avatar, 500);
  const now = new Date().toISOString();

  if (isDreamFactory) {
    if (!songId || !title) {
      return { ok: false, error: "invalid stage" };
    }
    if (!db.stages) db.stages = {};
    const row = db.stages[songId] || {
      stageId: songId,
      title,
      artist,
      cover,
      chapter,
      wins: 0,
    };
    row.title = title || row.title;
    row.artist = artist || row.artist;
    row.cover = cover || row.cover;
    row.chapter = chapter || row.chapter;
    row.wins += 1;
    row.updatedAt = now;
    db.stages[songId] = row;
    db.updatedAt = now;
    return { ok: true, counted: true, songWins: row.wins };
  }

  if (!/^\d+$/.test(songId) || !title) {
    return { ok: false, error: "invalid song" };
  }
  const song = db.songs[songId] || {
    songId,
    title,
    artist,
    cover,
    artistId: artistId || "",
    wins: 0,
  };
  song.title = title || song.title;
  song.artist = artist || song.artist;
  song.cover = cover || song.cover;
  song.artistId = artistId || song.artistId;
  song.wins += 1;
  song.updatedAt = now;
  db.songs[songId] = song;

  if (artistId && /^\d+$/.test(artistId)) {
    const a = db.artists[artistId] || {
      artistId,
      name: artist || "未知歌手",
      avatar,
      wins: 0,
    };
    a.name = artist || a.name;
    a.avatar = avatar || a.avatar || cover;
    a.wins += 1;
    a.updatedAt = now;
    db.artists[artistId] = a;
    if (cupType !== "label-beef") {
      bumpActivityDaily(db, {
        artistId,
        name: artist || "未知歌手",
        avatar: avatar || cover,
      });
    }
  }

  db.updatedAt = now;
  if (city) db.lastCity = city;
  return { ok: true, songWins: song.wins, artistWins: artistId ? db.artists[artistId]?.wins : null };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") {
    return json(res, 204, {});
  }

  const ip = req.socket.remoteAddress || "local";

  try {
    if (req.method === "GET" && url.pathname === "/api/rank/meta") {
      const db = load();
      const totalWins = Object.values(db.songs).reduce((s, x) => s + Number(x.wins || 0), 0);
      return json(res, 200, {
        updatedAt: db.updatedAt,
        songCount: Object.keys(db.songs).length,
        artistCount: Object.keys(db.artists).length,
        totalWins,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/rank/songs") {
      const db = load();
      const limit = Number(url.searchParams.get("limit") || 150);
      const q = url.searchParams.get("q") || "";
      const songs = Object.values(db.songs);
      const totalWins = songs.reduce((s, x) => s + Number(x.wins || 0), 0);
      return json(res, 200, {
        updatedAt: db.updatedAt,
        totalWins,
        songCount: songs.length,
        items: listSongs(db, { limit, q }),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/rank/artists") {
      const db = load();
      const limit = Number(url.searchParams.get("limit") || 100);
      const q = url.searchParams.get("q") || "";
      const songs = Object.values(db.songs);
      const totalWins = songs.reduce((s, x) => s + Number(x.wins || 0), 0);
      return json(res, 200, {
        updatedAt: db.updatedAt,
        totalWins,
        songCount: songs.length,
        artistCount: Object.keys(db.artists || {}).length,
        items: listArtists(db, { limit, q }),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/rank/stages") {
      const db = load();
      const limit = Number(url.searchParams.get("limit") || 100);
      const q = url.searchParams.get("q") || "";
      return json(res, 200, {
        updatedAt: db.updatedAt,
        stageCount: Object.keys(db.stages || {}).length,
        items: listStages(db, { limit, q }),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/rank/artists-pk") {
      const db = load();
      const limit = Number(url.searchParams.get("limit") || 100);
      const q = url.searchParams.get("q") || "";
      const songs = Object.values(db.songs);
      const totalWins = songs.reduce((s, x) => s + Number(x.wins || 0), 0);
      return json(res, 200, {
        updatedAt: db.updatedAt,
        totalWins,
        songCount: songs.length,
        artistCount: Object.keys(db.artistsPk || {}).length,
        items: listArtistsPk(db, { limit, q }),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/rank/artists-weekly-hot") {
      const db = load();
      return json(res, 200, listWeeklyHot(db));
    }

    if (req.method === "POST" && url.pathname === "/api/rank/win") {
      if (!allow(ip)) return json(res, 429, { ok: false, error: "rate limited" });
      const body = await readBody(req);
      const db = load();
      const result = applyWin(db, body);
      if (!result.ok) return json(res, 400, result);
      save(db);
      return json(res, 200, result);
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message || "server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Rank API (local) http://127.0.0.1:${PORT}`);
  console.log(`Store: ${STORE}`);
});
