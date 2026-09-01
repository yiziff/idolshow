/**
 * Anonymous rank API client (MUSIC CUP style).
 * Dev/prod both use relative /api/rank/* (Vite proxy → local rank server or CF Worker).
 */

const BASE = "/api/rank";
const LOCAL_RANK_PREFIX = "idolshow-rank-cache:v1:";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rankCacheKey(path, query = {}) {
  const parts = [path];
  for (const k of Object.keys(query).sort()) {
    const v = query[k];
    if (v == null || v === "") continue;
    // Search is filtered client-side from full board cache — keep one bucket per board.
    if (k === "q") continue;
    parts.push(`${k}=${v}`);
  }
  return LOCAL_RANK_PREFIX + parts.join("|");
}

function readLocalRank(path, query = {}) {
  try {
    const raw = localStorage.getItem(rankCacheKey(path, query));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalRank(path, query, data) {
  try {
    localStorage.setItem(
      rankCacheKey(path, query),
      JSON.stringify({ savedAt: Date.now(), data })
    );
  } catch {
    /* quota / private mode */
  }
}

/**
 * Rank GET with timeout + exponential backoff.
 * On total failure, returns last successful local snapshot with `_stale: true`
 * so the board never blanks during livestream / CF edge 429.
 * @param {string} path
 * @param {Record<string, unknown>} [query]
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 */
async function getJson(path, query = {}, { timeoutMs = 12000, retries = 2 } = {}) {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: "same-origin" });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`rank ${path} HTTP ${res.status}`);
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        break;
      }
      if (!res.ok) {
        lastErr = new Error(`rank ${path} HTTP ${res.status}`);
        break;
      }
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("application/json")) {
        lastErr = new Error(`rank ${path} non-json`);
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        break;
      }
      const data = await res.json();
      writeLocalRank(path, query, data);
      if (res.headers.get("X-Rank-Cache") === "KV-STALE" || data?._stale) {
        return { ...data, _stale: true };
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e?.name === "AbortError" ? new Error(`rank ${path} timeout`) : e;
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
    }
  }

  const cached = readLocalRank(path, query);
  if (cached?.data) {
    return {
      ...cached.data,
      _stale: true,
      _staleSavedAt: cached.savedAt || null,
    };
  }
  throw lastErr || new Error(`rank ${path} failed`);
}

export async function fetchSongRank({ limit = 150, q = "" } = {}) {
  return getJson("/songs", { limit, q });
}

export async function fetchArtistRank({ limit = 100, q = "" } = {}) {
  return getJson("/artists", { limit, q });
}

/** 梦回大厂 · 神级舞台夺冠榜 */
export async function fetchStageRank({ limit = 100, q = "" } = {}) {
  return getJson("/stages", { limit, q });
}

/** 近 7 日歌手热度 Top5（歌曲杯+歌手PK+单挑王 日增量） */
export async function fetchArtistsWeeklyHot() {
  return getJson("/artists-weekly-hot");
}

/** 谁是单挑王 · 歌手夺冠榜 */
export async function fetchDuelKingRank({ limit = 100, q = "" } = {}) {
  return getJson("/duel-king", { limit, q });
}

/** 某歌手的单挑必杀曲 */
export async function fetchDuelKingSongs(artistId) {
  const id = encodeURIComponent(String(artistId || "").trim());
  if (!id) throw new Error("rank /duel-king songs: missing id");
  return getJson(`/duel-king/${id}/songs`);
}

export async function fetchLabelBeefRank({ limit = 200, q = "" } = {}) {
  return getJson("/labels", { limit, q });
}

export async function fetchLabelBeefMatchups(labelId) {
  const id = encodeURIComponent(String(labelId || "").trim());
  if (!id) throw new Error("rank /labels matchups: missing id");
  return getJson(`/labels/${id}/matchups`);
}

export async function fetchHangLaRank({ limit = 100 } = {}) {
  return getJson("/hangla", { limit });
}

/**
 * Report one finished「从夯到拉」round (夯 + 拉完了 lists).
 */
export async function reportHangLaRound({ hang = [], lale = [] } = {}) {
  const hangIds = hang.map((a) => String(a.artistId || a.id || "")).filter(Boolean).sort();
  const laleIds = lale.map((a) => String(a.artistId || a.id || "")).filter(Boolean).sort();
  if (!hangIds.length && !laleIds.length) {
    return { ok: false, skipped: true, reason: "empty" };
  }
  const dedupeKey = `idolshow:reported-hangla:${hangIds.join(",")}|${laleIds.join(",")}`;
  try {
    if (sessionStorage.getItem(dedupeKey)) {
      return { ok: true, skipped: true, reason: "already reported" };
    }
  } catch (_) {}

  const payload = {
    hang: hang.map((a) => ({
      artistId: String(a.artistId || a.id || ""),
      name: a.name || "",
      avatar: a.avatar || "",
    })),
    lale: lale.map((a) => ({
      artistId: String(a.artistId || a.id || ""),
      name: a.name || "",
      avatar: a.avatar || "",
    })),
  };

  const res = await fetch(BASE + "/hangla", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  if (data.counted !== false) {
    try {
      sessionStorage.setItem(dedupeKey, "1");
    } catch (_) {}
  }
  return data;
}

export async function fetchRankMeta() {
  try {
    return await getJson("/meta");
  } catch {
    return {
      updatedAt: null,
      songCount: 0,
      artistCount: 0,
      totalWins: 0,
      totalSongWins: 0,
      totalArtistWins: 0,
      participation: { total: 0, songPk: 0, artistPk: 0, label: 0, hangla: 0 },
    };
  }
}

/**
 * Report champion once per browser session per song+artist cup.
 */
export async function reportChampionWin({
  song,
  artistId,
  artistName,
  artistAvatar,
  cupType = "",
  songArtist = "",
  winnerLabelId = "",
  winnerLabelName = "",
  loserLabelId = "",
  loserLabelName = "",
} = {}) {
  const isDreamFactory = cupType === "dream-factory";
  const isLabelBeef = cupType === "label-beef";
  const isDuelKing = cupType === "duel-king";
  const songId = String(song?.stageId || song?.neteaseId || song?.id || "").trim();
  const resolvedArtistId = String(
    artistId || song?.rosterArtistId || ""
  ).trim();

  if (isDreamFactory) {
    if (!songId || !song?.title) {
      return { ok: false, skipped: true, reason: "no stage id", milestone: false };
    }
  } else if (!/^\d+$/.test(songId)) {
    return { ok: false, skipped: true, reason: "no song id", milestone: false };
  }
  if (isDuelKing && !resolvedArtistId) {
    return { ok: false, skipped: true, reason: "no duel artist id", milestone: false };
  }

  const dedupeKey = isLabelBeef
    ? `idolshow:reported-win:beef:${winnerLabelId || ""}:${loserLabelId || ""}:${songId}`
    : isDreamFactory
      ? `idolshow:reported-win:dream-factory:${songId}`
      : isDuelKing
        ? `idolshow:reported-win:duel-king:${resolvedArtistId}:${songId}`
        : `idolshow:reported-win:${artistId || ""}:${songId}`;
  const milestoneKey = `${dedupeKey}:milestone`;
  const milestoneShownKey = `${dedupeKey}:milestone-shown`;
  const winsCacheKey = isDreamFactory
    ? `idolshow:stage-wins:${songId}`
    : `idolshow:song-wins:${songId}`;
  try {
    if (sessionStorage.getItem(dedupeKey)) {
      const alreadyShown = sessionStorage.getItem(milestoneShownKey);
      const savedNo = Number(sessionStorage.getItem(milestoneKey) || 0);
      const cachedWins = Number(sessionStorage.getItem(winsCacheKey) || 0) || null;
      if (!alreadyShown && savedNo >= 100 && savedNo % 100 === 0) {
        return {
          ok: true,
          skipped: true,
          reason: "already reported",
          participantNo: savedNo,
          songWins: cachedWins,
          artistWins: null,
          milestone: true,
        };
      }
      return {
        ok: true,
        skipped: true,
        reason: "already reported",
        songWins: cachedWins,
        artistWins: null,
        milestone: false,
      };
    }
  } catch (_) {}

  const displayArtist = isLabelBeef || isDuelKing
    ? songArtist || song?.rosterArtistName || song?.artist || ""
    : isDreamFactory
      ? song?.artist || artistName || ""
      : artistName || song?.artist || "";

  const payload = {
    songId,
    artistId: resolvedArtistId,
    title: song.title || "",
    artist: displayArtist,
    artistName: isLabelBeef || isDuelKing ? displayArtist : artistName || song?.artist || "",
    songArtist: displayArtist,
    cover: song.cover || song.coverSm || "",
    avatar: artistAvatar || song.cover || "",
    cupType: cupType || "",
    chapter: song?.chapter || "",
    winnerLabelId: winnerLabelId || "",
    winnerLabelName: winnerLabelName || "",
    loserLabelId: loserLabelId || "",
    loserLabelName: loserLabelName || "",
  };

  const res = await fetch(BASE + "/win", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}`, milestone: false };
  }

  if (data.counted === false) {
    return {
      ok: true,
      skipped: true,
      reason: data.reason || "daily_quota_exceeded",
      dailyLimit: data.dailyLimit ?? 5,
      usedToday: data.usedToday ?? null,
      remainingToday: data.remainingToday ?? 0,
      participantNo: null,
      milestone: false,
    };
  }

  try {
    sessionStorage.setItem(dedupeKey, "1");
  } catch (_) {}

  const songWins = Number(data.songWins || data.artistWins || 0) || null;
  if (songWins != null) {
    try {
      sessionStorage.setItem(winsCacheKey, String(songWins));
    } catch (_) {}
  }

  const participantNo = Number(data.participantNo || 0) || null;
  const milestone = Boolean(data.milestone) && participantNo != null;
  if (milestone) {
    try {
      sessionStorage.setItem(milestoneKey, String(participantNo));
    } catch (_) {}
  }

  return {
    ...data,
    songWins,
    participantNo,
    milestone,
  };
}

/** 彩蛋已展示后调用，避免同一次上报反复弹出 */
export function markMilestoneShown({ song, artistId } = {}) {
  const songId = String(song?.neteaseId || song?.id || "").trim();
  if (!songId) return;
  const key = `idolshow:reported-win:${artistId || ""}:${songId}:milestone-shown`;
  try {
    sessionStorage.setItem(key, "1");
  } catch (_) {}
}
