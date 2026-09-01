/**
 * Cloudflare Worker for heipaclub:
 *   /api/rank/*     → D1 anonymous rankings
 *   /api/netease/*  → proxy to self-hosted api-enhanced (NETEASE_API_ORIGIN)
 *   /api/img        → CORS-safe cover image proxy (html-to-image export)
 *
 * Static assets / SPA are handled by Wrangler assets config.
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

/**
 * 防刷：
 * - 每浏览器 Cookie 每天最多 DAILY_VOTE_LIMIT 次（主限额）
 * - 每公网 IP 每天最多 DAILY_IP_LIMIT 次（清 Cookie / 多浏览器兜底）
 *
 * 不要把 IP/UA 混进 Cookie 身份哈希——手机切 4G/WiFi 会换出口，限额会失效。
 */
const DAILY_VOTE_LIMIT = 5;
const DAILY_IP_LIMIT = 15;
/** 总参与人数每到该倍数触发前端彩蛋（如 1000 / 1100） */
const MILESTONE_STEP = 100;
const VOTER_COOKIE = "cup_voter_id";
const ANALYTICS_COOKIE = "heipa_analytics_id";
const ANALYTICS_EVENTS = new Set([
  "share_open",
  "share_image_ready",
  "cup_start",
  "about_open",
  "perf_lcp_slow",
  "perf_inp_slow",
  "perf_cls_poor",
]);
let quotaSchemaReady = false;
let analyticsSchemaReady = false;
let participationSchemaReady = false;

const RANK_CACHE_TTL_SEC = 120;
const PARTICIPATION_TTL_MS = 30_000;
/** Cron every 5m refreshes; long TTL so a missed cron never bare-metal D1 under livestream. */
const RANK_SNAPSHOT_TTL_SEC = 60 * 60 * 6;
const SONG_URL_TTL_SEC = 180;
const NETEASE_SEARCH_TTL_SEC = 300;
const NETEASE_SONGS_TTL_SEC = 600;
const NETEASE_STALE_TTL_SEC = 3600;
const RATE_WINDOW_MS = 60_000;
/** Only applies to D1-origin rank GETs after KV/edge miss */
const RATE_LIMIT_RANK = 120;
const RATE_LIMIT_NETEASE = 40;

const IMG_PLACEHOLDER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect fill="#e6e4df" width="100%" height="100%"/></svg>`;
const IMG_KV_PREFIX = "img:v1:";
const IMG_MANIFEST_KEY = "img:manifest:v1";
const IMG_KV_TTL_SEC = 60 * 60 * 24 * 30;
const IMG_WARM_BATCH = 20;

/** @type {{ at: number, value: any } | null} */
let participationMemo = null;
/** @type {Map<string, { t: number, n: number }>} */
const rateBuckets = new Map();
let recentFiveXx = 0;
let rateLimitTrips = 0;
let loadWindowStarted = Date.now();

function decayLoadCounters() {
  const now = Date.now();
  if (now - loadWindowStarted > RATE_WINDOW_MS) {
    recentFiveXx = 0;
    rateLimitTrips = 0;
    loadWindowStarted = now;
    if (rateBuckets.size > 4000) rateBuckets.clear();
  }
}

function noteFiveXx() {
  decayLoadCounters();
  recentFiveXx += 1;
}

function clientKey(request) {
  return (
    clampStr(request.headers.get("CF-Connecting-IP"), 80) ||
    clampStr(request.headers.get("X-Forwarded-For")?.split(",")[0], 80) ||
    "ip:unknown"
  );
}

function rateLimitHit(request, bucket, limit) {
  decayLoadCounters();
  const ip = clientKey(request);
  // Never share one global bucket — unknown IP must not throttle the whole site.
  if (!ip || ip === "ip:unknown") return false;
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const cur = rateBuckets.get(key) || { t: now, n: 0 };
  if (now - cur.t > RATE_WINDOW_MS) {
    cur.t = now;
    cur.n = 0;
  }
  cur.n += 1;
  rateBuckets.set(key, cur);
  if (cur.n > limit) {
    rateLimitTrips += 1;
    return true;
  }
  return false;
}

function rateLimitedResponse(request, bucket, limit) {
  if (!rateLimitHit(request, bucket, limit)) return null;
  return new Response(JSON.stringify({ ok: false, error: "rate_limited", retryAfter: 30 }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": "30",
      "Cache-Control": "no-store",
      ...cors,
    },
  });
}

function jsonCached(data, { ttl = RANK_CACHE_TTL_SEC, cacheStatus = "MISS", extra = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}`,
      "X-Rank-Cache": cacheStatus,
      ...extra,
      ...cors,
    },
  });
}

async function cachedProducerResponse(cacheUrl, producer, ttlSec, headerName = "X-Rank-Cache") {
  const cache = caches.default;
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set(headerName, "HIT");
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
      return new Response(hit.body, { status: hit.status, headers });
    }
  } catch {
    /* ignore */
  }
  const res = await producer();
  if (res.status !== 200) return res;
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", `public, max-age=${ttlSec}, s-maxage=${ttlSec}`);
  headers.set(headerName, headers.get(headerName) || "MISS");
  Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
  const out = new Response(res.body, { status: 200, headers });
  try {
    await cache.put(cacheKey, out.clone());
  } catch {
    /* ignore */
  }
  return out;
}

/** Edge Cache API hit only — no D1. Used before rate-limit so hot paths never 429. */
async function tryServeRankEdgeCache(path, url) {
  const cacheUrl = `https://rank-cache.heipaclub.internal${path}?${url.searchParams}`;
  try {
    const hit = await caches.default.match(new Request(cacheUrl, { method: "GET" }));
    if (!hit || hit.status !== 200) return null;
    const headers = new Headers(hit.headers);
    headers.set("X-Rank-Cache", "HIT");
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(hit.body, { status: 200, headers });
  } catch {
    return null;
  }
}

function rankSnapshotKind(path) {
  if (path.endsWith("/api/rank/meta")) return "meta";
  if (path.endsWith("/api/rank/songs")) return "songs";
  if (path.endsWith("/api/rank/artists")) return "artists";
  if (path.endsWith("/api/rank/stages")) return "stages";
  // artists-weekly-hot: 不入 KV 快照（日热度需近实时；空快照会永久挡住真数据）
  if (path.endsWith("/api/rank/duel-king")) return "duel-king";
  if (path.endsWith("/api/rank/labels")) return "labels";
  if (path.endsWith("/api/rank/hangla")) return "hangla";
  return "";
}

function rankFreshKey(kind) {
  return `rank:v1:${kind}`;
}

function rankStaleKey(kind) {
  return `rank:stale:v1:${kind}`;
}

function formatRankSnapshot(kind, snap, limit) {
  if (!snap || typeof snap !== "object") return null;
  if (kind === "songs" || kind === "artists" || kind === "stages" || kind === "labels") {
    const items = Array.isArray(snap.items) ? snap.items.slice(0, limit) : [];
    return { ...snap, items, staleOk: true };
  }
  if (kind === "hangla") {
    return {
      ...snap,
      hang: Array.isArray(snap.hang) ? snap.hang.slice(0, limit) : [],
      lale: Array.isArray(snap.lale) ? snap.lale.slice(0, limit) : [],
      staleOk: true,
    };
  }
  return { ...snap, staleOk: true };
}

async function putRankSnapshots(env, kind, text) {
  if (!env?.ARTIST_TOP || !kind || !text) return;
  await env.ARTIST_TOP.put(rankFreshKey(kind), text, {
    expirationTtl: RANK_SNAPSHOT_TTL_SEC,
  });
  // Permanent fallback so livestream never blanks the board.
  await env.ARTIST_TOP.put(rankStaleKey(kind), text);
}

/**
 * Prefer fresh KV, then permanent stale. With `q`, still return full board
 * (client filters) so search never forces a D1 miss under load.
 */
async function tryServeRankSnapshot(env, path, url, { allowStale = true } = {}) {
  const kind = rankSnapshotKind(path);
  if (!kind || !env.ARTIST_TOP) return null;
  const limit = Math.max(1, Number(url.searchParams.get("limit") || 200));
  try {
    let snap = await env.ARTIST_TOP.get(rankFreshKey(kind), "json");
    let status = "KV";
    if (!snap && allowStale) {
      snap = await env.ARTIST_TOP.get(rankStaleKey(kind), "json");
      status = "KV-STALE";
    }
    if (!snap) return null;
    const body = formatRankSnapshot(kind, snap, limit);
    if (!body) return null;
    if (status === "KV-STALE") body._stale = true;
    return jsonCached(body, { cacheStatus: status });
  } catch {
    return null;
  }
}

async function precomputeRankSnapshots(env) {
  if (!env.DB || !env.ARTIST_TOP) return;
  const jobs = [
    ["/api/rank/meta", "meta"],
    ["/api/rank/songs?limit=200", "songs"],
    ["/api/rank/artists?limit=200", "artists"],
    ["/api/rank/artists-pk?limit=200", "artists-pk"],
    ["/api/rank/duel-king?limit=200", "duel-king"],
    ["/api/rank/labels?limit=200", "labels"],
    ["/api/rank/hangla?limit=100", "hangla"],
  ];
  for (const [pathWithQuery, kind] of jobs) {
    try {
      const req = new Request(`https://heipaclub.com${pathWithQuery}`);
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const res = await handleRank(req, env, path, url);
      if (!res.ok) continue;
      const text = await res.text();
      await putRankSnapshots(env, kind, text);
      try {
        const cacheUrl = `https://rank-cache.heipaclub.internal${path}?${url.searchParams}`;
        await caches.default.put(
          new Request(cacheUrl, { method: "GET" }),
          new Response(text, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `public, max-age=${RANK_CACHE_TTL_SEC}, s-maxage=${RANK_CACHE_TTL_SEC}`,
              "X-Rank-Cache": "CRON",
              ...cors,
            },
          })
        );
      } catch {
        /* edge put best-effort */
      }
    } catch {
      /* snapshot best-effort */
    }
  }
}

async function handleHealth(env) {
  decayLoadCounters();
  const t0 = Date.now();
  let d1Ms = null;
  let d1Ok = false;
  try {
    if (env.DB) {
      await env.DB.prepare("SELECT 1 AS ok").first();
      d1Ms = Date.now() - t0;
      d1Ok = true;
    }
  } catch {
    d1Ms = Date.now() - t0;
  }
  const load =
    recentFiveXx >= 8 || rateLimitTrips >= 12 || (d1Ms != null && d1Ms > 800)
      ? "high"
      : "normal";
  return json({
    ok: true,
    load,
    d1: {
      ok: d1Ok,
      ms: d1Ms,
      hint:
        d1Ms != null && d1Ms > 200
          ? "D1 P95 high — consider paid D1 if this persists under livestream traffic"
          : "ok",
    },
    neteaseOriginConfigured: Boolean(String(env.NETEASE_API_ORIGIN || "").trim()),
    fiveXxWindow: recentFiveXx,
    rateLimitTrips,
  });
}

function clampStr(s, n) {
  return String(s || "").trim().slice(0, n);
}

function parseCookies(cookieHeader) {
  const jar = {};
  const raw = String(cookieHeader || "");
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    jar[k] = decodeURIComponent(rest.join("=") || "");
  }
  return jar;
}

function cookieHeader(name, value, { maxAge = 60 * 60 * 24 * 365, path = "/", sameSite = "Lax" } = {}) {
  const chunks = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
    "HttpOnly",
    "Secure",
  ];
  return chunks.join("; ");
}

function dayKeyUTC8(d = new Date()) {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function sha256Hex(input) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(input || ""))).then((buf) => {
    const arr = Array.from(new Uint8Array(buf));
    return arr.map((x) => x.toString(16).padStart(2, "0")).join("");
  });
}

function clientIp(request) {
  return (
    clampStr(request.headers.get("CF-Connecting-IP"), 80) ||
    clampStr(request.headers.get("X-Forwarded-For")?.split(",")[0], 80) ||
    "ip:unknown"
  );
}

async function ensureQuotaSchema(env) {
  if (quotaSchemaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS vote_quota_daily (
      voter_key TEXT NOT NULL,
      quota_date TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (voter_key, quota_date)
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_vote_quota_date ON vote_quota_daily (quota_date, used_count DESC)`
  ).run();
  quotaSchemaReady = true;
}

async function resolveVoterIdentity(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const existing = clampStr(cookies[VOTER_COOKIE], 100);
  const token = existing || crypto.randomUUID();
  const cookieKey = `c:${await sha256Hex(`v1:${token}`)}`;
  const ipKey = `ip:${await sha256Hex(`v1:${clientIp(request)}`)}`;
  return {
    cookieKey,
    ipKey,
    setCookie: existing ? "" : cookieHeader(VOTER_COOKIE, token),
  };
}

async function getQuotaUsed(env, voterKey, day) {
  const row = await env.DB.prepare(
    "SELECT used_count AS usedCount FROM vote_quota_daily WHERE voter_key = ? AND quota_date = ?"
  )
    .bind(voterKey, day)
    .first();
  return Number(row?.usedCount || 0);
}

/** 原子尝试消耗 1 次日配额 */
async function consumeDailyQuota(env, voterKey, day, nowIso, limit) {
  await ensureQuotaSchema(env);

  const updated = await env.DB.prepare(
    `UPDATE vote_quota_daily
     SET used_count = used_count + 1, updated_at = ?
     WHERE voter_key = ? AND quota_date = ? AND used_count < ?`
  )
    .bind(nowIso, voterKey, day, limit)
    .run();

  if ((updated?.meta?.changes || 0) >= 1) {
    const used = await getQuotaUsed(env, voterKey, day);
    return { counted: true, used, remaining: Math.max(0, limit - used) };
  }

  const existingUsed = await getQuotaUsed(env, voterKey, day);
  if (existingUsed > 0) {
    return { counted: false, used: existingUsed, remaining: 0 };
  }

  try {
    await env.DB.prepare(
      `INSERT INTO vote_quota_daily (voter_key, quota_date, used_count, updated_at)
       VALUES (?, ?, 1, ?)`
    )
      .bind(voterKey, day, nowIso)
      .run();
    return { counted: true, used: 1, remaining: limit - 1 };
  } catch {
    const retry = await env.DB.prepare(
      `UPDATE vote_quota_daily
       SET used_count = used_count + 1, updated_at = ?
       WHERE voter_key = ? AND quota_date = ? AND used_count < ?`
    )
      .bind(nowIso, voterKey, day, limit)
      .run();
    if ((retry?.meta?.changes || 0) >= 1) {
      const used = await getQuotaUsed(env, voterKey, day);
      return { counted: true, used, remaining: Math.max(0, limit - used) };
    }
    const used = await getQuotaUsed(env, voterKey, day);
    return { counted: false, used: used || limit, remaining: 0 };
  }
}

/** Cookie + IP 双限额；任一侧满则不计票 */
async function consumeVoteQuotas(env, cookieKey, ipKey, day, nowIso) {
  await ensureQuotaSchema(env);
  const cookieUsed = await getQuotaUsed(env, cookieKey, day);
  const ipUsed = await getQuotaUsed(env, ipKey, day);

  if (cookieUsed >= DAILY_VOTE_LIMIT) {
    return {
      counted: false,
      reason: "daily_quota_exceeded",
      used: cookieUsed,
      remaining: 0,
      ipUsed,
    };
  }
  if (ipUsed >= DAILY_IP_LIMIT) {
    return {
      counted: false,
      reason: "ip_quota_exceeded",
      used: cookieUsed,
      remaining: 0,
      ipUsed,
    };
  }

  const cookie = await consumeDailyQuota(env, cookieKey, day, nowIso, DAILY_VOTE_LIMIT);
  if (!cookie.counted) {
    return {
      counted: false,
      reason: "daily_quota_exceeded",
      used: cookie.used,
      remaining: 0,
      ipUsed,
    };
  }

  const ip = await consumeDailyQuota(env, ipKey, day, nowIso, DAILY_IP_LIMIT);
  if (!ip.counted) {
    await env.DB.prepare(
      `UPDATE vote_quota_daily
       SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END, updated_at = ?
       WHERE voter_key = ? AND quota_date = ?`
    )
      .bind(nowIso, cookieKey, day)
      .run();
    return {
      counted: false,
      reason: "ip_quota_exceeded",
      used: Math.max(0, cookie.used - 1),
      remaining: 0,
      ipUsed: ip.used,
    };
  }

  return {
    counted: true,
    reason: null,
    used: cookie.used,
    remaining: cookie.remaining,
    ipUsed: ip.used,
  };
}

async function ensureAnalyticsSchema(env) {
  if (analyticsSchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS analytics_events_daily (
        event_date TEXT NOT NULL,
        event_name TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        unique_visitors INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (event_date, event_name)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS analytics_event_uniques (
        event_date TEXT NOT NULL,
        event_name TEXT NOT NULL,
        visitor_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (event_date, event_name, visitor_key)
      )`
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_analytics_events_date
       ON analytics_events_daily (event_date DESC, event_name)`
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_analytics_uniques_date
       ON analytics_event_uniques (event_date DESC)`
    ),
  ]);
  analyticsSchemaReady = true;
}

async function resolveAnalyticsVisitor(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const ownToken = clampStr(cookies[ANALYTICS_COOKIE], 100);
  const voterToken = clampStr(cookies[VOTER_COOKIE], 100);
  const token = ownToken || voterToken || crypto.randomUUID();
  return {
    visitorKey: await sha256Hex(`analytics:v1:${token}`),
    setCookie: ownToken ? "" : cookieHeader(ANALYTICS_COOKIE, token),
  };
}

async function handleMetrics(request, env, path, url) {
  await ensureAnalyticsSchema(env);

  if (request.method === "POST" && path === "/api/metrics/event") {
    const origin = request.headers.get("Origin");
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (origin !== url.origin || (fetchSite && fetchSite !== "same-origin")) {
      return json({ ok: false, error: "same-origin request required" }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const eventName = clampStr(body.event, 40);
    if (!ANALYTICS_EVENTS.has(eventName)) {
      return json({ ok: false, error: "invalid event" }, 400);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const eventDate = dayKeyUTC8(now);
    const { visitorKey, setCookie } = await resolveAnalyticsVisitor(request);

    await env.DB.prepare(
      `INSERT INTO analytics_events_daily
         (event_date, event_name, event_count, unique_visitors, updated_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(event_date, event_name) DO UPDATE SET
         event_count = analytics_events_daily.event_count + 1,
         updated_at = excluded.updated_at`
    )
      .bind(eventDate, eventName, nowIso)
      .run();

    const uniqueInsert = await env.DB.prepare(
      `INSERT OR IGNORE INTO analytics_event_uniques
         (event_date, event_name, visitor_key, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(eventDate, eventName, visitorKey, nowIso)
      .run();

    if ((uniqueInsert?.meta?.changes || 0) > 0) {
      await env.DB.prepare(
        `UPDATE analytics_events_daily
         SET unique_visitors = unique_visitors + 1, updated_at = ?
         WHERE event_date = ? AND event_name = ?`
      )
        .bind(nowIso, eventDate, eventName)
        .run();
    }

    const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
    if (setCookie) headers["Set-Cookie"] = setCookie;
    return new Response(JSON.stringify({ ok: true }), { status: 202, headers });
  }

  if (request.method === "GET" && path === "/api/metrics") {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 30)));
    const since = dayKeyUTC8(new Date(Date.now() - (days - 1) * 86400000));
    const rows = await env.DB.prepare(
      `SELECT event_date AS eventDate,
              event_name AS eventName,
              event_count AS eventCount,
              unique_visitors AS uniqueVisitors,
              updated_at AS updatedAt
       FROM analytics_events_daily
       WHERE event_date >= ?
       ORDER BY event_date DESC, event_name ASC`
    )
      .bind(since)
      .all();
    return json({ ok: true, days, since, items: rows.results || [] });
  }

  return json({ error: "not found" }, 404);
}

async function ensureParticipationSchema(env) {
  if (participationSchemaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS participation_stats (
      mode TEXT PRIMARY KEY,
      plays INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`
  ).run();
  participationSchemaReady = true;
}

/** 夯拉历史局数：无独立计数时用「获夯」总和回填（每局至少 1 次夯） */
async function ensureHanglaPlaysSeeded(env) {
  await ensureParticipationSchema(env);
  const row = await env.DB.prepare(
    "SELECT plays FROM participation_stats WHERE mode = 'hangla'"
  ).first();
  if (row) return Number(row.plays || 0);
  const est = await env.DB.prepare(
    "SELECT COALESCE(SUM(hang_wins), 0) AS t FROM hangla_artist_stats"
  )
    .first()
    .catch(() => ({ t: 0 }));
  const plays = Number(est?.t || 0);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO participation_stats (mode, plays, updated_at)
     VALUES ('hangla', ?, ?)`
  )
    .bind(plays, now)
    .run();
  const again = await env.DB.prepare(
    "SELECT plays FROM participation_stats WHERE mode = 'hangla'"
  ).first();
  return Number(again?.plays || plays);
}

async function bumpHanglaParticipation(env, nowIso) {
  await ensureParticipationSchema(env);
  await ensureHanglaPlaysSeeded(env);
  await env.DB.prepare(
    `UPDATE participation_stats
     SET plays = plays + 1, updated_at = ?
     WHERE mode = 'hangla'`
  )
    .bind(nowIso)
    .run();
}

/**
 * 四种玩法参与局数：
 * - songPk: 歌手内部歌曲 PK（song_wins 去掉厂牌混战写入）
 * - artistPk: 歌手大比拼
 * - label: 厂牌对战（battles / 2）
 * - hangla: 从夯到拉
 * - total: 以上之和
 */
async function getParticipationStats(env) {
  const [songSum, artistPkSum, labelBattles, hanglaPlays] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(wins), 0) AS t FROM song_wins").first(),
    env.DB.prepare("SELECT COALESCE(SUM(wins), 0) AS t FROM artist_pk_wins")
      .first()
      .catch(() => ({ t: 0 })),
    env.DB.prepare("SELECT COALESCE(SUM(battles), 0) AS t FROM label_beef_stats")
      .first()
      .catch(() => ({ t: 0 })),
    ensureHanglaPlaysSeeded(env).catch(() => 0),
  ]);
  const label = Math.floor(Number(labelBattles?.t || 0) / 2);
  const songAll = Number(songSum?.t || 0);
  const songPk = Math.max(0, songAll - label);
  const artistPk = Number(artistPkSum?.t || 0);
  const hangla = Number(hanglaPlays || 0);
  const total = songPk + artistPk + label + hangla;
  return { total, songPk, artistPk, label, hangla, songAll };
}

async function getParticipationStatsCached(env) {
  const now = Date.now();
  if (participationMemo?.value && now - participationMemo.at < PARTICIPATION_TTL_MS) {
    return participationMemo.value;
  }
  const value = await getParticipationStats(env);
  participationMemo = { at: now, value };
  return value;
}

function invalidateParticipationMemo() {
  participationMemo = null;
}

let activityDailySchemaReady = false;

async function ensureArtistActivityDaily(env) {
  if (activityDailySchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS artist_activity_daily (
        day TEXT NOT NULL,
        artist_id TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        wins INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (day, artist_id)
      )`
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_artist_activity_day ON artist_activity_daily (day, wins DESC)`
    ),
  ]);
  activityDailySchemaReady = true;
}

/** 歌曲杯 / 歌手PK / 单挑王：每局有效胜场 +1 日聚合（UTC+8） */
async function bumpArtistActivityDaily(env, { day, artistId, name, avatar, now }) {
  const id = String(artistId || "").trim();
  if (!/^\d+$/.test(id)) return;
  await ensureArtistActivityDaily(env);
  await env.DB.prepare(
    `INSERT INTO artist_activity_daily (day, artist_id, name, avatar, wins, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(day, artist_id) DO UPDATE SET
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE artist_activity_daily.name END,
       avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE artist_activity_daily.avatar END,
       wins = artist_activity_daily.wins + 1,
       updated_at = excluded.updated_at`
  )
    .bind(day, id, String(name || "未知歌手").slice(0, 120), String(avatar || "").slice(0, 500), now)
    .run();
}

function lastNDaysUTC8(n = 7) {
  const days = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    days.push(dayKeyUTC8(new Date(now - i * 86400000)));
  }
  return days;
}

async function ensureDuelKingTables(env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS duel_king_wins (
        artist_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        wins INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS duel_king_songs (
        artist_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        cover TEXT NOT NULL DEFAULT '',
        wins INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (artist_id, song_id)
      )`
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_duel_king_wins ON duel_king_wins (wins DESC)`
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_duel_king_songs ON duel_king_songs (artist_id, wins DESC)`
    ),
  ]);
}

function duelKingStatements(env, { artistId, name, avatar, songId, title, cover, now }) {
  return [
    env.DB.prepare(
      `INSERT INTO duel_king_wins (artist_id, name, avatar, wins, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(artist_id) DO UPDATE SET
         name = excluded.name,
         avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE duel_king_wins.avatar END,
         wins = duel_king_wins.wins + 1,
         updated_at = excluded.updated_at`
    ).bind(artistId, name || "未知歌手", avatar || cover || "", now),
    env.DB.prepare(
      `INSERT INTO duel_king_songs (artist_id, song_id, title, cover, wins, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(artist_id, song_id) DO UPDATE SET
         title = excluded.title,
         cover = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE duel_king_songs.cover END,
         wins = duel_king_songs.wins + 1,
         updated_at = excluded.updated_at`
    ).bind(artistId, songId, title || "", cover || "", now),
  ];
}

async function handleRank(request, env, path, url) {
  if (request.method === "GET" && path.endsWith("/api/rank/meta")) {
    const songCount = await env.DB.prepare(
      "SELECT COUNT(DISTINCT lower(trim(title))) AS c FROM song_wins"
    ).first();
    const artistCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM artist_wins").first();
    const artistPkCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM artist_pk_wins").first().catch(() => ({ c: 0 }));
    const latest = await env.DB.prepare("SELECT MAX(updated_at) AS t FROM song_wins").first();
    const participation = await getParticipationStatsCached(env);
    return json({
      updatedAt: latest?.t || null,
      songCount: songCount?.c || 0,
      artistCount: artistCount?.c || 0,
      artistPkCount: artistPkCount?.c || 0,
      totalWins: participation.songAll,
      participation,
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/songs")) {
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    const rows = await env.DB.prepare(
      `WITH cleaned AS (
         SELECT
           song_id,
           title,
           CASE
             WHEN instr(lower(artist), ' vs ') > 0 THEN
               COALESCE(
                 (SELECT name FROM artist_wins aw WHERE aw.artist_id = song_wins.artist_id),
                 ''
               )
             ELSE artist
           END AS artist,
           cover,
           artist_id,
           wins,
           updated_at
         FROM song_wins
       ),
       merged_songs AS (
         SELECT
           min(song_id) AS songId,
           min(title) AS title,
           replace(group_concat(DISTINCT NULLIF(trim(artist), '')), ',', ' / ') AS artist,
           max(cover) AS cover,
           min(NULLIF(artist_id, '')) AS artistId,
           sum(wins) AS wins,
           count(*) AS sourceCount,
           max(updated_at) AS updatedAt
         FROM cleaned
         GROUP BY lower(trim(title))
       )
       SELECT songId, title, artist, cover, artistId, wins, sourceCount, updatedAt
       FROM merged_songs
       WHERE ? = '' OR lower(title) LIKE ? OR lower(artist) LIKE ?
       ORDER BY wins DESC, title ASC
       LIMIT ?`
    )
      .bind(q, `%${q}%`, `%${q}%`, limit)
      .all();
    const latest = rows.results?.[0]?.updatedAt || null;
    const [songCount, participation] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(DISTINCT lower(trim(title))) AS c FROM song_wins"
      ).first(),
      getParticipationStatsCached(env),
    ]);
    return json({
      updatedAt: latest,
      totalWins: participation.songAll,
      songCount: Number(songCount?.c || 0),
      participation,
      items: rows.results || [],
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/artists")) {
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    let rows;
    if (q) {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM artist_wins WHERE lower(name) LIKE ?
         ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(`%${q}%`, limit)
        .all();
    } else {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM artist_wins ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(limit)
        .all();
    }
    const [songCount, artistCount, participation] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(DISTINCT lower(trim(title))) AS c FROM song_wins"
      ).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM artist_wins").first(),
      getParticipationStatsCached(env),
    ]);
    return json({
      updatedAt: rows.results?.[0]?.updatedAt || null,
      totalWins: participation.songAll,
      songCount: Number(songCount?.c || 0),
      artistCount: Number(artistCount?.c || 0),
      participation,
      items: rows.results || [],
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/stages")) {
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    const rows = await env.DB.prepare(
      `SELECT stage_id AS stageId, title, artist, cover, chapter, wins, updated_at AS updatedAt
       FROM stage_wins
       WHERE ? = '' OR lower(title) LIKE ? OR lower(artist) LIKE ?
       ORDER BY wins DESC, title ASC
       LIMIT ?`
    )
      .bind(q, `%${q}%`, `%${q}%`, limit)
      .all();
    const [stageCount, participation] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS c FROM stage_wins").first(),
      getParticipationStatsCached(env),
    ]);
    return json({
      updatedAt: rows.results?.[0]?.updatedAt || null,
      stageCount: Number(stageCount?.c || 0),
      participation,
      items: rows.results || [],
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/artists-pk")) {
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    let rows;
    if (q) {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM artist_pk_wins WHERE lower(name) LIKE ?
         ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(`%${q}%`, limit)
        .all();
    } else {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM artist_pk_wins ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(limit)
        .all();
    }
    const [songCount, artistPkCount, participation] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(DISTINCT lower(trim(title))) AS c FROM song_wins"
      ).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM artist_pk_wins").first(),
      getParticipationStatsCached(env),
    ]);
    return json({
      updatedAt: rows.results?.[0]?.updatedAt || null,
      totalWins: participation.songAll,
      songCount: Number(songCount?.c || 0),
      artistCount: Number(artistPkCount?.c || 0),
      participation,
      items: rows.results || [],
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/artists-weekly-hot")) {
    await ensureArtistActivityDaily(env);
    const days = lastNDaysUTC8(7);
    const placeholders = days.map(() => "?").join(",");
    const top = await env.DB.prepare(
      `SELECT artist_id AS artistId, MAX(name) AS name, MAX(avatar) AS avatar, SUM(wins) AS total
       FROM artist_activity_daily
       WHERE day IN (${placeholders})
       GROUP BY artist_id
       ORDER BY total DESC, name ASC
       LIMIT 5`
    )
      .bind(...days)
      .all();
    const artists = top.results || [];
    if (!artists.length) {
      return json({ days, artists: [], since: "2026-08-27" });
    }
    const ids = artists.map((a) => String(a.artistId));
    const idPh = ids.map(() => "?").join(",");
    const seriesRows = await env.DB.prepare(
      `SELECT day, artist_id AS artistId, wins, name, avatar
       FROM artist_activity_daily
       WHERE day IN (${placeholders}) AND artist_id IN (${idPh})`
    )
      .bind(...days, ...ids)
      .all();
    const byArtistDay = new Map();
    for (const row of seriesRows.results || []) {
      byArtistDay.set(`${row.artistId}|${row.day}`, Number(row.wins) || 0);
      const hit = artists.find((a) => String(a.artistId) === String(row.artistId));
      if (hit) {
        if (row.name) hit.name = row.name;
        if (row.avatar) hit.avatar = row.avatar;
      }
    }
    return json({
      days,
      since: "2026-08-27",
      artists: artists.map((a) => ({
        artistId: String(a.artistId),
        name: a.name || "未知歌手",
        avatar: a.avatar || "",
        total: Number(a.total) || 0,
        series: days.map((d) => byArtistDay.get(`${a.artistId}|${d}`) || 0),
      })),
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/duel-king")) {
    await ensureDuelKingTables(env);
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    let rows;
    if (q) {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM duel_king_wins WHERE lower(name) LIKE ?
         ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(`%${q}%`, limit)
        .all();
    } else {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM duel_king_wins ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(limit)
        .all();
    }
    const [songCount, duelCount, participation] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(DISTINCT lower(trim(title))) AS c FROM song_wins"
      ).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM duel_king_wins").first().catch(() => ({ c: 0 })),
      getParticipationStatsCached(env),
    ]);
    return json({
      updatedAt: rows.results?.[0]?.updatedAt || null,
      totalWins: Number(
        (
          await env.DB.prepare("SELECT COALESCE(SUM(wins), 0) AS t FROM duel_king_wins")
            .first()
            .catch(() => ({ t: 0 }))
        )?.t || 0
      ),
      songCount: Number(songCount?.c || 0),
      artistCount: Number(duelCount?.c || 0),
      participation,
      items: rows.results || [],
    });
  }

  const duelKingSongsMatch = path.match(/^\/api\/rank\/duel-king\/([^/]+)\/songs$/);
  if (request.method === "GET" && duelKingSongsMatch) {
    await ensureDuelKingTables(env);
    const artistId = decodeURIComponent(duelKingSongsMatch[1] || "").trim();
    if (!artistId) return json({ error: "bad artist id" }, 400);
    const self = await env.DB.prepare(
      `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
       FROM duel_king_wins WHERE artist_id = ?`
    )
      .bind(artistId)
      .first();
    const rows = await env.DB.prepare(
      `SELECT song_id AS songId, title, cover, wins, updated_at AS updatedAt
       FROM duel_king_songs
       WHERE artist_id = ?
       ORDER BY wins DESC, title ASC`
    )
      .bind(artistId)
      .all();
    return json({
      artist: self || { artistId, name: "", avatar: "", wins: 0 },
      items: rows.results || [],
    });
  }

  const labelMatchupsMatch = path.match(/^\/api\/rank\/labels\/([^/]+)\/matchups$/);
  if (request.method === "GET" && labelMatchupsMatch) {
    const labelId = decodeURIComponent(labelMatchupsMatch[1] || "").trim();
    if (!labelId) return json({ error: "bad label id" }, 400);
    const self = await env.DB.prepare(
      `SELECT label_id AS labelId, name, avatar, wins, battles, updated_at AS updatedAt
       FROM label_beef_stats WHERE label_id = ?`
    )
      .bind(labelId)
      .first();
    const [rows, champRows] = await Promise.all([
      env.DB.prepare(
        `SELECT
           m.opponent_id AS opponentId,
           COALESCE(NULLIF(s.name, ''), m.opponent_id) AS opponentName,
           m.wins AS wins,
           m.battles AS battles,
           m.updated_at AS updatedAt
         FROM label_beef_matchups m
         LEFT JOIN label_beef_stats s ON s.label_id = m.opponent_id
         WHERE m.label_id = ?
         ORDER BY
           CASE WHEN m.battles > 0 THEN (m.wins * 1.0 / m.battles) ELSE 0 END DESC,
           m.battles DESC,
           opponentName ASC`
      )
        .bind(labelId)
        .all(),
      env.DB.prepare(
        `SELECT
           opponent_id AS opponentId,
           song_id AS songId,
           title,
           artist,
           cover,
           wins
         FROM label_beef_champions
         WHERE label_id = ?
         ORDER BY wins DESC, title ASC`
      )
        .bind(labelId)
        .all(),
    ]);
    /** @type {Map<string, Array<{songId:string,title:string,artist:string,cover:string,wins:number}>>} */
    const champsByOpp = new Map();
    for (const c of champRows.results || []) {
      const oid = String(c.opponentId || "");
      if (!oid) continue;
      if (!champsByOpp.has(oid)) champsByOpp.set(oid, []);
      champsByOpp.get(oid).push({
        songId: String(c.songId || ""),
        title: String(c.title || ""),
        artist: String(c.artist || ""),
        cover: String(c.cover || ""),
        wins: Number(c.wins || 0),
      });
    }
    const items = (rows.results || []).map((r) => {
      const battles = Number(r.battles || 0);
      const wins = Number(r.wins || 0);
      const opponentId = String(r.opponentId || "");
      return {
        opponentId,
        opponentName: r.opponentName,
        wins,
        battles,
        winRate: battles > 0 ? wins / battles : 0,
        updatedAt: r.updatedAt || null,
        champions: champsByOpp.get(opponentId) || [],
      };
    });
    return json({
      labelId,
      name: self?.name || labelId,
      avatar: self?.avatar || "",
      wins: Number(self?.wins || 0),
      battles: Number(self?.battles || 0),
      winRate:
        Number(self?.battles || 0) > 0
          ? Number(self.wins || 0) / Number(self.battles || 0)
          : 0,
      items,
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/labels")) {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    let rows;
    if (q) {
      rows = await env.DB.prepare(
        `SELECT label_id AS labelId, name, avatar, wins, battles, updated_at AS updatedAt
         FROM label_beef_stats
         WHERE lower(name) LIKE ? OR lower(label_id) LIKE ?
         ORDER BY
           CASE WHEN battles > 0 THEN (wins * 1.0 / battles) ELSE 0 END DESC,
           battles DESC,
           name ASC
         LIMIT ?`
      )
        .bind(`%${q}%`, `%${q}%`, limit)
        .all();
    } else {
      rows = await env.DB.prepare(
        `SELECT label_id AS labelId, name, avatar, wins, battles, updated_at AS updatedAt
         FROM label_beef_stats
         ORDER BY
           CASE WHEN battles > 0 THEN (wins * 1.0 / battles) ELSE 0 END DESC,
           battles DESC,
           name ASC
         LIMIT ?`
      )
        .bind(limit)
        .all();
    }
    const [songCount, participation] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(DISTINCT lower(trim(title))) AS c FROM song_wins"
      ).first(),
      getParticipationStatsCached(env),
    ]);
    const items = (rows.results || []).map((r) => {
      const battles = Number(r.battles || 0);
      const wins = Number(r.wins || 0);
      return {
        labelId: r.labelId,
        name: r.name,
        avatar: r.avatar || "",
        wins,
        battles,
        winRate: battles > 0 ? wins / battles : 0,
        updatedAt: r.updatedAt || null,
      };
    });
    return json({
      updatedAt: items[0]?.updatedAt || null,
      totalWins: participation.songAll,
      songCount: Number(songCount?.c || 0),
      participation,
      items,
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/hangla")) {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    const [hangRows, laleRows, songCount, participation] = await Promise.all([
      env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, hang_wins AS wins, updated_at AS updatedAt
         FROM hangla_artist_stats
         WHERE hang_wins > 0
         ORDER BY hang_wins DESC, name ASC
         LIMIT ?`
      )
        .bind(limit)
        .all(),
      env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, lale_wins AS wins, updated_at AS updatedAt
         FROM hangla_artist_stats
         WHERE lale_wins > 0
         ORDER BY lale_wins DESC, name ASC
         LIMIT ?`
      )
        .bind(limit)
        .all(),
      env.DB.prepare(
        "SELECT COUNT(DISTINCT lower(trim(title))) AS c FROM song_wins"
      ).first(),
      getParticipationStatsCached(env),
    ]);
    const hang = hangRows.results || [];
    const lale = laleRows.results || [];
    const updatedAt =
      hang[0]?.updatedAt || lale[0]?.updatedAt || null;
    return json({
      updatedAt,
      totalWins: participation.songAll,
      songCount: Number(songCount?.c || 0),
      participation,
      hang,
      lale,
    });
  }

  if (request.method === "POST" && path.endsWith("/api/rank/hangla")) {
    const body = await request.json().catch(() => ({}));
    const hangList = Array.isArray(body.hang) ? body.hang : [];
    const laleList = Array.isArray(body.lale) ? body.lale : [];
    const now = new Date().toISOString();

    const normalizeEntries = (list, max) => {
      const out = [];
      const seen = new Set();
      for (const raw of list.slice(0, max)) {
        const artistId = clampStr(raw?.artistId || raw?.id, 64);
        if (!artistId || seen.has(artistId)) continue;
        seen.add(artistId);
        out.push({
          artistId,
          name: clampStr(raw?.name, 80) || artistId,
          avatar: clampStr(raw?.avatar, 500),
        });
      }
      return out;
    };

    // 夯最多 2；拉完了本场最多 15
    const hang = normalizeEntries(hangList, 2);
    const lale = normalizeEntries(laleList, 15);
    if (!hang.length && !lale.length) {
      return json({ ok: false, error: "empty hangla result" }, 400);
    }

    const day = dayKeyUTC8(new Date());
    const { cookieKey, ipKey, setCookie } = await resolveVoterIdentity(request);
    const quota = await consumeVoteQuotas(env, cookieKey, ipKey, day, now);
    if (!quota.counted) {
      const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
      if (setCookie) headers["Set-Cookie"] = setCookie;
      return new Response(
        JSON.stringify({
          ok: true,
          counted: false,
          reason: quota.reason || "daily_quota_exceeded",
          dailyLimit: DAILY_VOTE_LIMIT,
          ipDailyLimit: DAILY_IP_LIMIT,
          usedToday: quota.used,
          remainingToday: quota.remaining,
        }),
        { status: 200, headers }
      );
    }

    await bumpHanglaParticipation(env, now).catch(() => {});
    invalidateParticipationMemo();

    const hanglaStmts = [
      ...hang.map((a) =>
        env.DB.prepare(
          `INSERT INTO hangla_artist_stats (artist_id, name, avatar, hang_wins, lale_wins, updated_at)
           VALUES (?, ?, ?, 1, 0, ?)
           ON CONFLICT(artist_id) DO UPDATE SET
             name = excluded.name,
             avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE hangla_artist_stats.avatar END,
             hang_wins = hangla_artist_stats.hang_wins + 1,
             updated_at = excluded.updated_at`
        ).bind(a.artistId, a.name, a.avatar, now)
      ),
      ...lale.map((a) =>
        env.DB.prepare(
          `INSERT INTO hangla_artist_stats (artist_id, name, avatar, hang_wins, lale_wins, updated_at)
           VALUES (?, ?, ?, 0, 1, ?)
           ON CONFLICT(artist_id) DO UPDATE SET
             name = excluded.name,
             avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE hangla_artist_stats.avatar END,
             lale_wins = hangla_artist_stats.lale_wins + 1,
             updated_at = excluded.updated_at`
        ).bind(a.artistId, a.name, a.avatar, now)
      ),
    ];
    if (hanglaStmts.length) await env.DB.batch(hanglaStmts);

    const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
    if (setCookie) headers["Set-Cookie"] = setCookie;
    return new Response(
      JSON.stringify({
        ok: true,
        counted: true,
        hangCount: hang.length,
        laleCount: lale.length,
        dailyLimit: DAILY_VOTE_LIMIT,
        usedToday: quota.used,
        remainingToday: quota.remaining,
      }),
      { status: 200, headers }
    );
  }

  if (request.method === "POST" && path.endsWith("/api/rank/win")) {
    const body = await request.json().catch(() => ({}));
    const songId = clampStr(body.songId, 32);
    const artistId = clampStr(body.artistId, 32);
    const title = clampStr(body.title, 120);
    const cupType = clampStr(body.cupType, 32);
    const isLabelBeef = cupType === "label-beef";
    const isDreamFactory = cupType === "dream-factory";
    const isDuelKing = cupType === "duel-king";
    // Label beef / duel king: store roster artist on song rank; solo cups keep host artistName.
    const artist = isLabelBeef || isDuelKing
      ? clampStr(body.songArtist || body.artist || body.artistName, 120)
      : clampStr(body.artistName || body.artist, 120);
    const cover = clampStr(body.cover, 500);
    const avatar = clampStr(body.avatar, 500);
    const winnerLabelId = clampStr(body.winnerLabelId, 64);
    const winnerLabelName = clampStr(body.winnerLabelName, 80) || winnerLabelId;
    const loserLabelId = clampStr(body.loserLabelId, 64);
    const loserLabelName = clampStr(body.loserLabelName, 80) || loserLabelId;
    const chapter = clampStr(body.chapter, 32);
    const now = new Date().toISOString();

    if (isDreamFactory) {
      if (!songId || !title) {
        return json({ ok: false, error: "invalid stage" }, 400);
      }
    } else if (!/^\d+$/.test(songId) || !title) {
      return json({ ok: false, error: "invalid song" }, 400);
    }

    const day = dayKeyUTC8(new Date());
    const { cookieKey, ipKey, setCookie } = await resolveVoterIdentity(request);
    const quota = await consumeVoteQuotas(env, cookieKey, ipKey, day, now);
    if (!quota.counted) {
      const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
      if (setCookie) headers["Set-Cookie"] = setCookie;
      return new Response(
        JSON.stringify({
          ok: true,
          counted: false,
          reason: quota.reason || "daily_quota_exceeded",
          dailyLimit: DAILY_VOTE_LIMIT,
          ipDailyLimit: DAILY_IP_LIMIT,
          usedToday: quota.used,
          remainingToday: quota.remaining,
        }),
        { status: 200, headers }
      );
    }

    let artistWins = null;
    invalidateParticipationMemo();

    if (isDreamFactory) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO stage_wins (stage_id, title, artist, cover, chapter, wins, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(stage_id) DO UPDATE SET
             title = excluded.title,
             artist = excluded.artist,
             cover = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE stage_wins.cover END,
             chapter = CASE WHEN excluded.chapter != '' THEN excluded.chapter ELSE stage_wins.chapter END,
             wins = stage_wins.wins + 1,
             updated_at = excluded.updated_at`
        ).bind(songId, title, artist, cover, chapter, now),
      ]);
      const row = await env.DB.prepare("SELECT wins FROM stage_wins WHERE stage_id = ?")
        .bind(songId)
        .first();
      const stageWins = row?.wins ?? null;
      const totalRow = await env.DB.prepare(
        "SELECT COALESCE(SUM(wins), 0) AS t FROM stage_wins"
      ).first();
      const participantNo = Number(totalRow?.t || 0);
      const milestone =
        participantNo >= MILESTONE_STEP && participantNo % MILESTONE_STEP === 0;
      const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
      if (setCookie) headers["Set-Cookie"] = setCookie;
      return new Response(
        JSON.stringify({
          ok: true,
          counted: true,
          dailyLimit: DAILY_VOTE_LIMIT,
          ipDailyLimit: DAILY_IP_LIMIT,
          usedToday: quota.used,
          remainingToday: quota.remaining,
          songWins: stageWins,
          participantNo,
          milestone,
          milestoneStep: MILESTONE_STEP,
        }),
        { status: 200, headers }
      );
    }

    const winStmts = [
      env.DB.prepare(
        `INSERT INTO song_wins (song_id, title, artist, cover, artist_id, wins, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(song_id) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           cover = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE song_wins.cover END,
           artist_id = CASE WHEN excluded.artist_id != '' THEN excluded.artist_id ELSE song_wins.artist_id END,
           wins = song_wins.wins + 1,
           updated_at = excluded.updated_at`
      ).bind(songId, title, artist, cover, artistId || "", now),
    ];
    if (artistId && /^\d+$/.test(artistId)) {
      winStmts.push(
        env.DB.prepare(
          `INSERT INTO artist_wins (artist_id, name, avatar, wins, updated_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(artist_id) DO UPDATE SET
             name = excluded.name,
             avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE artist_wins.avatar END,
             wins = artist_wins.wins + 1,
             updated_at = excluded.updated_at`
        ).bind(artistId, artist || "未知歌手", avatar || cover, now)
      );
    }
    if (
      isLabelBeef &&
      winnerLabelId &&
      loserLabelId &&
      winnerLabelId !== loserLabelId
    ) {
      winStmts.push(
        ...labelBeefStatements(env, {
          winnerLabelId,
          winnerLabelName,
          loserLabelId,
          loserLabelName,
          avatar: avatar || cover,
          now,
          songId,
          title,
          artist,
          cover,
        })
      );
    }
    if (isDuelKing && artistId) {
      await ensureDuelKingTables(env);
      winStmts.push(
        ...duelKingStatements(env, {
          artistId,
          name: artist || "未知歌手",
          avatar: avatar || cover,
          songId,
          title,
          cover,
          now,
        })
      );
    }
    await env.DB.batch(winStmts);

    // 日热度：歌曲杯归属 / 单挑王 各计 1；厂牌混战不计歌手日热度
    if (!isLabelBeef && artistId && /^\d+$/.test(artistId)) {
      await bumpArtistActivityDaily(env, {
        day,
        artistId,
        name: artist || "未知歌手",
        avatar: avatar || cover,
        now,
      });
    }

    if (artistId && /^\d+$/.test(artistId)) {
      const row = await env.DB.prepare("SELECT wins FROM artist_wins WHERE artist_id = ?")
        .bind(artistId)
        .first();
      artistWins = row?.wins ?? null;
    }

    const song = await env.DB.prepare(
      "SELECT sum(wins) AS wins FROM song_wins WHERE lower(trim(title)) = lower(trim(?))"
    )
      .bind(title)
      .first();

    const totalRow = await env.DB.prepare(
      "SELECT COALESCE(SUM(wins), 0) AS t FROM song_wins"
    ).first();
    const participantNo = Number(totalRow?.t || 0);
    const milestone =
      participantNo >= MILESTONE_STEP && participantNo % MILESTONE_STEP === 0;

    const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
    if (setCookie) headers["Set-Cookie"] = setCookie;
    return new Response(
      JSON.stringify({
        ok: true,
        counted: true,
        dailyLimit: DAILY_VOTE_LIMIT,
        ipDailyLimit: DAILY_IP_LIMIT,
        usedToday: quota.used,
        remainingToday: quota.remaining,
        songWins: song?.wins || 1,
        artistWins,
        participantNo,
        milestone,
        milestoneStep: MILESTONE_STEP,
      }),
      { status: 200, headers }
    );
  }

  return json({ error: "not found" }, 404);
}

/** One finished label-beef cup: both +1 battle; winner +1 win; pairwise both ways. */
function labelBeefStatements(
  env,
  {
    winnerLabelId,
    winnerLabelName,
    loserLabelId,
    loserLabelName,
    avatar,
    now,
    songId,
    title,
    artist,
    cover,
  }
) {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO label_beef_stats (label_id, name, avatar, wins, battles, updated_at)
       VALUES (?, ?, ?, 1, 1, ?)
       ON CONFLICT(label_id) DO UPDATE SET
         name = excluded.name,
         avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE label_beef_stats.avatar END,
         wins = label_beef_stats.wins + 1,
         battles = label_beef_stats.battles + 1,
         updated_at = excluded.updated_at`
    ).bind(winnerLabelId, winnerLabelName || winnerLabelId, avatar || "", now),
    env.DB.prepare(
      `INSERT INTO label_beef_stats (label_id, name, avatar, wins, battles, updated_at)
       VALUES (?, ?, ?, 0, 1, ?)
       ON CONFLICT(label_id) DO UPDATE SET
         name = excluded.name,
         battles = label_beef_stats.battles + 1,
         updated_at = excluded.updated_at`
    ).bind(loserLabelId, loserLabelName || loserLabelId, "", now),
    env.DB.prepare(
      `INSERT INTO label_beef_matchups (label_id, opponent_id, wins, battles, updated_at)
       VALUES (?, ?, 1, 1, ?)
       ON CONFLICT(label_id, opponent_id) DO UPDATE SET
         wins = label_beef_matchups.wins + 1,
         battles = label_beef_matchups.battles + 1,
         updated_at = excluded.updated_at`
    ).bind(winnerLabelId, loserLabelId, now),
    env.DB.prepare(
      `INSERT INTO label_beef_matchups (label_id, opponent_id, wins, battles, updated_at)
       VALUES (?, ?, 0, 1, ?)
       ON CONFLICT(label_id, opponent_id) DO UPDATE SET
         battles = label_beef_matchups.battles + 1,
         updated_at = excluded.updated_at`
    ).bind(loserLabelId, winnerLabelId, now),
  ];
  if (songId && title) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO label_beef_champions
           (label_id, opponent_id, song_id, title, artist, cover, wins, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(label_id, opponent_id, song_id) DO UPDATE SET
           title = excluded.title,
           artist = CASE WHEN excluded.artist != '' THEN excluded.artist ELSE label_beef_champions.artist END,
           cover = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE label_beef_champions.cover END,
           wins = label_beef_champions.wins + 1,
           updated_at = excluded.updated_at`
      ).bind(
        winnerLabelId,
        loserLabelId,
        songId,
        title,
        artist || "",
        cover || "",
        now
      )
    );
  }
  return stmts;
}

/** 冷门歌手热门包 TTL：24 小时 */
const ARTIST_TOP_TTL_SEC = 60 * 60 * 24;

function neteaseCacheSpec(stripped, url) {
  const p = String(stripped || "").replace(/\/+$/, "");
  const path = p.startsWith("/") ? p : `/${p}`;
  if (path === "/song/url/v1" || path === "/song/url") {
    const id = String(url.searchParams.get("id") || "").trim();
    if (!id) return null;
    const level = String(url.searchParams.get("level") || "exhigh");
    return {
      key: `ne:url:v1:${id}:${level}`,
      ttl: SONG_URL_TTL_SEC,
      staleTtl: NETEASE_STALE_TTL_SEC,
    };
  }
  if (path === "/cloudsearch" || path === "/search") {
    const kw = String(url.searchParams.get("keywords") || "")
      .trim()
      .toLowerCase();
    if (!kw) return null;
    const type = String(url.searchParams.get("type") || "1");
    const limit = String(url.searchParams.get("limit") || "");
    return {
      key: `ne:search:v1:${type}:${kw}:${limit}`,
      ttl: NETEASE_SEARCH_TTL_SEC,
      staleTtl: NETEASE_STALE_TTL_SEC,
    };
  }
  if (path === "/artist/songs") {
    const id = String(url.searchParams.get("id") || "").trim();
    if (!/^\d+$/.test(id)) return null;
    const offset = String(url.searchParams.get("offset") || "0");
    const order = String(url.searchParams.get("order") || "hot");
    const limit = String(url.searchParams.get("limit") || "100");
    return {
      key: `ne:songs:v1:${id}:${order}:${offset}:${limit}`,
      ttl: NETEASE_SONGS_TTL_SEC,
      staleTtl: NETEASE_STALE_TTL_SEC,
    };
  }
  return null;
}

function neteaseJsonResponse(text, { cacheStatus = "HIT", stale = false, ttl = 60 } = {}) {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${Math.min(60, ttl)}`,
      "X-Netease-Cache": cacheStatus,
      ...(stale ? { "X-Cache-Stale": "1" } : {}),
      ...cors,
    },
  });
}

async function readNeteaseStale(env, key) {
  if (!env.ARTIST_TOP || !key) return null;
  try {
    return await env.ARTIST_TOP.get(key);
  } catch {
    return null;
  }
}

async function proxyNetease(request, env, url) {
  const origin = String(env.NETEASE_API_ORIGIN || "").replace(/\/+$/, "");
  if (!origin) {
    return json(
      {
        error: "NETEASE_API_ORIGIN not configured",
        hint: "Deploy api-enhanced somewhere, then set wrangler var / secret NETEASE_API_ORIGIN",
      },
      503
    );
  }

  const stripped = url.pathname.replace(/^\/api\/netease/, "") || "/";
  const target = new URL(stripped + url.search, origin + "/");
  const spec = request.method === "GET" ? neteaseCacheSpec(stripped, url) : null;

  if (spec) {
    try {
      const cache = caches.default;
      const hit = await cache.match(new Request(`https://ne-cache.heipaclub.internal/${spec.key}`));
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set("X-Netease-Cache", "HIT");
        Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
        return new Response(hit.body, { status: 200, headers });
      }
    } catch {
      /* ignore */
    }
  }

  // 冷门歌手热门榜：透传路径上的 KV 记忆（24h），避免反复打源站
  const topSongId = artistTopSongIdFromPath(stripped, url);
  if (request.method === "GET" && topSongId && env.ARTIST_TOP) {
    const cacheKey = `raw:top:v1:${topSongId}`;
    try {
      const hit = await env.ARTIST_TOP.get(cacheKey);
      if (hit) {
        return new Response(hit, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Artist-Top-Cache": "HIT",
            "X-Netease-Cache": "KV",
            "Cache-Control": "public, max-age=60",
            ...cors,
          },
        });
      }
    } catch {
      /* ignore cache read errors */
    }
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("content-length");

  const init = {
    method: request.method,
    headers,
    redirect: "follow",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      ...init,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    const stale = spec ? await readNeteaseStale(env, spec.key) : null;
    if (stale) return neteaseJsonResponse(stale, { cacheStatus: "STALE", stale: true, ttl: spec.ttl });
    if (topSongId && env.ARTIST_TOP) {
      const topStale = await readNeteaseStale(env, `raw:top:v1:${topSongId}`);
      if (topStale) {
        return new Response(topStale, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Artist-Top-Cache": "STALE",
            "X-Cache-Stale": "1",
            ...cors,
          },
        });
      }
    }
    noteFiveXx();
    return json({ error: "netease upstream timeout" }, 504);
  }

  if (!upstream.ok) {
    const stale = spec ? await readNeteaseStale(env, spec.key) : null;
    if (stale) return neteaseJsonResponse(stale, { cacheStatus: "STALE", stale: true, ttl: spec.ttl });
    if (topSongId && env.ARTIST_TOP) {
      const topStale = await readNeteaseStale(env, `raw:top:v1:${topSongId}`);
      if (topStale) {
        return new Response(topStale, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Artist-Top-Cache": "STALE",
            "X-Cache-Stale": "1",
            ...cors,
          },
        });
      }
    }
    if (upstream.status >= 500) noteFiveXx();
    const out = new Headers(upstream.headers);
    out.set("Access-Control-Allow-Origin", "*");
    out.set("X-Netease-Cache", "MISS");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  }

  if (
    request.method === "GET" &&
    topSongId &&
    env.ARTIST_TOP
  ) {
    try {
      const text = await upstream.text();
      const cacheKey = `raw:top:v1:${topSongId}`;
      await env.ARTIST_TOP.put(cacheKey, text, {
        expirationTtl: ARTIST_TOP_TTL_SEC,
      });
      return new Response(text, {
        status: 200,
        headers: {
          "Content-Type":
            upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
          "X-Artist-Top-Cache": "MISS",
          "Cache-Control": "public, max-age=60",
          ...cors,
        },
      });
    } catch {
      /* fall through */
    }
  }

  if (request.method === "GET" && spec) {
    try {
      const text = await upstream.text();
      if (env.ARTIST_TOP) {
        try {
          await env.ARTIST_TOP.put(spec.key, text, { expirationTtl: spec.staleTtl });
        } catch {
          /* ignore kv */
        }
      }
      const res = neteaseJsonResponse(text, { cacheStatus: "MISS", ttl: spec.ttl });
      try {
        await caches.default.put(
          new Request(`https://ne-cache.heipaclub.internal/${spec.key}`),
          res.clone()
        );
      } catch {
        /* ignore */
      }
      return res;
    } catch {
      /* fall through */
    }
  }

  const out = new Headers(upstream.headers);
  out.set("Access-Control-Allow-Origin", "*");
  out.set("X-Artist-Top-Cache", "BYPASS");
  out.set("X-Netease-Cache", "BYPASS");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

function artistTopSongIdFromPath(stripped, url) {
  const p = String(stripped || "").replace(/\/+$/, "");
  if (p !== "/artist/top/song" && p !== "artist/top/song") return "";
  const id = String(url.searchParams.get("id") || "").trim();
  return /^\d+$/.test(id) ? id : "";
}

function sanitizeCachedSong(s) {
  return {
    id: clampStr(s?.id || s?.neteaseId, 32),
    neteaseId: clampStr(s?.neteaseId || s?.id, 32),
    title: clampStr(s?.title, 120),
    artist: clampStr(s?.artist, 120),
    album: clampStr(s?.album || s?.collection, 120),
    collection: clampStr(s?.collection || s?.album, 120),
    cover: clampStr(s?.cover, 500),
    coverSm: clampStr(s?.coverSm || s?.cover, 500),
    duration_ms: Number.isFinite(Number(s?.duration_ms)) ? Number(s.duration_ms) : null,
    year: clampStr(s?.year, 8),
    publishTime: Number.isFinite(Number(s?.publishTime)) ? Number(s.publishTime) : null,
  };
}

async function handleArtistTopCache(request, env, path, url) {
  if (!env.ARTIST_TOP) {
    return json({ error: "KV binding ARTIST_TOP missing" }, 503);
  }

  if (request.method === "GET") {
    const id = clampStr(url.searchParams.get("id"), 32);
    if (!/^\d+$/.test(id)) return json({ ok: false, error: "bad id" }, 400);
    const pack = await env.ARTIST_TOP.get(`pack:v1:${id}`, "json");
    if (!pack?.songs?.length) {
      return json({ ok: false, hit: false }, 404);
    }
    return json({
      ok: true,
      hit: true,
      ttlSec: ARTIST_TOP_TTL_SEC,
      ...pack,
    });
  }

  if (request.method === "PUT" || request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = clampStr(body.neteaseArtistId || body.id, 32);
    const songsIn = Array.isArray(body.songs) ? body.songs : [];
    if (!/^\d+$/.test(id) || !songsIn.length) {
      return json({ ok: false, error: "invalid pack" }, 400);
    }
    const songs = songsIn
      .slice(0, 100)
      .map(sanitizeCachedSong)
      .filter((s) => /^\d+$/.test(s.id) && s.title);
    if (!songs.length) return json({ ok: false, error: "no songs" }, 400);

    const pack = {
      neteaseArtistId: id,
      name: clampStr(body.name, 120),
      avatar: clampStr(body.avatar, 500),
      songs,
      cachedAt: new Date().toISOString(),
    };
    await env.ARTIST_TOP.put(`pack:v1:${id}`, JSON.stringify(pack), {
      expirationTtl: ARTIST_TOP_TTL_SEC,
    });
    return json({ ok: true, ttlSec: ARTIST_TOP_TTL_SEC, songCount: songs.length });
  }

  return json({ error: "method not allowed" }, 405);
}

function isAllowedCoverHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return (
    h === "music.126.net" ||
    h.endsWith(".music.126.net") ||
    h.endsWith(".126.net") ||
    h === "mzstatic.com" ||
    h.endsWith(".mzstatic.com") ||
    h === "y.gtimg.cn" ||
    h.endsWith(".gtimg.cn")
  );
}

function isNeteaseCoverHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "music.126.net" || h.endsWith(".music.126.net") || h.endsWith(".126.net");
}

const IMG_ALLOWED_SIZES = new Set([
  48, 64, 96, 128, 160, 192, 200, 256, 320, 360, 400, 512, 640, 800,
]);

function normalizeCoverSize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.round(n);
  if (IMG_ALLOWED_SIZES.has(rounded)) return rounded;
  let best = 0;
  let bestDist = Infinity;
  for (const s of IMG_ALLOWED_SIZES) {
    const d = Math.abs(s - rounded);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** Resize NetEase thumbs and normalize query so cache keys stay stable. */
function parseNeteaseParamSize(target) {
  const m = String(target.searchParams.get("param") || "").match(/^(\d+)y(\d+)$/i);
  if (!m) return 0;
  return normalizeCoverSize(m[1]);
}

function normalizeUpstreamCoverUrl(target, size) {
  const host = target.hostname.toLowerCase();
  if (isNeteaseCoverHost(host)) {
    const dim = size || parseNeteaseParamSize(target) || 192;
    return `${target.origin}${target.pathname}?param=${dim}y${dim}`;
  }
  if (host.includes("mzstatic.com") && size) {
    return target
      .toString()
      .replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
  }
  return target.toString();
}

function upgradeCoverUrlToHttps(raw) {
  return String(raw || "").replace(/^http:/i, "https:");
}

async function coverIdentityKey(rawUrl) {
  try {
    const u = new URL(upgradeCoverUrlToHttps(rawUrl));
    const id = `${u.origin}${u.pathname}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    return `${IMG_KV_PREFIX}${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return "";
  }
}

function coverFetchHeaders() {
  return {
    Referer: "https://music.163.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  };
}

function fetchCoverUrl320(rawUrl) {
  try {
    const u = new URL(upgradeCoverUrlToHttps(rawUrl));
    if (isNeteaseCoverHost(u.hostname)) {
      return `${u.origin}${u.pathname}?param=320y320`;
    }
    if (u.hostname.toLowerCase().includes("mzstatic.com")) {
      return u.toString().replace(/\/\d+x\d+bb\./, "/320x320bb.");
    }
    return u.toString();
  } catch {
    return "";
  }
}

function imgPlaceholderResponse(reason = "placeholder") {
  return new Response(IMG_PLACEHOLDER_SVG, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=30",
      "X-Img-Cache": "PLACEHOLDER",
      "X-Img-Error": String(reason || "placeholder").slice(0, 80),
      ...cors,
    },
  });
}

function persistCoverToKv(env, ctx, key, bytes, ctype) {
  if (!env?.ARTIST_TOP || !key || !bytes) return;
  const job = env.ARTIST_TOP.put(key, bytes, {
    expirationTtl: IMG_KV_TTL_SEC,
    metadata: { ctype: ctype || "image/jpeg" },
  }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(job);
  return job;
}

async function buildImageEtag(upstreamUrl, size, ctype = "") {
  const src = `img:v2:${upstreamUrl}|s=${size || 0}|t=${ctype}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
  const bytes = Array.from(new Uint8Array(digest).slice(0, 12));
  const hex = bytes.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `W/"${hex}"`;
}

async function proxyCoverImage(request, url, env, ctx) {
  const raw = upgradeCoverUrlToHttps(url.searchParams.get("u") || "");
  let target;
  try {
    target = new URL(raw);
  } catch {
    return imgPlaceholderResponse("bad-url");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return imgPlaceholderResponse("bad-protocol");
  }
  if (target.protocol === "http:") {
    target = new URL(upgradeCoverUrlToHttps(target.toString()));
  }
  if (!isAllowedCoverHost(target.hostname)) {
    return imgPlaceholderResponse("host-not-allowed");
  }

  const requested = normalizeCoverSize(url.searchParams.get("s") || url.searchParams.get("size") || 0);
  const fromUrl = isNeteaseCoverHost(target.hostname) ? parseNeteaseParamSize(target) : 0;
  const size = requested || fromUrl || 0;
  const upstreamUrl = normalizeUpstreamCoverUrl(target, size);
  const reqEtag = String(request.headers.get("if-none-match") || "").trim();
  const kvKey = await coverIdentityKey(target.toString());

  if (env?.ARTIST_TOP && kvKey) {
    try {
      const got = await env.ARTIST_TOP.getWithMetadata(kvKey, { type: "arrayBuffer" });
      if (got?.value && got.value.byteLength) {
        const ctype = got.metadata?.ctype || "image/jpeg";
        const etag = await buildImageEtag(upstreamUrl, size, ctype);
        const headers = {
          "Content-Type": ctype.startsWith("image/") ? ctype : "image/jpeg",
          "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
          ETag: etag,
          "X-Img-Cache": "KV",
          ...cors,
        };
        if (reqEtag && reqEtag === etag) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(got.value, { status: 200, headers });
      }
    } catch {
      /* fall through */
    }
  }

  // Stable Worker Cache API key (normalized upstream + size), independent of client `u=` encoding.
  const cacheKey = new Request(
    `https://img-cache.heipaclub.internal/v1?u=${encodeURIComponent(upstreamUrl)}&s=${size || 0}`,
    { method: "GET" }
  );
  const staleKey = new Request(
    `https://img-cache.heipaclub.internal/stale/v1?u=${encodeURIComponent(upstreamUrl)}&s=${size || 0}`,
    { method: "GET" }
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    headers.set("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    headers.set("X-Img-Cache", "HIT");
    if (!headers.has("ETag")) {
      headers.set("ETag", await buildImageEtag(upstreamUrl, size, headers.get("Content-Type") || ""));
    }
    if (reqEtag && reqEtag === headers.get("ETag")) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(cached.body, { status: cached.status, headers });
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      cf: {
        cacheEverything: true,
        cacheTtl: 60 * 60 * 24 * 7,
        cacheTtlByStatus: { "200-299": 604800, "400-499": 60, "500-599": 0 },
      },
      headers: coverFetchHeaders(),
    });
  } catch {
    try {
      const stale = await cache.match(staleKey);
      if (stale) {
        const headers = new Headers(stale.headers);
        Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
        headers.set("X-Img-Cache", "STALE");
        headers.set("Cache-Control", "public, max-age=120, stale-while-revalidate=86400");
        return new Response(stale.body, { status: 200, headers });
      }
    } catch {
      /* ignore */
    }
    return imgPlaceholderResponse("origin-fetch");
  }

  if (!upstream.ok) {
    try {
      const stale = await cache.match(staleKey);
      if (stale) {
        const headers = new Headers(stale.headers);
        Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
        headers.set("X-Img-Cache", "STALE");
        headers.set("Cache-Control", "public, max-age=120, stale-while-revalidate=86400");
        return new Response(stale.body, { status: 200, headers });
      }
    } catch {
      /* ignore */
    }
    return imgPlaceholderResponse(`origin-${upstream.status}`);
  }

  const ctype = upstream.headers.get("Content-Type") || "image/jpeg";
  if (!ctype.startsWith("image/") && ctype !== "application/octet-stream") {
    return imgPlaceholderResponse("not-an-image");
  }

  const bytes = await upstream.arrayBuffer();
  if (!bytes.byteLength) return imgPlaceholderResponse("empty-body");

  const outCtype = ctype.startsWith("image/") ? ctype : "image/jpeg";
  persistCoverToKv(env, ctx, kvKey, bytes, outCtype);

  const etag = await buildImageEtag(upstreamUrl, size, ctype);
  const outHeaders = {
    "Content-Type": outCtype,
    "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
    ETag: etag,
    "X-Img-Cache": "MISS",
    ...cors,
  };
  if (reqEtag && reqEtag === etag) {
    return new Response(null, { status: 304, headers: outHeaders });
  }
  const response = new Response(bytes, {
    status: 200,
    headers: outHeaders,
  });

  try {
    await cache.put(cacheKey, response.clone());
    const staleHeaders = new Headers(response.headers);
    staleHeaders.set("Cache-Control", "public, max-age=2592000");
    await cache.put(staleKey, new Response(bytes, { status: 200, headers: staleHeaders }));
  } catch {
    /* Cache API may reject opaque/unsupported bodies — still return the image. */
  }

  return response;
}

async function warmVipCoverSlice(env) {
  if (!env?.ARTIST_TOP) return;
  let manifest;
  try {
    manifest = await env.ARTIST_TOP.get(IMG_MANIFEST_KEY, "json");
  } catch {
    return;
  }
  const urls = Array.isArray(manifest?.urls) ? manifest.urls : [];
  if (!urls.length) return;
  const cursor = Number(manifest.cursor || 0) % urls.length;
  let warmed = 0;
  let scanned = 0;
  while (warmed < IMG_WARM_BATCH && scanned < urls.length) {
    const idx = (cursor + scanned) % urls.length;
    scanned += 1;
    const raw = urls[idx];
    const key = await coverIdentityKey(raw);
    if (!key) continue;
    try {
      const existing = await env.ARTIST_TOP.get(key);
      if (existing) continue;
    } catch {
      continue;
    }
    const fetchUrl = fetchCoverUrl320(raw);
    if (!fetchUrl) continue;
    try {
      const res = await fetch(fetchUrl, { headers: coverFetchHeaders() });
      if (!res.ok) continue;
      const ctype = res.headers.get("Content-Type") || "image/jpeg";
      if (!ctype.startsWith("image/") && ctype !== "application/octet-stream") continue;
      const buf = await res.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 2_000_000) continue;
      await env.ARTIST_TOP.put(key, buf, {
        expirationTtl: IMG_KV_TTL_SEC,
        metadata: { ctype: ctype.startsWith("image/") ? ctype : "image/jpeg" },
      });
      warmed += 1;
    } catch {
      /* skip one cover */
    }
  }
  try {
    await env.ARTIST_TOP.put(
      IMG_MANIFEST_KEY,
      JSON.stringify({
        updatedAt: manifest.updatedAt || new Date().toISOString(),
        urls,
        cursor: (cursor + scanned) % urls.length,
        lastWarmAt: new Date().toISOString(),
        lastWarmCount: warmed,
      })
    );
  } catch {
    /* ignore manifest cursor update */
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/img" || path.startsWith("/api/img/")) {
      try {
        return await proxyCoverImage(request, url, env, ctx);
      } catch (e) {
        noteFiveXx();
        return imgPlaceholderResponse(e?.message || "img-throw");
      }
    }

    try {
      if (path === "/api/health") {
        return await handleHealth(env);
      }

      if (path === "/api/artist-top" || path.startsWith("/api/artist-top/")) {
        return await handleArtistTopCache(request, env, path, url);
      }

      if (path === "/api/metrics" || path.startsWith("/api/metrics/")) {
        if (!env.DB) {
          return json({ error: "D1 binding DB missing" }, 503);
        }
        return await handleMetrics(request, env, path, url);
      }

      if (path.startsWith("/api/rank")) {
        if (!env.DB) {
          return json({ error: "D1 binding DB missing" }, 503);
        }
        if (request.method === "GET") {
          const isWeeklyHot = path.endsWith("/api/rank/artists-weekly-hot");
          // 日热度近实时、体量小：跳过 KV/边缘空快照，直接打 D1
          if (isWeeklyHot) {
            return await handleRank(request, env, path, url);
          }

          // Always prefer any snapshot over blank/429. Never rate-limit cache hits.
          const snap = await tryServeRankSnapshot(env, path, url, { allowStale: true });
          if (snap) return snap;
          const edge = await tryServeRankEdgeCache(path, url);
          if (edge) return edge;

          const limited = rateLimitedResponse(request, "rank", RATE_LIMIT_RANK);
          if (limited) {
            const soft = await tryServeRankSnapshot(env, path, url, { allowStale: true });
            if (soft) return soft;
            return limited;
          }

          try {
            const produced = await cachedProducerResponse(
              `https://rank-cache.heipaclub.internal${path}?${url.searchParams}`,
              () => handleRank(request, env, path, url),
              RANK_CACHE_TTL_SEC,
              "X-Rank-Cache"
            );
            const kind = rankSnapshotKind(path);
            if (
              produced.ok &&
              kind &&
              env.ARTIST_TOP &&
              produced.headers.get("X-Rank-Cache") === "MISS"
            ) {
              const job = (async () => {
                try {
                  const text = await produced.clone().text();
                  await putRankSnapshots(env, kind, text);
                } catch {
                  /* ignore */
                }
              })();
              if (ctx?.waitUntil) ctx.waitUntil(job);
            }
            if (!produced.ok) {
              const soft = await tryServeRankSnapshot(env, path, url, { allowStale: true });
              if (soft) return soft;
            }
            return produced;
          } catch (e) {
            noteFiveXx();
            const soft = await tryServeRankSnapshot(env, path, url, { allowStale: true });
            if (soft) return soft;
            return json({ error: e.message || "rank unavailable" }, 503);
          }
        }
        return await handleRank(request, env, path, url);
      }

      if (path.startsWith("/api/netease")) {
        if (request.method === "GET") {
          const limited = rateLimitedResponse(request, "netease", RATE_LIMIT_NETEASE);
          if (limited) return limited;
        }
        return await proxyNetease(request, env, url);
      }

      // Dev convenience: /api/itunes → Apple (production client hits Apple directly)
      if (path.startsWith("/api/itunes")) {
        const stripped = path.replace(/^\/api\/itunes/, "") || "/";
        const target = new URL(stripped + url.search, "https://itunes.apple.com/");
        const upstream = await fetch(target.toString(), {
          headers: { Accept: "application/json" },
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "application/json",
            ...cors,
          },
        });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      noteFiveXx();
      return json({ error: e.message || "server error" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    // Rank snapshots first (game UX); covers are best-effort after.
    ctx.waitUntil(
      (async () => {
        await precomputeRankSnapshots(env);
        await warmVipCoverSlice(env);
      })()
    );
  },
};
