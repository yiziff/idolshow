/**
 * NetEase API client (proxied via /api/netease).
 */

const API = "/api/netease";

function hiRes(url, size = 500) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．.]/g, "");
}

async function getJson(pathname, query = {}) {
  const url = new URL(API + pathname, window.location.origin);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`netease ${pathname} HTTP ${res.status}`);
  return res.json();
}

export async function pingApi() {
  try {
    const res = await fetch(`${API}/search?keywords=a&limit=1`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function searchArtist(keyword) {
  const data = await getJson("/cloudsearch", {
    keywords: keyword,
    type: 100,
    limit: 8,
  });
  const artists = data?.result?.artists || [];
  const want = norm(keyword);
  const ranked = [...artists].sort((a, b) => {
    const an = norm(a.name);
    const bn = norm(b.name);
    const as = an === want ? 0 : an.includes(want) || want.includes(an) ? 1 : 2;
    const bs = bn === want ? 0 : bn.includes(want) || want.includes(bn) ? 1 : 2;
    return as - bs;
  });
  return ranked.map((a) => ({
    id: a.id,
    name: a.name,
    avatar: hiRes(a.img1v1Url || a.picUrl || "", 400),
  }));
}

function mapNeteaseSong(s) {
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
}

export async function artistTopSongs(artistId, limit = 50) {
  const data = await getJson("/artist/top/song", { id: artistId });
  const songs = data?.songs || data?.hotSongs || [];
  return dedupeByTitleKeepHotter(songs.map(mapNeteaseSong)).slice(0, limit);
}

export async function artistSongsPage(artistId, { order = "hot", offset = 0, limit = 100 } = {}) {
  const data = await getJson("/artist/songs", {
    id: artistId,
    order,
    offset,
    limit,
  });
  const raw = data?.songs || [];
  return {
    songs: raw.map(mapNeteaseSong),
    more: Boolean(data?.more),
    total: Number(data?.total) || raw.length,
  };
}

export function mergeSongPools(existing, incoming) {
  return dedupeByTitleKeepHotter([...(existing || []), ...(incoming || [])]);
}

export async function expandArtistPool(existingSongs, artistId, target = "top100") {
  const id = String(artistId || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("invalid artist id");

  const base = Array.isArray(existingSongs) ? [...existingSongs] : [];

  if (target === "top100") {
    const page = await artistSongsPage(id, { order: "hot", offset: 0, limit: 100 });
    const merged = mergeSongPools(base, page.songs).slice(0, 100);
    return {
      songs: merged,
      stage: "top100",
      added: Math.max(0, merged.length - base.length),
      total: page.total,
      more: page.more || merged.length < (page.total || 0),
    };
  }

  let offset = 0;
  const pageSize = 100;
  let more = true;
  let total = 0;
  let incoming = [];
  for (let page = 0; page < 30 && more; page++) {
    const chunk = await artistSongsPage(id, { order: "hot", offset, limit: pageSize });
    total = chunk.total || total;
    incoming = incoming.concat(chunk.songs);
    more = chunk.more && chunk.songs.length > 0;
    offset += pageSize;
    if (!chunk.songs.length) break;
  }
  const merged = mergeSongPools(base, incoming);
  return {
    songs: merged,
    stage: "all",
    added: Math.max(0, merged.length - base.length),
    total: total || merged.length,
    more: false,
  };
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

export async function songPlayUrl(songId) {
  try {
    const data = await getJson("/song/url/v1", {
      id: songId,
      level: "exhigh",
    });
    return data?.data?.[0]?.url || null;
  } catch {
    return null;
  }
}

export function neteaseSongPage(songId) {
  return `https://music.163.com/#/song?id=${encodeURIComponent(songId)}`;
}

export async function loadArtistCup(catalogArtist, { limit = 50 } = {}) {
  let best = null;
  if (catalogArtist.neteaseArtistId) {
    best = {
      id: catalogArtist.neteaseArtistId,
      name: catalogArtist.name,
      avatar: catalogArtist.avatar || "",
    };
  } else {
    const hits = await searchArtist(catalogArtist.search || catalogArtist.name);
    best = hits[0];
  }
  if (!best) {
    throw new Error(`找不到歌手：${catalogArtist.name}`);
  }

  const songsPromise = artistTopSongs(best.id, limit);
  const avatarPromise = best.avatar
    ? Promise.resolve(best.avatar)
    : searchArtist(catalogArtist.search || catalogArtist.name)
        .then((hits) => {
          const matched = hits.find((h) => String(h.id) === String(best.id)) || hits[0];
          return matched?.avatar || "";
        })
        .catch(() => "");

  const [songs, avatar] = await Promise.all([songsPromise, avatarPromise]);
  if (!songs.length) {
    throw new Error(`未拉到热门歌曲：${best.name}`);
  }
  return {
    ...catalogArtist,
    neteaseArtistId: best.id,
    neteaseArtistName: best.name,
    avatar: avatar || best.avatar || catalogArtist.avatar || "",
    songs,
  };
}
