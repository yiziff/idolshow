import "./style.css";
import "./home-ins.css";
import {
  ARTISTS,
  getArtist,
} from "./data/artists.js";
import {
  bindImageFallback,
  coverUrl,
  IMAGE_SIZES,
  imgTag,
  optimizedImageUrl,
  sizedCoverUrl,
} from "./artwork.js";
import {
  enrichSongsPlaySourceProgressive,
  loadArtistCup as loadItunesArtistCup,
  pingApi as pingItunesApi,
  resolvePlaySource,
  searchArtist as searchItunesArtist,
} from "./itunes.js";
import { hasHotTopPack, loadHotTopPack } from "./hot-tops.js";
import { fetchArtistTopCache, putArtistTopCache } from "./artist-top-cache.js";
import {
  expandArtistPool,
  loadArtistCup,
  searchArtist as searchNeteaseArtist,
} from "./netease.js";
import { initPerfVitalsTracking, trackEvent } from "./metrics.js";
import { createPlayer, stopAllPageAudio } from "./player.js";
import {
  fetchArtistRank,
  fetchArtistsWeeklyHot,
  fetchRankMeta,
  fetchSongRank,
  fetchStageRank,
  markMilestoneShown,
  reportChampionWin,
} from "./rank-api.js";
import {
  filterArtistsByKind,
  filterRankItemsByKind,
  filterRankItemsByQuery,
  KIND_FILTERS,
  kindFilterMeta,
} from "./rank-filter.js";
import { mountHomeView } from "./home-view.js";
import { mountDreamFactoryView } from "./dream-factory-view.js";
import {
  buildBracket,
  buildField,
  chooseWinner,
  currentMatch,
  findRoundIndex,
  isRoundComplete,
  nearestFieldSize,
  pickSongs,
  podiumFromBracket,
  progressText,
  roundLabel,
  splashForBracket,
} from "./tournament.js";

const STORAGE_KEY = "idolshow:v1";
const TOP_N = 50;
const FIELD_MAX = 32;
const SITE_URL = "https://idolshow.local";
const CHAMP_DONATE_QR_SRC = "/donate-qr.png";
const CHAMP_DONATE_TIP_KEY = "idolshow:champ-donate-tip-day";
const CHAMP_DONATE_TIP_DELAY_MS = 1400;
const SHARE_CTA_LABEL = "分享对阵图";
let champDonateTipTimer = null;
const app = document.getElementById("app");
const artistCache = new Map();
const runtimeArtistCatalog = new Map();
const avatarFillInFlight = new Set();
const preloadedImageHrefs = new Set();
let shareCardModulePromise = null;
let qrCodeModulePromise = null;

function normArtistKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#（）()]/g, "");
}

/** iTunes 搜索命中 → 运行时歌手（可 hydrate / 办赛） */
function toRuntimeItunesArtist(hit) {
  const id = `itunes:${hit.id}`;
  const existing = runtimeArtistCatalog.get(id);
  if (existing) {
    if (!existing.avatar && hit.avatar) existing.avatar = hit.avatar;
    return existing;
  }
  const created = {
    id,
    name: hit.name,
    search: hit.name,
    city: "iTunes",
    tag: "iTunes 搜索",
    blurb: "来自 iTunes 官方搜索 · 热门曲目可办赛。",
    avatar: hit.avatar || "",
    fans: 0,
    source: "itunes",
    itunesArtistId: hit.id,
  };
  runtimeArtistCatalog.set(id, created);
  return created;
}

/** 本地名单优先，再并入 iTunes 搜索结果（去重按名）。 */
async function mergeLocalArtistsWithItunes(query, localList) {
  const q = String(query || "").trim();
  if (!q) return localList;
  try {
    const hits = await searchItunesArtist(q, { limit: 8, countries: ["kr", "jp", "us", "cn"] });
    if (!hits.length) return localList;
    const seen = new Set(localList.map((a) => normArtistKey(a.name || a.search)));
    const extra = [];
    for (const hit of hits) {
      const key = normArtistKey(hit.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      extra.push(toRuntimeItunesArtist(hit));
    }
    return [...localList, ...extra];
  } catch {
    return localList;
  }
}

function resolveRosterArtist(id) {
  return (
    getArtist(id) ||
    runtimeArtistCatalog.get(id) ||
    ARTISTS.find((a) => a.id === id) ||
    null
  );
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 支持者数据 — 核对微信赞赏留言后手动更新
 *
 * sponsorTicker: ¥20+ / 首页滚动致谢一周（until 到期日后删除）
 * permanent:     ¥20+ 永久墙（共建档），no 为第几位支持者，date 为赞赏日期
 * weekly:        ¥5  本周墙（7 天后手动移除），date 为赞赏日期
 */
const SUPPORTERS = {
  sponsorTicker: [],
  permanent: [],
  weekly: [],
};

function supporterNoLabel(no) {
  const n = Number(no);
  if (n === 1) return "🥇 第 1 位支持者";
  if (n === 2) return "🥈 第 2 位支持者";
  if (n === 3) return "🥉 第 3 位支持者";
  if (Number.isFinite(n) && n > 0) return `第 ${n} 位支持者`;
  return "";
}

function activeSponsorTickers() {
  const today = new Date().toISOString().slice(0, 10);
  return (SUPPORTERS.sponsorTicker || []).filter(
    (s) => s?.name && (!s.until || String(s.until) >= today)
  );
}

function getDonateTickerText() {
  return "大家可以点击支持运营，扫码 ¥5 / ¥20 支持网站持续运行 · 奶茶档留名一周 · 共建档永久上墙 + 首页致谢一周！！！";
}

function champDonateTipDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hasDismissedChampDonateTipToday() {
  try {
    return localStorage.getItem(CHAMP_DONATE_TIP_KEY) === champDonateTipDayKey();
  } catch (_) {
    return false;
  }
}

function markChampDonateTipDismissedToday() {
  try {
    localStorage.setItem(CHAMP_DONATE_TIP_KEY, champDonateTipDayKey());
  } catch (_) {}
}

function closeChampDonateTip() {
  if (champDonateTipTimer) {
    clearTimeout(champDonateTipTimer);
    champDonateTipTimer = null;
  }
  const tip = document.getElementById("champ-donate-tip");
  if (!tip) return;
  tip.classList.remove("is-on");
  setTimeout(() => tip.remove(), 220);
}

function showChampDonateTip() {
  if (document.getElementById("champ-donate-tip")) return;
  if (!document.querySelector(".champ.champ-cup")) return;

  const tip = document.createElement("div");
  tip.id = "champ-donate-tip";
  tip.className = "champ-donate-tip";
  tip.innerHTML = `
    <div class="champ-donate-tip-backdrop" data-champ-donate-close></div>
    <div class="champ-donate-tip-card" role="dialog" aria-modal="true" aria-labelledby="champ-donate-tip-title">
      <header class="champ-donate-tip-head">
        <h3 id="champ-donate-tip-title">👊 Respect！给服务器加点油</h3>
        <button type="button" class="champ-donate-tip-close" data-champ-donate-close aria-label="关闭">×</button>
      </header>
      <p class="champ-donate-tip-copy">为了给家人们做个好玩的 K-pop 专属小游戏，本站的所有开销都是我自掏腰包，纯靠“为爱发电”。现在流量越来越大，服务器急需升级才能保证大家顺畅访问。如果你玩得开心，欢迎赞助一瓶水钱，帮助网站持续运营下去，感谢支持！</p>
      <p class="champ-donate-tip-perk">🔥 福利放送：扫码赞助后有<button type="button" class="champ-donate-tip-perk-link" data-champ-open-support>特殊福利</button>哦</p>
      <figure class="champ-donate-tip-qr">
        <img src="${CHAMP_DONATE_QR_SRC}" alt="微信赞赏码" width="132" height="132" decoding="async" />
      </figure>
      <p class="champ-donate-tip-hint">微信扫一扫</p>
      <button type="button" class="champ-donate-tip-dismiss" data-champ-donate-close>先看看冠军</button>
    </div>
  `;
  document.body.appendChild(tip);

  const dismiss = () => {
    markChampDonateTipDismissedToday();
    closeChampDonateTip();
  };
  tip.querySelectorAll("[data-champ-donate-close]").forEach((node) => {
    node.addEventListener("click", dismiss);
  });
  tip.querySelector("[data-champ-open-support]")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    markChampDonateTipDismissedToday();
    closeChampDonateTip();
    openSupportSite({ scrollToPerks: true });
  });
  requestAnimationFrame(() => tip.classList.add("is-on"));
}

function maybeShowChampDonateTip() {
  closeChampDonateTip();
  if (hasDismissedChampDonateTipToday()) return;
  champDonateTipTimer = setTimeout(() => {
    champDonateTipTimer = null;
    showChampDonateTip();
  }, CHAMP_DONATE_TIP_DELAY_MS);
}

function getSponsorTickerText() {
  const sponsors = activeSponsorTickers();
  if (!sponsors.length) return "";
  return sponsors
    .map((s) => {
      const amt = s.amount ? `（${s.amount}）` : "";
      return `感谢 @${s.name}${amt} 支持本站运营 ♥`;
    })
    .join("　　");
}

function renderSponsorTickerHtml({ variant = "" } = {}) {
  const text = getSponsorTickerText();
  if (!text) return "";
  const safe = esc(text);
  const cls = variant ? `sponsor-ticker sponsor-ticker--${variant}` : "sponsor-ticker";
  return `
    <div class="${cls}" role="marquee" aria-label="支持者致谢">
      <span class="sponsor-ticker-track">
        <span class="sponsor-ticker-text">${safe}</span>
        <span class="sponsor-ticker-text" aria-hidden="true">${safe}</span>
      </span>
    </div>`;
}

function renderSupporterCard(s, { showNo = false, showAmount = false } = {}) {
  const rank = showNo && s.no ? supporterNoLabel(s.no) : "";
  const msg = String(s.message || "").trim();
  return `<li class="about-site-supporter-card">
    ${rank ? `<div class="about-site-supporter-rank">${esc(rank)}</div>` : ""}
    <div class="about-site-supporter-card-head">
      <span class="about-site-supporter-name">${esc(s.name)}</span>
      ${showAmount && s.amount ? `<span class="about-site-supporter-amt">${esc(s.amount)}</span>` : ""}
    </div>
    ${msg ? `<p class="about-site-supporter-msg">「${esc(msg)}」</p>` : ""}
  </li>`;
}

function renderSupportersWallHtml({ showAmount = false } = {}) {
  const permanent = SUPPORTERS.permanent || [];
  const weekly = SUPPORTERS.weekly || [];
  const empty =
    !permanent.length && !weekly.length
      ? `<p class="about-site-supporters-empty">暂无上榜 · 扫码赞赏，留言格式：你的昵称和想说的一段话！</p>`
      : "";

  const permanentBlock = permanent.length
    ? `<div class="about-site-supporters-block">
        <h3 class="about-site-supporters-subtitle">永久支持者</h3>
        <ul class="about-site-supporters-cards">${permanent
          .map((s) => renderSupporterCard(s, { showNo: true, showAmount }))
          .join("")}</ul>
      </div>`
    : "";

  const weeklyBlock = weekly.length
    ? `<div class="about-site-supporters-block">
        <h3 class="about-site-supporters-subtitle">本周支持者</h3>
        <ul class="about-site-supporters-cards">${weekly
          .map((s) => renderSupporterCard(s, { showAmount }))
          .join("")}</ul>
      </div>`
    : "";

  return empty || `${permanentBlock}${weeklyBlock}`;
}

function parseDonateAmount(amount) {
  const n = parseFloat(String(amount ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function getAllSupporters() {
  const permanent = (SUPPORTERS.permanent || []).map((s) => ({ ...s, tier: "permanent" }));
  const weekly = (SUPPORTERS.weekly || []).map((s) => ({ ...s, tier: "weekly" }));
  return [...permanent, ...weekly];
}

function sortSupporters(list, mode = "amount") {
  const copy = [...list];
  if (mode === "time") {
    return copy.sort((a, b) => {
      const da = String(a.date || "");
      const db = String(b.date || "");
      if (da && db) return db.localeCompare(da);
      if (db) return 1;
      if (da) return -1;
      return (a.no || 999) - (b.no || 999);
    });
  }
  return copy.sort((a, b) => {
    const diff = parseDonateAmount(b.amount) - parseDonateAmount(a.amount);
    if (diff !== 0) return diff;
    return (a.no || 999) - (b.no || 999);
  });
}

function getTopSupporters(n = 5) {
  return sortSupporters(getAllSupporters(), "amount").slice(0, n);
}

function homeDonateWallRankLabel(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return String(index + 1);
}

function renderHomeDonateWallItemsHtml(list) {
  return list
    .map(
      (s, i) => `<li class="home-donate-wall-item">
      <span class="home-donate-wall-rank" aria-hidden="true">${homeDonateWallRankLabel(i)}</span>
      <span class="home-donate-wall-name">${esc(s.name)}</span>
      <span class="home-donate-wall-amt">${esc(s.amount || "")}</span>
    </li>`
    )
    .join("");
}

function renderHomeDonateWallHtml() {
  const allCount = getAllSupporters().length;
  const top5 = getTopSupporters(5);
  const hasSupporters = top5.length > 0;
  const canExpand = allCount > 5;
  const listHtml = hasSupporters
    ? renderHomeDonateWallItemsHtml(top5)
    : `<li class="home-donate-wall-empty">
      <button type="button" class="home-donate-wall-placeholder" data-home-donate-placeholder>期待你的名字 · 扫码支持</button>
    </li>`;

  return `
    <aside class="home-donate-wall" aria-label="赞赏墙" data-home-donate-wall>
      <div class="home-donate-wall-head">
        <span class="home-donate-wall-title">赞赏墙</span>
        ${
          canExpand
            ? `<button type="button" class="home-donate-wall-expand" data-toggle-donate-wall>展开</button>`
            : ""
        }
      </div>
      <ol class="home-donate-wall-list" data-home-donate-list>${listHtml}</ol>
    </aside>`;
}

function renderDonateWallModalListHtml(sortMode = "amount") {
  const sorted = sortSupporters(getAllSupporters(), sortMode);
  if (!sorted.length) {
    return `<p class="donate-wall-modal-empty">暂无上榜 · 扫码赞赏，留言格式：你的昵称和想说的一段话！</p>`;
  }
  return `<ol class="donate-wall-modal-list">${sorted
    .map((s, i) => {
      const msg = String(s.message || "").trim();
      const tierLabel = s.tier === "permanent" ? "永久" : "本周";
      return `<li class="donate-wall-modal-item">
      <div class="donate-wall-modal-item-head">
        <span class="donate-wall-modal-rank">${i + 1}</span>
        <span class="donate-wall-modal-name">${esc(s.name)}</span>
        <span class="donate-wall-modal-tier">${tierLabel}</span>
        ${s.amount ? `<span class="donate-wall-modal-amt">${esc(s.amount)}</span>` : ""}
      </div>
      ${msg ? `<p class="donate-wall-modal-msg">「${esc(msg)}」</p>` : ""}
    </li>`;
    })
    .join("")}</ol>`;
}

function openDonateWallModal() {
  const existing = document.getElementById("donate-wall-modal");
  if (existing) existing.remove();

  let sortMode = "amount";
  const el = document.createElement("div");
  el.id = "donate-wall-modal";
  el.className = "donate-wall-modal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "donate-wall-modal-title");
  el.innerHTML = `
    <div class="donate-wall-modal-backdrop" data-donate-wall-close></div>
    <div class="donate-wall-modal-panel">
      <header class="donate-wall-modal-head">
        <h2 id="donate-wall-modal-title">支持者留言墙</h2>
        <button type="button" class="donate-wall-modal-close" data-donate-wall-close aria-label="关闭">×</button>
      </header>
      <div class="donate-wall-modal-sort" role="group" aria-label="排序方式">
        <button type="button" class="donate-wall-sort-chip active" data-donate-wall-sort="amount">按金额</button>
        <button type="button" class="donate-wall-sort-chip" data-donate-wall-sort="time">按时间</button>
      </div>
      <div class="donate-wall-modal-body">
        <div class="donate-wall-modal-body-list"></div>
        <p class="donate-wall-modal-note">名单由作者根据赞赏留言手动更新</p>
      </div>
      <div class="donate-wall-modal-actions">
        <button type="button" class="donate-wall-modal-support" data-donate-wall-support>我也要支持</button>
        <button type="button" class="donate-wall-modal-done" data-donate-wall-close>关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const renderList = () => {
    const listEl = el.querySelector(".donate-wall-modal-body-list");
    if (listEl) listEl.innerHTML = renderDonateWallModalListHtml(sortMode);
    el.querySelectorAll("[data-donate-wall-sort]").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.donateWallSort === sortMode);
    });
  };

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };

  el.querySelectorAll("[data-donate-wall-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  el.querySelectorAll("[data-donate-wall-sort]").forEach((chip) => {
    chip.addEventListener("click", () => {
      sortMode = chip.dataset.donateWallSort || "amount";
      renderList();
    });
  });
  el.querySelector("[data-donate-wall-support]")?.addEventListener("click", () => {
    close();
    setTimeout(() => {
      openSupportSite();
    }, 200);
  });

  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
  renderList();
}

function getShareCardModule() {
  if (!shareCardModulePromise) {
    shareCardModulePromise = import("./share-card.js");
  }
  return shareCardModulePromise;
}

function getQrCodeModule() {
  if (!qrCodeModulePromise) {
    qrCodeModulePromise = import("qrcode");
  }
  return qrCodeModulePromise;
}

function ensureImagePreload(src, size, fetchPriority = "high") {
  const href = optimizedImageUrl(src, { size, proxy: "netease" });
  if (!href || preloadedImageHrefs.has(href)) return;
  preloadedImageHrefs.add(href);
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "image";
  link.href = href;
  if (fetchPriority === "high" || fetchPriority === "low") {
    link.setAttribute("fetchpriority", fetchPriority);
  }
  document.head.appendChild(link);
}

/** Warm both LQIP thumb + display size for a match cover. */
function preloadMatchCover(src, { priority = "high" } = {}) {
  if (!src) return;
  ensureImagePreload(src, IMAGE_SIZES.list, priority);
  ensureImagePreload(src, IMAGE_SIZES.match, priority);
}

/** After current pick, peek both outcomes and warm the next match covers. */
function prefetchUpcomingMatchCovers(state, match, avatar) {
  if (!match?.id) return;
  for (const side of ["a", "b"]) {
    try {
      const nextBracket = chooseWinner(state.bracket, match.id, side);
      const next = currentMatch(nextBracket);
      if (!next?.a || !next?.b) continue;
      preloadMatchCover(coverUrl(next.a, avatar), { priority: "low" });
      preloadMatchCover(coverUrl(next.b, avatar), { priority: "low" });
    } catch {
      /* ignore peek failures */
    }
  }
}

/**
 * Yield one frame before heavy sync work so clicks/typing paint first.
 */
function runAfterNextPaint(task) {
  requestAnimationFrame(() => {
    setTimeout(task, 0);
  });
}

function progressivePickCover(song, fallback) {
  const raw = coverUrl(song, fallback);
  if (!raw) {
    return `<div class="pick-cover img-fallback" aria-hidden="true"></div>`;
  }
  const thumb = optimizedImageUrl(raw, { size: IMAGE_SIZES.list });
  const full = optimizedImageUrl(raw, { size: IMAGE_SIZES.match });
  const direct = sizedCoverUrl(raw, IMAGE_SIZES.match);
  const directAttr =
    direct && direct !== thumb ? ` data-direct-src="${esc(direct)}"` : "";
  return `<img class="pick-cover" src="${esc(thumb)}" data-full-src="${esc(
    full
  )}"${directAttr} alt="${esc(song?.title || "")}" loading="eager" fetchpriority="high" decoding="async" referrerpolicy="no-referrer" width="320" height="320" onerror="window.__heipaImgError&&window.__heipaImgError(this)" />`;
}

function upgradeProgressiveCovers(root = document) {
  root.querySelectorAll("img.pick-cover[data-full-src]").forEach((img) => {
    const full = img.getAttribute("data-full-src");
    if (!full || img.dataset.upgraded === "1") return;
    const hi = new Image();
    hi.decoding = "async";
    hi.fetchPriority = "high";
    hi.onload = () => {
      if (!img.isConnected) return;
      img.src = full;
      img.removeAttribute("data-full-src");
      img.dataset.upgraded = "1";
    };
    hi.onerror = () => {
      img.removeAttribute("data-full-src");
      // keep current thumb; do not clear src
    };
    hi.src = full;
  });
}

app?.addEventListener("click", (e) => {
  const about = e.target.closest("[data-about-site]");
  if (about) {
    e.preventDefault();
    trackEvent("about_open");
    openAboutSite();
    return;
  }
  const support = e.target.closest("[data-support-site]");
  if (support) {
    e.preventDefault();
    trackEvent("support_open");
    openSupportSite();
    return;
  }
  const messageWall = e.target.closest("[data-message-wall]");
  if (messageWall) {
    e.preventDefault();
    openMessageWall();
  }
});

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY);
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  return { parts, hash };
}

function navigate(path) {
  location.hash = path;
}

/** Only show SEO guide on home (and /guide which opens home + modal). */
function syncSeoGuideVisibility(parts) {
  const guide = document.getElementById("seo-guide");
  if (!guide) return;
  const home = !parts?.[0] || parts[0] === "guide";
  guide.hidden = !home;
}

function ensureLoadBanner() {
  if (document.getElementById("heipa-load-banner")) return;
  const el = document.createElement("div");
  el.id = "heipa-load-banner";
  el.className = "heipa-load-banner";
  el.innerHTML = `
    <p>当前访问高峰，排行榜 / 试听可能延迟 10–30 秒，对决选边不受影响。</p>
    <button type="button" class="heipa-load-banner-close" aria-label="关闭">×</button>`;
  document.body.prepend(el);
  el.querySelector(".heipa-load-banner-close")?.addEventListener("click", () => {
    el.classList.remove("is-on");
  });
}

function showLoadBanner() {
  ensureLoadBanner();
  document.getElementById("heipa-load-banner")?.classList.add("is-on");
}

async function bootstrap() {
  initPerfVitalsTracking();
  fetch("/api/health", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d?.load === "high") showLoadBanner();
    })
    .catch(() => {});
  // Soft-fill home avatars in background after first paint
  render();
  softFillAvatars();
}

function render() {
  stopAllPageAudio();
  const { parts } = route();
  if (parts[0] !== "champ") {
    closeChampDonateTip();
  }
  const saved = loadState();
  syncSeoGuideVisibility(parts);

  if (parts[0] === "rank") {
    const tab =
      parts[1] === "artists"
        ? "artists"
        : parts[1] === "stages"
          ? "stages"
          : "songs";
    renderRank(tab);
    return;
  }
  if (parts[0] === "bracket" && saved?.bracket && !saved.bracket.champion) {
    renderBracketPreview(saved);
    return;
  }
  if (parts[0] === "play" && saved?.bracket && !saved.bracket.champion) {
    renderMatch(saved);
    return;
  }
  if (parts[0] === "champ" && saved?.bracket?.champion) {
    renderChamp(saved);
    return;
  }
  if (parts[0] === "artist" && parts[1]) {
    renderSetup(parts[1]);
    return;
  }
  if (parts[0] === "dream-factory") {
    renderDreamFactory();
    return;
  }
  if (parts[0] === "hangla" || parts[0] === "label-beef" || parts[0] === "duel-king") {
    renderHome();
    return;
  }
  if (parts[0] === "guide") {
    renderHome();
    return;
  }
  renderHome();
}

function shell(inner, { back, actions = "", wide = false, underBrand = "", sponsorTicker = true } = {}) {
  const topTicker = sponsorTicker ? renderSponsorTickerHtml({ variant: "match" }) : "";
  return `
    <div class="shell ${wide ? "shell-wide" : ""}">
      ${topTicker}
      <header class="topbar">
        <div class="topbar-brand-col">
          <a class="brand" href="#/" aria-label="Idol 巅峰对决首页">
            <div class="brand-mark"><span class="bm-a">Idol</span><span class="bm-b">巅峰对决</span></div>
          </a>
          ${underBrand}
        </div>
        <div class="topbar-actions">
          ${actions}
          ${
            back
              ? `<button type="button" class="ghost-btn" data-back="${back}">${back === "/" ? "回首页" : "返回"}</button>`
              : `<a class="ghost-btn" href="#/rank">排行榜</a>`
          }
        </div>
      </header>
      ${inner}
    </div>
  `;
}

function bindBack() {
  app.querySelectorAll("[data-back]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.back));
  });
}

function openAboutSite() {
  const existing = document.getElementById("about-site");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "about-site";
  el.className = "about-site";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "about-site-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-about-close></div>
    <div class="about-site-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">Idol</span>
          </div>
          <h2 id="about-site-title">关于本站</h2>
        </div>
        <button type="button" class="about-site-close" data-about-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <p>大家好！我是一名大四在读学生，非常喜欢内娱偶像与选秀文化。偶像练习生的大厂回忆、神级舞台和小红书上的名场面讨论，让我想做一个专属的内娱偶像对决站。</p>
        <p>对偶练与大厂的热爱让我做出了 IdolShow，希望这游戏也能给你带来一点快乐，选出你心中的本命曲和本命舞台！</p>
        <div class="about-site-section-label">作者账号</div>
        <div class="about-site-links">
          <a class="about-site-link-card" href="https://github.com/yiziff/idolshow" target="_blank" rel="noopener noreferrer">
            <span class="about-site-link-ico" aria-hidden="true">GH</span>
            <span class="about-site-link-copy">
              <strong>GitHub</strong>
              <em>yiziff/idolshow</em>
            </span>
          </a>
          <a class="about-site-link-card" href="https://v.douyin.com/Fe6sWPXT4MM/" target="_blank" rel="noopener noreferrer">
            <span class="about-site-link-ico" aria-hidden="true">抖</span>
            <span class="about-site-link-copy">
              <strong>抖音</strong>
              <em>打开主页</em>
            </span>
          </a>
          <a class="about-site-link-card" href="https://xhslink.cn/m/8hif4VUVuec" target="_blank" rel="noopener noreferrer">
            <span class="about-site-link-ico" aria-hidden="true">红</span>
            <span class="about-site-link-copy">
              <strong>小红书</strong>
              <em>感谢朋友的宣发帮助</em>
            </span>
          </a>
        </div>
        <p class="about-site-footnote">
          特别鸣谢：<a href="https://musiccup.app" target="_blank" rel="noopener noreferrer">MusicCup.app</a>
        </p>
      </div>
      <button type="button" class="about-site-done" data-about-close>关闭</button>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  el.querySelectorAll("[data-about-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
}

function openMessageWall() {
  const existing = document.getElementById("message-wall");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "message-wall";
  el.className = "about-site";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "message-wall-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-message-wall-close></div>
    <div class="about-site-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">Idol</span>
          </div>
          <h2 id="message-wall-title">支持者留言墙</h2>
        </div>
        <button type="button" class="about-site-close" data-message-wall-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <div class="about-site-supporters">
          ${renderSupportersWallHtml({ showAmount: false })}
          <p class="about-site-supporters-note">名单由作者根据赞赏留言手动更新 · 永久墙与本周墙分开展示，感谢每一位支持者 🙏</p>
        </div>
      </div>
      <div class="message-wall-actions">
        <button type="button" class="about-site-done message-wall-support" data-message-wall-support>我也要支持</button>
        <button type="button" class="about-site-done" data-message-wall-close>关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  el.querySelectorAll("[data-message-wall-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  el.querySelector("[data-message-wall-support]")?.addEventListener("click", () => {
    close();
    setTimeout(() => openSupportSite(), 200);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
}

function openSupportSite(opts = {}) {
  const existing = document.getElementById("support-site");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "support-site";
  el.className = "about-site";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "support-site-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-support-close></div>
    <div class="about-site-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">Idol</span>
          </div>
          <h2 id="support-site-title">👊 Respect！给服务器加点油</h2>
        </div>
        <button type="button" class="about-site-close" data-support-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <div class="about-site-donate">
          <p class="about-site-donate-copy">为了给家人们做个好玩的 K-pop 专属小游戏，本站的所有开销都是我自掏腰包，纯靠“为爱发电”。现在流量越来越大，服务器急需升级才能保证大家顺畅访问。如果你玩得开心，欢迎赞助一瓶水钱，帮助网站持续运营下去，感谢支持！</p>
          <p class="about-site-donate-perk-tip">🔥 福利放送：扫码赞助后有<button type="button" class="about-site-perk-link" data-support-scroll-perks>特殊福利</button>哦</p>
          <ul class="about-site-tiers" id="support-site-perks">
            <li class="about-site-tier">
              <div class="about-site-tier-head"><strong>奶茶档</strong><span class="about-site-tier-price">¥5</span></div>
              <p>本周支持者墙留名 7 天 · 显示昵称 + 你的留言</p>
            </li>
            <li class="about-site-tier about-site-tier--featured">
              <div class="about-site-tier-head"><strong>共建档</strong><span class="about-site-tier-price">¥20+</span></div>
              <p>永久支持者墙 + 首页滚动致谢一周 · 昵称 + 留言 · 获得「第 N 位支持者」编号 · 例：感谢 @你的昵称 支持本站运营 ♥</p>
            </li>
          </ul>
          <ol class="about-site-donate-steps">
            <li>微信扫一扫下方赞赏码，按档位选择 <strong>¥5 / ¥20+</strong></li>
            <li><strong>留言格式：</strong><span class="about-site-key-highlight">你的昵称和想说的一段话！</span></li>
            <li>勾选<span class="about-site-key-highlight">「向对方展示我的名字」</span>，方便核对</li>
            <li>留言后 1–3 天内我会核对并更新上墙 / 首页致谢</li>
          </ol>
          <img class="about-site-donate-qr" src="/donate-qr.png" width="220" height="220" alt="微信赞赏码" loading="lazy" decoding="async" />
          <p class="about-site-donate-hint">微信扫一扫 · 赞赏码 · 记得留言昵称和想说的话</p>
        </div>
        <div class="about-site-section-label">支持者留言墙</div>
        <div class="about-site-supporters">
          ${renderSupportersWallHtml()}
          <p class="about-site-supporters-note">名单由作者根据赞赏留言手动更新 · 永久墙与本周墙分开展示，感谢每一位支持者 🙏</p>
        </div>
      </div>
      <button type="button" class="about-site-done" data-support-close>关闭</button>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const body = el.querySelector(".about-site-body");
  const scrollToPerks = () => {
    const perks = el.querySelector("#support-site-perks");
    if (!perks || !body) return;
    perks.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  el.querySelector("[data-support-scroll-perks]")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    scrollToPerks();
  });
  if (opts.scrollToPerks) {
    requestAnimationFrame(() => setTimeout(scrollToPerks, 280));
  }

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  el.querySelectorAll("[data-support-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
}

function openPlayGuide() {
  const existing = document.getElementById("play-guide");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "play-guide";
  el.className = "about-site play-guide";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "play-guide-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-guide-close></div>
    <div class="about-site-panel play-guide-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">Idol</span>
          </div>
          <h2 id="play-guide-title">玩法指南</h2>
        </div>
        <button type="button" class="about-site-close" data-guide-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <p>
          <strong>Idol 巅峰对决</strong>专注内娱偶像：
          单曲 1v1 淘汰、团体大比拼、歌手 PK，选出你心中的本命曲与本命团。
        </p>
        <div class="about-site-section-label">单曲巅峰对决</div>
        <p>
          选团体开赛，热门单曲或自定义歌单均可。每轮两首对决，决出冠军后计入排行榜——用耳朵投出本命曲。
        </p>
        <div class="about-site-section-label">歌手大比拼</div>
        <p>
          按代际筛选后随机抽最多 32 个团体两两 PK，规则与单曲淘汰赛相同，冠军计入歌手 PK 榜。
        </p>
        <div class="about-site-section-label">排行榜与防刷</div>
        <p>
          冠军匿名累计进榜。战绩已开启防刷：每人每天最多计入 5 次有效评选。
        </p>
        <p class="about-site-footnote">
          想了解作者故事？
          <button type="button" class="about-inline-link" data-open-about>关于本站</button>
        </p>
      </div>
      <button type="button" class="about-site-done" data-guide-close>知道了</button>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
    if ((location.hash.replace(/^#/, "") || "/") === "/guide") {
      history.replaceState(null, "", "#/");
    }
  };
  el.querySelectorAll("[data-guide-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  el.querySelector("[data-open-about]")?.addEventListener("click", () => {
    close();
    setTimeout(() => openAboutSite(), 180);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
}

async function softFillAvatars() {
  const noAvatar = ARTISTS.filter((a) => !a.avatar);
  if (!noAvatar.length) return;
  let cursor = 0;
  const workers = Math.min(6, noAvatar.length);
  async function worker() {
    while (cursor < noAvatar.length) {
      const idx = cursor++;
      await fillAvatarForArtist(noAvatar[idx]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

function patchAvatarDom(artist) {
  const node = app.querySelector(`[data-artist="${artist.id}"] .artist-avatar, [data-artist="${artist.id}"] .img-fallback`);
  if (!node || !artist.avatar || location.hash.replace(/^#/, "") !== "/") return;
  const cards = app.querySelectorAll(".artist-card[data-artist]");
  let idx = -1;
  cards.forEach((card, i) => {
    if (card.dataset.artist === artist.id) idx = i;
  });
  const eager = idx >= 0 && idx < 4;
  const img = document.createElement("img");
  img.className = "artist-avatar";
  img.src = optimizedImageUrl(artist.avatar, { size: IMAGE_SIZES.avatar });
  img.alt = artist.name;
  img.loading = eager ? "eager" : "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.dataset.directSrc = sizedCoverUrl(artist.avatar, IMAGE_SIZES.avatar);
  if (eager && idx < 2) img.fetchPriority = "high";
  img.width = 96;
  img.height = 96;
  bindImageFallback(img);
  node.replaceWith(img);
}

function pickArtistAvatar(base, fallback = "") {
  if (base?.avatar && String(base.avatar).includes("music.126.net")) return base.avatar;
  return fallback || base?.avatar || "";
}

async function fillAvatarForArtist(artist) {
  if (!artist || artist.avatar) return;
  if (avatarFillInFlight.has(artist.id)) return;
  avatarFillInFlight.add(artist.id);
  try {
    const hits = await searchNeteaseArtist(artist.search || artist.name);
    const match = artist.neteaseArtistId
      ? hits.find((h) => String(h.id) === String(artist.neteaseArtistId)) || hits[0]
      : hits[0];
    if (match?.avatar) {
      artist.avatar = match.avatar;
      patchAvatarDom(artist);
      return;
    }
    const loaded = await loadItunesArtistCup(artist, { limit: 1 });
    if (loaded?.avatar) {
      artist.avatar = loaded.avatar;
      patchAvatarDom(artist);
    }
  } catch (_) {
    /* best-effort */
  } finally {
    avatarFillInFlight.delete(artist.id);
  }
}

async function hydrateArtist(id) {
  if (artistCache.has(id)) return artistCache.get(id);
  const base = getArtist(id) || runtimeArtistCatalog.get(id);
  if (!base) return null;

  if (hasHotTopPack(id)) {
    try {
      const pack = await loadHotTopPack(id);
      if (pack?.songs?.length) {
        const live = {
          ...base,
          neteaseArtistId: pack.neteaseArtistId || base.neteaseArtistId,
          neteaseArtistName: pack.name || base.name,
          avatar: pickArtistAvatar(base, pack.avatar),
          songs: pack.songs.slice(0, TOP_N),
          fromHotTopPack: true,
        };
        artistCache.set(id, live);
        base.avatar = live.avatar;
        return live;
      }
    } catch (_) {
      /* fall through */
    }
  }

  if (base.neteaseArtistId) {
    try {
      const cached = await fetchArtistTopCache(base.neteaseArtistId);
      if (cached?.songs?.length) {
        const live = {
          ...base,
          neteaseArtistId: cached.neteaseArtistId || base.neteaseArtistId,
          neteaseArtistName: cached.name || base.name,
          avatar: pickArtistAvatar(base, cached.avatar),
          songs: cached.songs.slice(0, TOP_N),
          fromKvCache: true,
        };
        artistCache.set(id, live);
        if (live.avatar) base.avatar = live.avatar;
        return live;
      }
    } catch (_) {
      /* fall through */
    }
  }

  try {
    const live = await loadArtistCup(base, { limit: TOP_N });
    artistCache.set(id, live);
    base.avatar = live.avatar;
    if (live?.neteaseArtistId && live?.songs?.length) {
      putArtistTopCache(live);
    }
    return live;
  } catch (err) {
    if (base.neteaseArtistId) {
      try {
        const cached = await fetchArtistTopCache(base.neteaseArtistId);
        if (cached?.songs?.length) {
          const live = {
            ...base,
            neteaseArtistId: cached.neteaseArtistId || base.neteaseArtistId,
            neteaseArtistName: cached.name || base.name,
            avatar: pickArtistAvatar(base, cached.avatar),
            songs: cached.songs.slice(0, TOP_N),
            fromOfflineFallback: true,
          };
          artistCache.set(id, live);
          if (live.avatar) base.avatar = live.avatar;
          return live;
        }
      } catch {
        /* ignore */
      }
    }
    if (hasHotTopPack(id)) {
      try {
        const pack = await loadHotTopPack(id);
        if (pack?.songs?.length) {
          const live = {
            ...base,
            neteaseArtistId: pack.neteaseArtistId || base.neteaseArtistId,
            neteaseArtistName: pack.name || base.name,
            avatar: pickArtistAvatar(base, pack.avatar),
            songs: pack.songs.slice(0, TOP_N),
            fromOfflineFallback: true,
          };
          artistCache.set(id, live);
          base.avatar = live.avatar;
          return live;
        }
      } catch {
        /* ignore */
      }
    }
    if (Array.isArray(base.songs) && base.songs.length) {
      const live = { ...base, songs: base.songs.slice(0, TOP_N), fromOfflineFallback: true };
      artistCache.set(id, live);
      return live;
    }
    throw err;
  }
}

const homeViewCtx = {
  get app() { return app; },
  shell,
  esc,
  navigate,
  ARTISTS,
  KIND_FILTERS,
  kindFilterMeta,
  filterArtistsByKind,
  renderSponsorTickerHtml,
  renderHomeDonateWallHtml,
  mergeLocalArtistsWithItunes,
  fillAvatarForArtist,
  imgTag,
  IMAGE_SIZES,
  ensureImagePreload,
  fetchArtistRank,
  loadState,
  trackEvent,
  openMessageWall,
  openSupportSite,
  openAboutSite,
  runAfterNextPaint,
};

function renderHome() {
  mountHomeView(homeViewCtx);
}

const dreamFactoryViewCtx = {
  get app() { return app; },
  shell,
  esc,
  navigate,
  saveState,
  trackEvent,
};

function renderDreamFactory() {
  mountDreamFactoryView(dreamFactoryViewCtx);
}

async function renderSetup(artistId) {
  const base = getArtist(artistId) || runtimeArtistCatalog.get(artistId);
  if (!base) {
    app.innerHTML = shell(
      `<section class="setup"><p class="loading-line">名单里没有这位歌手</p></section>`,
      { back: "/" }
    );
    bindBack();
    return;
  }

  app.innerHTML = shell(
    `<section class="setup"><p class="loading-line">正在拉取「${esc(base.name)}」热门…</p></section>`,
    { back: "/" }
  );
  bindBack();

  let artist;
  try {
    artist = await hydrateArtist(artistId);
  } catch (e) {
    const msg = String(e?.message || e || "");
    const offlineHint =
      /Failed to fetch|NetworkError|HTTP 5\d\d|unavailable/i.test(msg)
        ? base.source === "itunes"
          ? "连不上 iTunes 接口，请检查网络后重试"
          : "连不上音乐接口，请稍后重试"
        : msg;
    app.innerHTML = shell(
      `<section class="setup"><p class="loading-line">拉取失败：${esc(offlineHint)}</p></section>`,
      { back: "/" }
    );
    bindBack();
    return;
  }

  const canExpand = /^\d+$/.test(String(artist.neteaseArtistId || ""));
  let poolSongs = [...(artist.songs || [])];
  /** @type {"hot50"|"top100"|"all"} */
  let expandStage = poolSongs.length >= 90 ? "top100" : "hot50";
  let expandLoading = false;
  let pickMode = false;
  /** @type {Set<string>} */
  let selectedIds = new Set();

  const fieldSize = () =>
    nearestFieldSize(Math.min(poolSongs.length, FIELD_MAX), { max: FIELD_MAX });
  let mode = "battle";
  let fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });

  const setupToast = (msg) => {
    let el = document.getElementById("setup-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "setup-toast";
      el.className = "setup-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2200);
  };

  const syncArtistPool = () => {
    artist.songs = poolSongs;
    artistCache.set(artist.id, artist);
  };

  const selectedSongsInPoolOrder = () =>
    poolSongs.filter((s) => selectedIds.has(songKey(s)));

  const startCupWithField = (cupField) => {
    const aliases = [artist.search, artist.neteaseArtistName].filter(Boolean);
    const bracket = buildBracket(poolSongs, {
      mode,
      max: FIELD_MAX,
      field: cupField,
    });
    trackEvent("cup_start");
    saveState({
      artistId: artist.id,
      artistName: artist.name,
      artistAvatar: artist.avatar || "",
      neteaseArtistId: artist.neteaseArtistId || "",
      artistSearch: artist.search || "",
      playSourceReady: 0,
      bracket,
    });
    navigate("/bracket");
    enrichSongsPlaySourceProgressive(cupField, artist.name, {
      concurrency: 2,
      artistAliases: aliases,
      mapArtistId: artist.id,
      readyCount: 4,
      onSong: (song) => {
        const st = loadState();
        if (!st?.bracket) return;
        st.bracket = patchPlaySourceInBracket(st.bracket, song);
        saveState(st);
      },
    })
      .then(({ background }) => background)
      .then((all) => {
        const st = loadState();
        if (!st?.bracket || !all?.length) return;
        let next = st.bracket;
        for (const song of all) next = patchPlaySourceInBracket(next, song);
        const itunesN = all.filter((x) => x.playSource === "itunes").length;
        saveState({
          ...st,
          bracket: next,
          playSourceStats: { itunes: itunesN, total: all.length },
          playSourceReady: all.length,
        });
      })
      .catch(() => {});
  };

  const paint = () => {
    const size = fieldSize();
    const pickCount = selectedIds.size;
    const pickReady = pickCount === FIELD_MAX;
    // 始终展示完整曲库；一键开赛仍只取热度前 size 首
    const listSongs = poolSongs;
    const fieldKeySet = new Set(
      (pickMode ? [...selectedIds] : poolSongs.slice(0, size).map((s) => songKey(s))).filter(Boolean)
    );
    const expandLabel =
      expandStage === "hot50"
        ? "再展开到 Top 100"
        : expandStage === "top100"
          ? "展示全部歌曲"
          : "";
    const showExpand = canExpand && expandStage !== "all" && !!expandLabel;

    app.innerHTML = shell(
      `
      <section class="setup">
        <div class="setup-head setup-head-with-avatar">
          ${imgTag(artist.avatar, {
            alt: artist.name,
            className: "setup-avatar",
            size: IMAGE_SIZES.setup,
            loading: "eager",
            fetchPriority: "high",
            width: 120,
            height: 120,
          })}
          <div>
            <h1>${esc(artist.name)}</h1>
            <p>${esc(artist.city)} · ${esc(artist.tag)} · 曲库 ${poolSongs.length} 首 · ${size} 强</p>
          </div>
        </div>
        <div class="section-title">对阵玩法</div>
        <div class="mode-row">
          <button type="button" class="mode-chip ${mode === "battle" ? "active" : ""}" data-mode="battle">1v1 Battle</button>
          <button type="button" class="mode-chip ${mode === "hot" ? "active" : ""}" data-mode="hot">热门顺序</button>
        </div>
        ${
          pickMode
            ? `<div class="pick-status ${pickReady ? "is-ready" : ""}" id="pick-status">已选曲目：(${pickCount}/${FIELD_MAX})</div>`
            : ""
        }
        <div class="setup-actions">
          ${
            pickMode
              ? `<button type="button" class="primary-btn" id="custom-start-btn" ${
                  pickReady ? "" : "disabled"
                }>生成专属签表并开赛</button>
                 <button type="button" class="ghost-btn" id="pick-toggle-btn">取消自组</button>
                 ${
                   mode === "battle" && pickReady
                     ? `<button type="button" class="ghost-btn" id="reshuffle-pick-btn">打乱已选对位</button>`
                     : ""
                 }`
              : `<button type="button" class="primary-btn" id="start-btn">一键开赛 · ${size} 强</button>
                 <button type="button" class="ghost-btn" id="pick-toggle-btn">自组${FIELD_MAX}强</button>
                 ${
                   mode === "battle"
                     ? `<button type="button" class="ghost-btn" id="reshuffle-btn">再打乱一次</button>`
                     : ""
                 }`
          }
        </div>
        <div class="section-title">${
          pickMode
            ? `自组选歌（曲库 ${poolSongs.length} 首）`
            : `曲库列表（一键开赛取热度前 ${size} / 共 ${poolSongs.length}）`
        }</div>
        <ul class="song-preview ${pickMode ? "pick-mode" : "pool-mode"}">
          ${listSongs
            .map((s, i) => {
              const key = songKey(s);
              const checked = selectedIds.has(key);
              const inField = !pickMode && fieldKeySet.has(key);
              const vsHint =
                !pickMode &&
                mode === "battle" &&
                i < size &&
                i % 2 === 0 &&
                listSongs[i + 1] &&
                i + 1 < size
                  ? ` · vs ${esc(listSongs[i + 1].title)}`
                  : "";
              return `
              <li class="${
                pickMode && checked ? "is-picked" : inField ? "in-field" : ""
              }" ${pickMode ? `data-pick="${esc(key)}"` : ""}>
                ${
                  pickMode
                    ? `<input type="checkbox" class="song-pick-cb" data-pick-id="${esc(
                        key
                      )}" ${checked ? "checked" : ""} aria-label="选择 ${esc(s.title)}" />`
                    : inField
                      ? `<span class="song-field-tag">签</span>`
                      : `<span class="song-field-tag muted">${i + 1}</span>`
                }
                ${imgTag(coverUrl(s, artist.avatar), {
                  alt: s.title,
                  className: "song-cover",
                  size: IMAGE_SIZES.chip,
                  width: 36,
                  height: 36,
                })}
                <span class="song-preview-text">
                  <strong>${i + 1}. ${esc(s.title)}</strong>
                  <em>${esc(s.album || "单曲")}${vsHint}${
                    inField && !pickMode ? " · 将参赛" : ""
                  }${
                    s.playSource === "itunes"
                      ? " · Apple"
                      : s.playSource === "netease"
                        ? " · 网易云"
                        : ""
                  }</em>
                </span>
              </li>`;
            })
            .join("")}
        </ul>
        ${
          showExpand
            ? `<button type="button" class="setup-expand-btn" id="expand-btn" ${
                expandLoading ? "disabled" : ""
              }>${expandLoading ? "加载中…" : expandLabel}</button>`
            : ""
        }
      </section>
    `,
      { back: "/" }
    );
    bindBack();

    app.querySelectorAll("[data-mode]").forEach((chip) => {
      chip.addEventListener("click", () => {
        mode = chip.dataset.mode;
        if (!pickMode) {
          fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });
        }
        paint();
      });
    });

    document.getElementById("pick-toggle-btn")?.addEventListener("click", () => {
      if (pickMode) {
        pickMode = false;
        selectedIds = new Set();
        fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });
      } else {
        pickMode = true;
        selectedIds = new Set(fieldSongs.map((s) => songKey(s)).filter(Boolean));
      }
      paint();
    });

    document.getElementById("reshuffle-btn")?.addEventListener("click", () => {
      fieldSongs = buildField(poolSongs, { mode: "battle", max: FIELD_MAX });
      paint();
    });

    document.getElementById("reshuffle-pick-btn")?.addEventListener("click", () => {
      const picked = selectedSongsInPoolOrder();
      if (picked.length !== FIELD_MAX) {
        setupToast(`请确保选中刚好 ${FIELD_MAX} 首单曲`);
        return;
      }
      artist._pickShuffle = pickSongs(picked, "battle");
      setupToast("已打乱对位，开赛时生效");
      paint();
    });

    const togglePick = (key) => {
      if (!key) return;
      if (selectedIds.has(key)) {
        selectedIds.delete(key);
        artist._pickShuffle = null;
        paint();
        return;
      }
      if (selectedIds.size >= FIELD_MAX) {
        setupToast(`最多选 ${FIELD_MAX} 首`);
        return;
      }
      selectedIds.add(key);
      artist._pickShuffle = null;
      paint();
    };

    app.querySelectorAll(".song-pick-cb").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        const key = cb.dataset.pickId;
        if (cb.checked) {
          if (selectedIds.size >= FIELD_MAX && !selectedIds.has(key)) {
            cb.checked = false;
            setupToast(`最多选 ${FIELD_MAX} 首`);
            return;
          }
          selectedIds.add(key);
        } else {
          selectedIds.delete(key);
        }
        artist._pickShuffle = null;
        paint();
      });
    });
    app.querySelectorAll("li[data-pick]").forEach((li) => {
      li.addEventListener("click", (e) => {
        if (e.target.closest(".song-pick-cb")) return;
        togglePick(li.dataset.pick);
      });
    });

    document.getElementById("start-btn")?.addEventListener("click", () => {
      const btn = document.getElementById("start-btn");
      btn.disabled = true;
      try {
        startCupWithField(fieldSongs);
      } catch (e) {
        btn.disabled = false;
        alert(`开赛失败：${e.message || e}`);
      }
    });

    document.getElementById("custom-start-btn")?.addEventListener("click", () => {
      const btn = document.getElementById("custom-start-btn");
      const picked =
        artist._pickShuffle?.length === FIELD_MAX
          ? artist._pickShuffle
          : pickSongs(selectedSongsInPoolOrder(), mode);
      if (picked.length !== FIELD_MAX) {
        setupToast(`请确保选中刚好 ${FIELD_MAX} 首单曲`);
        return;
      }
      btn.disabled = true;
      try {
        startCupWithField(picked);
      } catch (e) {
        btn.disabled = false;
        alert(`开赛失败：${e.message || e}`);
      }
    });

    document.getElementById("expand-btn")?.addEventListener("click", async () => {
      if (!canExpand || expandLoading || expandStage === "all") return;
      const target = expandStage === "hot50" ? "top100" : "all";
      expandLoading = true;
      paint();
      try {
        const result = await expandArtistPool(poolSongs, artist.neteaseArtistId, target);
        poolSongs = result.songs;
        expandStage = result.stage;
        if (result.stage === "top100" && !result.more) {
          expandStage = "all";
        }
        syncArtistPool();
        if (!pickMode) {
          fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });
        }
        putArtistTopCache({
          ...artist,
          songs: poolSongs.slice(0, 100),
        });
        setupToast(
          target === "top100"
            ? `已展开到 ${poolSongs.length} 首`
            : `已加载全部 ${poolSongs.length} 首`
        );
      } catch (e) {
        setupToast(e.message || "扩库失败，请稍后重试");
      } finally {
        expandLoading = false;
        paint();
      }
    });
  };

  paint();
}

function songKey(song) {
  if (!song) return "";
  return String(song.id || song.neteaseId || song.title || "");
}

/** Merge iTunes/netease play fields into every copy of a song inside the bracket. */
function patchPlaySourceInBracket(bracket, song) {
  const key = songKey(song);
  if (!key || !bracket) return bracket;
  const patch = (s) => {
    if (!s || songKey(s) !== key) return s;
    return {
      ...s,
      playSource: song.playSource,
      previewUrl: song.previewUrl || "",
      itunesTrackId: song.itunesTrackId || "",
      trackViewUrl: song.trackViewUrl || "",
    };
  };
  return {
    ...bracket,
    rounds: (bracket.rounds || []).map((round) =>
      round.map((m) => ({
        ...m,
        a: patch(m.a),
        b: patch(m.b),
        winner: m.winner ? patch(m.winner) : m.winner,
      }))
    ),
    champion: bracket.champion ? patch(bracket.champion) : null,
  };
}

async function ensureSongPlaySource(state, song) {
  if (!song) return song;
  // 已判定过音源就直接用（iTunes / 网易云都算已决议），避免点试听重复打接口
  if (song.playSource === "itunes" && song.previewUrl) return song;
  if (song.playSource === "netease") return song;
  const aliases = [state.artistSearch, state.artistName, song.rosterArtistName].filter(Boolean);
  const resolved = await resolvePlaySource(song, state.artistName, {
    artistAliases: aliases,
    mapArtistId: song.rosterArtistId || state.artistId || "",
  });
  const nextBracket = patchPlaySourceInBracket(state.bracket, resolved);
  const next = { ...state, bracket: nextBracket };
  saveState(next);
  return resolved;
}

/** 对战页预取双边音源，点试听时尽量秒开 */
function prefetchMatchPlaySources(state, match) {
  if (!state?.bracket || !match) return;
  for (const side of [match.a, match.b]) {
    if (!side) continue;
    if (side.playSource === "itunes" || side.playSource === "netease") continue;
    ensureSongPlaySource(state, side).catch(() => {});
  }
}

function isSameSong(a, b) {
  const ka = songKey(a);
  const kb = songKey(b);
  return Boolean(ka && kb && ka === kb);
}

function bracketSlot(
  song,
  fallbackAvatar,
  { onPath = false, won = null, roundIndex = -1, wing = "" } = {}
) {
  if (!song) {
    return `<div class="bracket-slot is-empty"><span>待定</span></div>`;
  }
  const pathCls = onPath ? " on-path" : "";
  const resultCls =
    won === true ? " is-winner" : won === false ? " is-loser" : "";
  const pathAttrs = onPath
    ? ` data-path-round="${roundIndex}" data-path-wing="${esc(wing)}"`
    : "";
  return `
    <div class="bracket-slot${pathCls}${resultCls}" title="${esc(song.title)}"${pathAttrs}>
      ${imgTag(coverUrl(song, fallbackAvatar), {
        alt: song.title,
        className: "bracket-slot-cover",
        size: IMAGE_SIZES.chip,
        width: 24,
        height: 24,
      })}
      <span class="bracket-slot-title">${esc(song.title)}</span>
    </div>
  `;
}

function shortRoundLabel(size, roundIndex) {
  const remaining = size / 2 ** roundIndex;
  if (remaining === 2) return "决赛";
  if (remaining === 4) return "半决赛";
  if (remaining === 8) return "8强";
  return `${remaining}强`;
}

function renderRoundColumn(matches, label, side, fallbackAvatar, champ, roundIndex) {
  return `
    <div class="bracket-round" data-side="${side}" data-round="${roundIndex}">
      <div class="bracket-round-label">${esc(label)}</div>
      <div class="bracket-round-matches">
        ${matches
          .map(
            (m) => `
            <div class="bracket-match${
              champ && (isSameSong(m.a, champ) || isSameSong(m.b, champ)) ? " has-path" : ""
            }">
              ${bracketSlot(m.a, fallbackAvatar, {
                onPath: isSameSong(m.a, champ),
                won: m.winner ? isSameSong(m.a, m.winner) : null,
                roundIndex,
                wing: side,
              })}
              ${bracketSlot(m.b, fallbackAvatar, {
                onPath: isSameSong(m.b, champ),
                won: m.winner ? isSameSong(m.b, m.winner) : null,
                roundIndex,
                wing: side,
              })}
            </div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderBracketHtml(bracket, fallbackAvatar) {
  const rounds = bracket.rounds;
  const finalIndex = rounds.length - 1;
  const finalRound = rounds[finalIndex] || [];
  const feederCount = Math.max(0, finalIndex);
  const champ = bracket.champion || null;
  const pathClass = champ ? " has-champ-path" : "";

  const leftCols = [];
  const rightCols = [];
  for (let ri = 0; ri < feederCount; ri++) {
    const round = rounds[ri] || [];
    const mid = Math.ceil(round.length / 2);
    const leftMatches = round.slice(0, mid);
    const rightMatches = round.slice(mid);
    const label = shortRoundLabel(bracket.size, ri);
    leftCols.push(renderRoundColumn(leftMatches, label, "left", fallbackAvatar, champ, ri));
    rightCols.unshift(renderRoundColumn(rightMatches, label, "right", fallbackAvatar, champ, ri));
  }

  const finalMatch = finalRound[0] || { a: null, b: null };
  const artistBg = fallbackAvatar
    ? `--artist-bg:url('${optimizedImageUrl(fallbackAvatar, { size: IMAGE_SIZES.setup }).replace(/'/g, "%27")}');`
    : "";

  const champHero = champ
    ? `
      <div
        class="bracket-champ-hero"
        data-path-round="${finalIndex + 1}"
        data-path-wing="champ"
      >
        <div class="champ-hero-aura" aria-hidden="true"></div>
        <div class="champ-hero-orbit" aria-hidden="true"></div>
        <div class="champ-hero-cover-wrap">
          ${imgTag(coverUrl(champ, fallbackAvatar), {
            alt: champ.title,
            className: "champ-hero-cover",
            size: IMAGE_SIZES.match,
            loading: "eager",
            fetchPriority: "high",
            width: 160,
            height: 160,
          })}
          <span class="champ-hero-crown" aria-hidden="true">♛</span>
        </div>
        <div class="champ-hero-badge">冠军 · CHAMPION</div>
        <div class="champ-hero-title">${esc(champ.title)}</div>
        <div class="champ-hero-meta">${esc(metaLine(champ) || "")}</div>
      </div>`
    : `
      <div class="bracket-champ">
        <div class="bracket-round-label">冠军</div>
        <div class="bracket-slot is-empty champ-slot"><span>本命曲</span></div>
      </div>`;

  return `
    <div class="bracket-fit" id="bracket-fit">
      <div class="bracket-board is-split${pathClass} ${fallbackAvatar ? "has-center-bg" : ""}" id="bracket-board" style="--feeders:${feederCount};${artistBg}">
        <div class="bracket-wing bracket-wing-left">
          ${leftCols.join("")}
        </div>
        <div class="bracket-center${champ ? " is-hero" : ""}">
          <div class="bracket-round-label">决赛</div>
          <div class="bracket-match bracket-final${
            champ && (isSameSong(finalMatch.a, champ) || isSameSong(finalMatch.b, champ))
              ? " has-path"
              : ""
          }">
            ${bracketSlot(finalMatch.a, fallbackAvatar, {
              onPath: isSameSong(finalMatch.a, champ),
              won: finalMatch.winner
                ? isSameSong(finalMatch.a, finalMatch.winner)
                : champ
                  ? isSameSong(finalMatch.a, champ)
                  : null,
              roundIndex: finalIndex,
              wing: "center",
            })}
            ${bracketSlot(finalMatch.b, fallbackAvatar, {
              onPath: isSameSong(finalMatch.b, champ),
              won: finalMatch.winner
                ? isSameSong(finalMatch.b, finalMatch.winner)
                : champ
                  ? isSameSong(finalMatch.b, champ)
                  : null,
              roundIndex: finalIndex,
              wing: "center",
            })}
          </div>
          ${champHero}
        </div>
        <div class="bracket-wing bracket-wing-right">
          ${rightCols.join("")}
        </div>
      </div>
    </div>
  `;
}

/** Box relative to board, undoing CSS transform:scale on the board. */
function boxInBoard(el, board) {
  const er = el.getBoundingClientRect();
  const br = board.getBoundingClientRect();
  const sx = board.offsetWidth / Math.max(br.width, 1);
  const sy = board.offsetHeight / Math.max(br.height, 1);
  return {
    x: (er.left - br.left) * sx,
    y: (er.top - br.top) * sy,
    w: er.width * sx,
    h: er.height * sy,
  };
}

/** Draw glowing polyline chain along champion path slots. */
function drawChampionPathChain(board) {
  if (!board?.classList.contains("has-champ-path")) return;
  board.querySelector(".path-chain-svg")?.remove();

  const slots = [...board.querySelectorAll("[data-path-wing]")];
  if (slots.length < 2) return;

  const scored = slots.map((el) => {
    const round = Number(el.dataset.pathRound ?? -1);
    const wing = el.dataset.pathWing || "";
    const box = boxInBoard(el, board);
    return { el, round, wing, box };
  });
  scored.sort((a, b) => a.round - b.round || a.box.y - b.box.y);

  const W = board.offsetWidth;
  const H = board.offsetHeight;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "path-chain-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("aria-hidden", "true");

  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML = `
    <linearGradient id="champ-path-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#8fbf20" stop-opacity="1"/>
      <stop offset="100%" stop-color="#8fbf20" stop-opacity="1"/>
    </linearGradient>
  `;
  svg.appendChild(defs);

  const anchor = (item, towardNext) => {
    const { box, wing } = item;
    const cy = box.y + box.h / 2;
    if (wing === "left") {
      return towardNext ? { x: box.x + box.w, y: cy } : { x: box.x, y: cy };
    }
    if (wing === "right") {
      return towardNext ? { x: box.x, y: cy } : { x: box.x + box.w, y: cy };
    }
    // center / champ: connect from top/bottom or sides toward previous
    if (wing === "champ") {
      // connect into top-center of big cover
      const cover = item.el.querySelector?.(".champ-hero-cover-wrap") || item.el;
      const cb = cover === item.el ? item.box : boxInBoard(cover, board);
      return { x: cb.x + cb.w / 2, y: cb.y };
    }
    // final center slot → point toward champ (down) or previous (side)
    return towardNext
      ? { x: box.x + box.w / 2, y: box.y + box.h }
      : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  };

  for (let i = 0; i < scored.length - 1; i++) {
    const a = scored[i];
    const b = scored[i + 1];
    const p1 = anchor(a, true);
    const p2 = anchor(b, false);

    // Adjust center→champ and feeder→final anchors
    let x1 = p1.x;
    let y1 = p1.y;
    let x2 = p2.x;
    let y2 = p2.y;

    if (a.wing === "left" && (b.wing === "center" || b.wing === "champ")) {
      x1 = a.box.x + a.box.w;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x;
      y2 = b.box.y + b.box.h / 2;
    } else if (a.wing === "right" && (b.wing === "center" || b.wing === "champ")) {
      x1 = a.box.x;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x + b.box.w;
      y2 = b.box.y + b.box.h / 2;
    } else if (a.wing === "center" && b.wing === "champ") {
      const cover = b.el.querySelector?.(".champ-hero-cover-wrap");
      const cb = cover ? boxInBoard(cover, board) : b.box;
      x1 = a.box.x + a.box.w / 2;
      y1 = a.box.y + a.box.h;
      x2 = cb.x + cb.w / 2;
      y2 = cb.y;
    } else if ((a.wing === "left" || a.wing === "right") && b.wing === "champ") {
      const cover = b.el.querySelector?.(".champ-hero-cover-wrap");
      const cb = cover ? boxInBoard(cover, board) : b.box;
      if (a.wing === "left") {
        x1 = a.box.x + a.box.w;
        y1 = a.box.y + a.box.h / 2;
        x2 = cb.x;
        y2 = cb.y + cb.h / 2;
      } else {
        x1 = a.box.x;
        y1 = a.box.y + a.box.h / 2;
        x2 = cb.x + cb.w;
        y2 = cb.y + cb.h / 2;
      }
    } else if (a.wing === "left" && b.wing === "left") {
      x1 = a.box.x + a.box.w;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x;
      y2 = b.box.y + b.box.h / 2;
    } else if (a.wing === "right" && b.wing === "right") {
      x1 = a.box.x;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x + b.box.w;
      y2 = b.box.y + b.box.h / 2;
    }

    const mx = (x1 + x2) / 2;
    const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${mx.toFixed(1)} ${y1.toFixed(1)} L ${mx.toFixed(1)} ${y2.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;

    const glow = document.createElementNS(ns, "path");
    glow.setAttribute("d", d);
    glow.setAttribute("class", "path-chain-glow");
    glow.setAttribute("fill", "none");
    svg.appendChild(glow);

    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "path-chain-line");
    line.setAttribute("fill", "none");
    svg.appendChild(line);
  }

  board.appendChild(svg);
}

/**
 * Scale bracket board into fit box without asymmetric clip.
 * Uses top-left origin + margin centering so overflow:hidden keeps both wings.
 */
function fitBracketBoard(fit, board, { pad = 0.96, maxAvailH } = {}) {
  if (!fit || !board) return 1;

  board.style.transform = "none";
  board.style.left = "";
  board.style.marginLeft = "0";
  board.style.marginRight = "0";
  board.style.marginBottom = "0";
  fit.style.height = "";

  const parentW = fit.parentElement?.getBoundingClientRect().width || window.innerWidth;
  const availW = Math.min(
    fit.getBoundingClientRect().width || fit.clientWidth || parentW,
    parentW,
    window.innerWidth - 8
  );
  const availH =
    maxAvailH ??
    (Math.min(
      fit.clientHeight || 0,
      Math.max(280, window.innerHeight - (window.innerWidth <= 720 ? 160 : 200))
    ) || Math.max(280, window.innerHeight - 200));
  const needW = Math.max(board.scrollWidth, 1);
  const needH = Math.max(board.scrollHeight, 1);
  const scale = Math.min(availW / needW, availH / needH, 1) * pad;
  const visualW = needW * scale;
  const visualH = needH * scale;

  board.style.transformOrigin = "top left";
  board.style.transform = `scale(${scale})`;
  board.style.marginLeft = `${Math.max(0, (availW - visualW) / 2)}px`;
  // reclaim unused layout space created by CSS transform (layout stays at needW×needH)
  board.style.marginRight = `${visualW - needW}px`;
  board.style.marginBottom = `${visualH - needH}px`;
  fit.style.height = `${Math.ceil(visualH + 4)}px`;
  fit.style.minHeight = `${Math.ceil(visualH + 4)}px`;

  requestAnimationFrame(() => drawChampionPathChain(board));
  return scale;
}

function fitBracketToScreen() {
  const fit = document.getElementById("bracket-fit");
  const board = document.getElementById("bracket-board");
  if (!fit || !board) return;
  const pad = window.innerWidth <= 720 ? 0.88 : 0.98;
  fitBracketBoard(fit, board, { pad });
}

function renderBracketPreview(state) {
  const avatar = state.artistAvatar || "";
  const size = state.bracket.size;
  let cancelled = false;
  let pollTimer = null;
  let started = false;

  void getShareCardModule()
    .then((mod) => mod.warmShareCovers(state))
    .catch(() => {});

  app.innerHTML = shell(
    `
    <section class="bracket-preview">
      <div class="bracket-preview-head">
        ${imgTag(avatar, {
          alt: state.artistName,
          className: "setup-avatar",
          size: IMAGE_SIZES.setup,
          loading: "eager",
          width: 120,
          height: 120,
        })}
        <div class="bracket-preview-copy">
          <h1 class="bracket-title-fx"><span class="rapper-name">${esc(state.artistName)} · ${size} 强对阵图</span></h1>
        </div>
      </div>
      ${renderBracketHtml(state.bracket, avatar)}
      <div class="countdown-overlay is-ready" id="countdown-overlay" aria-live="polite">
        <p class="bracket-ready-hint" id="bracket-ready-hint">准备开赛！</p>
      </div>
      <div class="setup-actions bracket-actions">
        <button type="button" class="ghost-btn" id="back-setup">返回调整签表</button>
      </div>
    </section>
  `,
    { back: `/artist/${state.artistId}`, wide: true }
  );
  bindBack();

  const cleanup = () => {
    cancelled = true;
    if (pollTimer) clearTimeout(pollTimer);
    window.removeEventListener("resize", runFit);
  };

  const runFit = () => fitBracketToScreen();
  requestAnimationFrame(() => {
    runFit();
    requestAnimationFrame(runFit);
  });
  const board = document.getElementById("bracket-board");
  board?.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", runFit, { once: true });
  });
  window.addEventListener("resize", runFit, { passive: true });

  document.getElementById("back-setup").addEventListener("click", () => {
    cleanup();
    clearState();
    navigate(`/artist/${state.artistId}`);
  });

  const goPlay = () => {
    if (cancelled || started) return;
    started = true;
    const overlay = document.getElementById("countdown-overlay");
    overlay?.classList.add("is-out");
    setTimeout(() => {
      if (cancelled) return;
      cleanup();
      navigate("/play");
    }, 320);
  };

  const began = Date.now();
  const tickReady = () => {
    if (cancelled || started) return;
    const latest = loadState() || state;
    const ready = Number(latest.playSourceReady || 0);
    const waited = Date.now() - began;
    // 有至少 4 首播放源，或最多等约 2.8s，避免卡死
    if (ready >= 4 || waited >= 2800) {
      goPlay();
      return;
    }
    pollTimer = setTimeout(tickReady, 180);
  };
  pollTimer = setTimeout(tickReady, 400);
}

function renderMatchCoopHintHtml() {
  return `<span class="match-coop-hint">欢迎有想法的人一起<button type="button" class="match-coop-link" data-about-site>合作</button>！</span>`;
}

function renderMatch(state) {
  stopAllPageAudio();
  const match = currentMatch(state.bracket);
  if (!match) {
    if (state.bracket.champion) {
      navigate("/champ");
      return;
    }
    app.innerHTML = shell(`<p>赛程异常，请重新开赛。</p>`, { back: "/" });
    bindBack();
    return;
  }

  const label = roundLabel(state.bracket, match);
  const isDreamFactory = state.cupType === "dream-factory";
  const avatar = state.artistAvatar || "";
  preloadMatchCover(coverUrl(match.a, avatar), { priority: "high" });
  preloadMatchCover(coverUrl(match.b, avatar), { priority: "high" });
  prefetchUpcomingMatchCovers(state, match, avatar);

  const backHref = isDreamFactory ? "/dream-factory" : `/artist/${state.artistId}`;

  app.innerHTML = shell(
    `
    <section class="match-screen${isDreamFactory ? " match-screen-dream" : ""}">
      <div class="match-meta">
        ${
          isDreamFactory
            ? `<div class="dream-match-brand" aria-hidden="true">梦回大厂</div>`
            : imgTag(avatar, {
                alt: state.artistName,
                className: "match-artist-avatar",
                size: IMAGE_SIZES.chip,
                loading: "eager",
                width: 36,
                height: 36,
              })
        }
        <div>
          <strong>${esc(label)}</strong>
          <div class="match-meta-sub">
            <span>${esc(state.artistName || "")}</span>
            <span>进度 ${progressText(state.bracket)}</span>
            ${renderMatchCoopHintHtml()}
          </div>
        </div>
      </div>
      <div class="vs-grid">
        ${pickButton("a", match.a, avatar, { dreamFactory: isDreamFactory })}
        <div class="vs-mark">VS</div>
        ${pickButton("b", match.b, avatar, { dreamFactory: isDreamFactory })}
      </div>
      <div id="player-mount" class="player-mount"></div>
    </section>
  `,
    {
      back: backHref,
    }
  );
  bindBack();

  const player = createPlayer(document.getElementById("player-mount"));
  let previewReq = 0;
  if (!isDreamFactory) prefetchMatchPlaySources(state, match);
  upgradeProgressiveCovers(app);

  app.querySelectorAll("[data-preview]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const side = btn.dataset.preview;
        const raw = side === "a" ? match.a : match.b;
        const latest = loadState() || state;
        const req = ++previewReq;
        const prevLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = "匹配中…";
        try {
          const song = await ensureSongPlaySource(latest, raw);
          if (req !== previewReq) return;
          await player.load(song, {
            autoplay: true,
            artistName: song.rosterArtistName || latest.artistName || "",
            artistAliases: [latest.artistSearch, song.rosterArtistName].filter(Boolean),
            mapArtistId: song.rosterArtistId || latest.artistId || "",
          });
        } finally {
          if (req === previewReq) {
            btn.disabled = false;
            btn.textContent = prevLabel || "试听";
          }
        }
      });
    });

  app.querySelectorAll("[data-side]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // ignore clicks that bubbled from preview
      if (e.target.closest("[data-preview]")) return;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("is-picking");
      const pickedSide = btn.dataset.side;
      runAfterNextPaint(() => {
        previewReq += 1;
        player?.stop();
        stopAllPageAudio();
        const roundIdx = findRoundIndex(state.bracket, match.id);
        const nextBracket = chooseWinner(state.bracket, match.id, pickedSide);
        const next = { ...state, bracket: nextBracket };
        saveState(next);
        if (nextBracket.champion) {
          goChampAfterWin(next);
          return;
        }
        // 本轮全部打完 → 弹出下一轮环节动画（32→16、16→8…）
        if (roundIdx >= 0 && isRoundComplete(nextBracket, roundIdx)) {
          const splash = splashForBracket(
            nextBracket,
            isDreamFactory
              ? { subject: "个舞台", pickHint: "一个" }
              : { subject: "首歌", pickHint: "一首" }
          );
          if (splash) {
            showRoundSplash(splash, () => renderMatch(next));
            return;
          }
        }
        renderMatch(next);
      });
    });
  });
}

function showRoundSplash({ title, sub }, onDone) {
  const existing = document.getElementById("round-splash");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "round-splash";
  el.className = "round-splash";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="round-splash-bg" aria-hidden="true"></div>
    <div class="round-splash-card">
      <div class="round-splash-badge">Idol 巅峰对决</div>
      <h2 class="round-splash-title">${esc(title)}</h2>
      <p class="round-splash-sub">${esc(sub)}</p>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  let done = false;
  let auto = null;
  function finish() {
    if (done) return;
    done = true;
    if (auto) clearTimeout(auto);
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => {
      el.remove();
      onDone?.();
    }, 320);
  }

  el.addEventListener("click", finish);
  auto = setTimeout(finish, 2200);
}

function goChampAfterWin(state) {
  const champ = state.bracket?.champion;
  if (!champ) {
    navigate("/champ");
    return;
  }

  const isDreamFactory = state.cupType === "dream-factory";
  const winPayload = {
    song: champ,
    artistId: String(state.itunesArtistId || state.artistId || champ.stageId || champ.id || ""),
    artistName: isDreamFactory ? "梦回大厂" : state.artistName,
    artistAvatar: isDreamFactory
      ? champ.cover || champ.coverSm || ""
      : state.artistAvatar || "",
  };
  if (isDreamFactory) {
    winPayload.cupType = "dream-factory";
    winPayload.chapter = champ.chapter || "";
  }
  const winPromise = reportChampionWin(winPayload).catch(() => null);

  showRoundSplash(
    {
      title: "冠军诞生",
      sub: isDreamFactory
        ? `${champ.title} 加冕神级舞台冠军`
        : `${champ.title} · ${state.artistName} 本命曲加冕`,
    },
    async () => {
      let veil = null;
      const veilTimer = setTimeout(() => {
        veil = document.createElement("div");
        veil.className = "round-splash is-on";
        veil.innerHTML = `<div class="round-splash-bg" aria-hidden="true"></div>`;
        document.body.appendChild(veil);
      }, 40);
      const data = await winPromise;
      clearTimeout(veilTimer);
      veil?.remove();
      if (data?.songWins != null) {
        try {
          const st = loadState() || state;
          st.champSongWins = Number(data.songWins) || 0;
          saveState(st);
        } catch (_) {}
      }
      if (data?.milestone && data.participantNo) {
        markMilestoneShown({
          song: champ,
          artistId: String(state.itunesArtistId || state.artistId || ""),
        });
        showMilestoneSplash(data.participantNo, () => navigate("/champ"));
        return;
      }
      navigate("/champ");
    }
  );
}

/** 总参与人数撞上 100 倍数时的惊喜彩蛋，结束后进入冠军页 */
function showMilestoneSplash(participantNo, onDone) {
  const existing = document.getElementById("round-splash");
  if (existing) existing.remove();

  const n = Number(participantNo) || 0;
  const pretty = n.toLocaleString("zh-CN");
  const sparks = Array.from({ length: 18 }, (_, i) => {
    const left = 8 + ((i * 37) % 84);
    const delay = ((i * 0.11) % 1.4).toFixed(2);
    const dur = (1.6 + (i % 5) * 0.22).toFixed(2);
    const size = 4 + (i % 4) * 2;
    return `<span class="milestone-spark" style="--sx:${left}%;--sd:${delay}s;--sdu:${dur}s;--ss:${size}px"></span>`;
  }).join("");

  const el = document.createElement("div");
  el.id = "round-splash";
  el.className = "round-splash milestone-splash";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="round-splash-bg" aria-hidden="true"></div>
    <div class="milestone-sparks" aria-hidden="true">${sparks}</div>
    <div class="round-splash-card">
      <div class="round-splash-badge">里程碑彩蛋</div>
      <p class="milestone-congrats">恭喜你！</p>
      <p class="milestone-line">你是全站第 <em>${esc(pretty)}</em> 位参与者！</p>
      <p class="milestone-tagline">正好卡在 ${esc(String(n))} · 运气爆棚</p>
      <p class="round-splash-hint">点击或稍候进入冠军页</p>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  let done = false;
  let auto = null;
  function finish() {
    if (done) return;
    done = true;
    if (auto) clearTimeout(auto);
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => {
      el.remove();
      onDone?.();
    }, 320);
  }

  el.addEventListener("click", finish);
  auto = setTimeout(finish, 4200);
}

function podiumCard(label, en, song, fallback) {
  if (!song) {
    return `
      <div class="podium-card is-empty">
        <div class="podium-label">${esc(label)} · ${esc(en)}</div>
        <div class="podium-title">—</div>
      </div>
    `;
  }
  return `
    <div class="podium-card">
      ${imgTag(coverUrl(song, fallback), {
        alt: song.title,
        className: "podium-cover",
        size: IMAGE_SIZES.chip,
        width: 48,
        height: 48,
      })}
      <div class="podium-copy">
        <div class="podium-label">${esc(label)} · ${esc(en)}</div>
        <div class="podium-title">${esc(song.title)}</div>
      </div>
    </div>
  `;
}

function openShareBracket(state) {
  const existing = document.getElementById("share-bracket");
  if (existing) existing.remove();

  void getShareCardModule()
    .then((mod) => mod.warmShareCovers(state))
    .catch(() => {});

  const avatar = state.artistAvatar || "";
  const c = state.bracket.champion;
  const el = document.createElement("div");
  el.id = "share-bracket";
  el.className = "share-bracket";
  // Light shell first so click paint stays responsive (INP).
  el.innerHTML = `
    <div class="share-bracket-panel">
      <header class="share-bracket-head">
        <div>
          <h2>${esc(state.artistName)}</h2>
          <p class="share-bracket-champ-line">冠军 · <span class="share-bracket-champ-song">${esc(
            c?.title || ""
          )}</span></p>
        </div>
        <div class="share-bracket-actions">
          <button type="button" class="share-save-btn" id="share-save-btn" disabled>保存照片</button>
          <button type="button" class="ghost-btn" id="share-close-btn">关闭</button>
        </div>
      </header>
      <div class="share-bracket-stage" id="share-bracket-stage">
        <p class="share-bracket-loading">对阵图加载中…</p>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  /** @type {(() => void) | null} */
  let fitShare = null;
  const close = () => {
    if (fitShare) window.removeEventListener("resize", fitShare);
    const supportModal = document.getElementById("support-author-modal");
    if (supportModal) supportModal.remove();
    el.classList.remove("is-on");
    setTimeout(() => el.remove(), 280);
  };
  el.querySelector("#share-close-btn").addEventListener("click", close);
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });

  const mountHeavyShareBody = () => {
    if (!el.isConnected) return;
    const stage = el.querySelector("#share-bracket-stage");
    if (!stage) return;
    stage.innerHTML = `
        <div class="share-bracket-card" id="battle-card">
          <div class="share-bracket-brand brand-wordmark" aria-label="Idol 巅峰对决">
            <span class="brand-heipa">Idol</span><span class="brand-duel">巅峰对决</span>
          </div>
          ${renderBracketHtml(state.bracket, avatar)}
          <button type="button" class="share-cta-btn" id="share-go-btn">
            <svg class="share-cta-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M12 3.2a1 1 0 0 1 .7.3l3.5 3.5a1 1 0 1 1-1.4 1.4L13 6.6V15a1 1 0 1 1-2 0V6.6L8.2 8.4a1 1 0 1 1-1.4-1.4L10.3 3.5a1 1 0 0 1 .7-.3Z"/>
              <path fill="currentColor" d="M5 12a1 1 0 0 1 1 1v5h12v-5a1 1 0 1 1 2 0v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/>
            </svg>
            <span>${SHARE_CTA_LABEL}</span>
          </button>
          <div class="share-bracket-qr">
            <div class="share-bracket-qr-copy">
              <div class="share-bracket-site">
                <span class="share-site-name" aria-label="idolshow.local">IDOLSHOW</span>
                <span class="share-site-z" aria-hidden="true">z</span>
              </div>
              <em class="share-bracket-slogan">给你的本命团体办一场真正的 K-pop 巅峰对决</em>
            </div>
            <canvas id="share-qr-canvas" width="66" height="66" aria-label="网站二维码"></canvas>
            <div class="share-support-wrap">
              <button type="button" class="share-support-btn" id="share-support-btn">赞助作者</button>
            </div>
          </div>
        </div>
    `;

  fitShare = () => {
    const fit = el.querySelector("#bracket-fit");
    const board = el.querySelector("#bracket-board");
    if (!fit || !board) return;
    const mobile = window.innerWidth <= 720;
    const availH = Math.max(260, window.innerHeight * (mobile ? 0.52 : 0.62));
    fitBracketBoard(fit, board, {
      pad: mobile ? 0.84 : 0.94,
      maxAvailH: availH,
    });
  };
  requestAnimationFrame(() => {
    fitShare?.();
    requestAnimationFrame(() => fitShare?.());
  });
  const qrCanvas = el.querySelector("#share-qr-canvas");
  if (qrCanvas) {
    void getQrCodeModule()
      .then((mod) =>
        mod.default.toCanvas(qrCanvas, SITE_URL, {
          width: 66,
          margin: 1,
          color: { dark: "#111110", light: "#ffffff" },
          errorCorrectionLevel: "M",
        })
      )
      .catch(() => {});
  }
  el.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", () => fitShare?.(), { once: true });
  });
  window.addEventListener("resize", fitShare, { passive: true });

  const shareBtn = el.querySelector("#share-go-btn");
  const shareLabel = shareBtn?.querySelector("span");
  const saveBtn = el.querySelector("#share-save-btn");
  const supportBtn = el.querySelector("#share-support-btn");
  /** @type {{ file: File, title: string, text: string } | null} */
  let shareReady = null;
  let shareImageReadyTracked = false;
  if (shareBtn && shareLabel) {
    shareBtn.disabled = true;
    shareBtn.classList.add("is-busy");
    shareLabel.textContent = "准备中…";
  }
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.classList.add("is-busy");
  }

  const setShareReady = (ready) => {
    shareReady = ready;
    if (!shareImageReadyTracked) {
      shareImageReadyTracked = true;
      trackEvent("share_image_ready");
    }
    if (shareBtn && shareLabel) {
      shareBtn.disabled = false;
      shareBtn.classList.remove("is-busy", "is-fail");
      shareLabel.textContent = SHARE_CTA_LABEL;
    }
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.remove("is-busy");
      saveBtn.textContent = "保存照片";
    }
  };

  const setShareFail = () => {
    if (shareBtn && shareLabel) {
      shareBtn.disabled = false;
      shareBtn.classList.remove("is-busy");
      shareBtn.classList.add("is-fail");
      shareLabel.textContent = "失败重试";
    }
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.remove("is-busy");
      saveBtn.textContent = "重试生成";
    }
  };

  void prepareNativeSharePayload(state).then(setShareReady).catch(setShareFail);

  const closeSupportModal = () => {
    const modal = document.getElementById("support-author-modal");
    if (!modal) return;
    modal.classList.remove("is-on");
    setTimeout(() => modal.remove(), 220);
  };

  const openSupportModal = () => {
    closeSupportModal();
    const modal = document.createElement("div");
    modal.id = "support-author-modal";
    modal.className = "champ-donate-tip";
    modal.innerHTML = `
      <div class="champ-donate-tip-backdrop" data-support-author-close></div>
      <div class="champ-donate-tip-card" role="dialog" aria-modal="true" aria-labelledby="support-author-title">
        <header class="champ-donate-tip-head">
          <h3 id="support-author-title">👊 Respect！给服务器加点油</h3>
          <button type="button" class="champ-donate-tip-close" data-support-author-close aria-label="关闭">×</button>
        </header>
        <p class="champ-donate-tip-copy">为了给家人们做个好玩的 K-pop 专属小游戏，本站的所有开销都是我自掏腰包，纯靠“为爱发电”。现在流量越来越大，服务器急需升级才能保证大家顺畅访问。如果你玩得开心，欢迎赞助一瓶水钱，帮助网站持续运营下去，感谢支持！</p>
        <p class="champ-donate-tip-perk">🔥 福利放送：扫码赞助后有<button type="button" class="champ-donate-tip-perk-link" data-support-author-perks>特殊福利</button>哦</p>
        <figure class="champ-donate-tip-qr">
          <img src="${CHAMP_DONATE_QR_SRC}" alt="微信赞赏码" width="132" height="132" decoding="async" />
        </figure>
        <p class="champ-donate-tip-hint">微信扫一扫</p>
        <button type="button" class="champ-donate-tip-dismiss" data-support-author-close>知道了</button>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("is-on"));
    const closeModal = () => closeSupportModal();
    modal.querySelectorAll("[data-support-author-close]").forEach((node) => {
      node.addEventListener("click", closeModal);
    });
    modal.querySelector("[data-support-author-perks]")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeModal();
      openSupportSite({ scrollToPerks: true });
    });
  };

  supportBtn?.addEventListener("click", () => {
    openSupportModal();
  });


  const downloadShareFile = (file) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name || "HeipaClub-Bracket.jpg";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  };

  saveBtn?.addEventListener("click", async () => {
    if (!shareReady) {
      saveBtn.disabled = true;
      saveBtn.classList.add("is-busy");
      saveBtn.textContent = "准备中…";
      try {
        setShareReady(await prepareNativeSharePayload(state));
      } catch {
        setShareFail();
        return;
      }
    }
    if (!shareReady?.file) return;
    try {
      downloadShareFile(shareReady.file);
      saveBtn.textContent = "已保存";
      saveBtn.classList.add("is-ok");
      setTimeout(() => {
        if (saveBtn.isConnected) {
          saveBtn.textContent = "保存照片";
          saveBtn.classList.remove("is-ok");
        }
      }, 1600);
    } catch {
      saveBtn.textContent = "保存失败";
      setTimeout(() => {
        if (saveBtn.isConnected) saveBtn.textContent = "保存照片";
      }, 1400);
    }
  });

  shareBtn?.addEventListener("click", () => {
    // Must call navigator.share() synchronously in this click stack (iOS Safari).
    if (!shareReady) {
      shareBtn.disabled = true;
      shareBtn.classList.add("is-busy");
      shareBtn.classList.remove("is-fail");
      if (shareLabel) shareLabel.textContent = "准备中…";
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.classList.add("is-busy");
      }
      prepareNativeSharePayload(state)
        .then(setShareReady)
        .catch(setShareFail);
      return;
    }
    if (typeof navigator.share !== "function") {
      if (shareLabel) shareLabel.textContent = "请用系统分享";
      setTimeout(() => {
        if (shareLabel) shareLabel.textContent = SHARE_CTA_LABEL;
      }, 1400);
      return;
    }
    const full = {
      files: [shareReady.file],
      title: shareReady.title,
      text: shareReady.text,
    };
    const filesOnly = { files: [shareReady.file] };
    const payload =
      typeof navigator.canShare === "function"
        ? navigator.canShare(full)
          ? full
          : navigator.canShare(filesOnly)
            ? filesOnly
            : null
        : full;
    if (!payload) {
      if (shareLabel) shareLabel.textContent = "暂不支持分享";
      setTimeout(() => {
        if (shareLabel) shareLabel.textContent = SHARE_CTA_LABEL;
      }, 1400);
      return;
    }
    navigator.share(payload).catch((e) => {
      if (e?.name === "AbortError") return;
      if (shareLabel) {
        shareLabel.textContent = "分享失败";
        setTimeout(() => {
          shareLabel.textContent = SHARE_CTA_LABEL;
        }, 1400);
      }
    });
  });

  };

  requestAnimationFrame(mountHeavyShareBody);
}
/** Prefetch File for Web Share API — Music Cup style Canvas draw (fast + crisp). */
async function prepareNativeSharePayload(state) {
  const { champion } = podiumFromBracket(state.bracket);
  const title = `${state.artistName || ""} 本命曲对阵图`;
  const textBody = `冠军：${champion?.title || ""} · 扫码玩 heipaclub.com`;
  const { buildShareCardBlob } = await getShareCardModule();
  const blob = await buildShareCardBlob(state);
  const file = new File([blob], "HeipaClub-Bracket.jpg", {
    type: blob.type || "image/jpeg",
  });
  return { file, title, text: textBody };
}

/** @deprecated */
async function downloadShareCard(state) {
  const payload = await prepareNativeSharePayload(state);
  await shareOrDownloadBlob(payload.file, "HeipaClub-Bracket.jpg", {
    title: payload.title,
    text: payload.text,
  });
}

function isLikelyMobileShareClient() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS desktop UA
  if (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua)) return true;
  return false;
}

async function blobToJpeg(blob, quality = 0.72) {
  if (blob.type === "image/jpeg" && quality >= 0.85) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    let w = bitmap.width;
    let h = bitmap.height;
    // Cap long edge so share stays ~hundreds of KB
    const maxEdge = 1280;
    if (Math.max(w, h) > maxEdge) {
      const s = maxEdge / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e4e1da";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("jpeg failed"))), "image/jpeg", quality);
    });
    return jpeg;
  } finally {
    bitmap.close?.();
  }
}

/**
 * Open the OS share sheet with an image file.
 * Must be called directly from a user gesture on iOS Safari.
 */
async function invokeNativeShare({ file, title = "", text = "" }) {
  if (typeof navigator.share !== "function") {
    throw new Error("Web Share API unavailable");
  }
  const data = { files: [file], title, text };
  if (typeof navigator.canShare === "function" && !navigator.canShare(data)) {
    // Retry files-only — some WebViews reject title/text + files together
    const filesOnly = { files: [file] };
    if (!navigator.canShare(filesOnly)) {
      throw new Error("canShare files unsupported");
    }
    await navigator.share(filesOnly);
    return;
  }
  try {
    await navigator.share(data);
  } catch (e) {
    if (e?.name === "AbortError") return;
    // One more try without title/text
    try {
      await navigator.share({ files: [file] });
    } catch (e2) {
      if (e2?.name === "AbortError") return;
      throw e2;
    }
  }
}

async function shareOrDownloadBlob(blob, fileName, { title = "", text = "" } = {}) {
  try {
    const jpeg = await blobToJpeg(blob).catch(() => blob);
    const type = jpeg.type || "image/jpeg";
    const ext = type.includes("png") ? "png" : "jpg";
    const file = new File([jpeg], `HeipaClub-Bracket.${ext}`, { type });
    await invokeNativeShare({ file, title, text });
    return;
  } catch (e) {
    if (e?.name === "AbortError") return;
    // Mobile: never fake a download click — that triggers Safari's ugly prompt.
    if (isLikelyMobileShareClient()) {
      throw e;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "HeipaClub-Bracket.png";
  a.click();
  URL.revokeObjectURL(url);
}

function pickButton(side, song, fallback, { dreamFactory = false } = {}) {
  const chapterBadge = dreamFactory && song?.chapterLabel
    ? `<span class="pick-chapter-badge pick-chapter-${String(song.chapter || "").replace(/[^a-z0-9-]/gi, "")}">${esc(song.chapterLabel)}</span>`
    : "";
  const labelBadge = song?.labelName
    ? `<span class="pick-label-badge">${esc(song.labelName)}</span>`
    : "";
  const artistLine = song?.artist || "";
  const blurbLine = dreamFactory && song?.blurb
    ? `<p class="pick-blurb">${esc(song.blurb)}</p>`
    : "";
  const sideLabel = dreamFactory ? `STAGE ${side.toUpperCase()}` : `TRACK ${side.toUpperCase()}`;
  const cta = dreamFactory ? "选这个舞台晋级" : "选这首晋级";
  const preview = song?.playSource === "none" && !song?.previewUrl
    ? `<span class="preview-unavailable">暂无试听</span>`
    : `<button type="button" class="preview-btn" data-preview="${side}">试听</button>`;
  return `
    <div class="pick-wrap">
      <button type="button" class="pick${dreamFactory ? " pick-dream" : ""}" data-side="${side}">
        ${progressivePickCover(song, fallback)}
        <div class="pick-copy">
          <div class="side">${sideLabel}${chapterBadge}${labelBadge}</div>
          <h2 class="title">${esc(song.title)}</h2>
          <p class="album">${esc(artistLine)}</p>
          ${blurbLine}
          <span class="cta">${cta}</span>
        </div>
      </button>
      ${preview}
    </div>
  `;
}

function renderChamp(state) {
  const c = state.bracket.champion;
  const isDreamFactory = state.cupType === "dream-factory";
  const avatar = state.artistAvatar || "";
  const { runnerUp, semis } = podiumFromBracket(state.bracket);
  const songId = String(c?.id || "").trim();
  let initialWins = Number(state.champSongWins || 0) || 0;
  if (!initialWins && songId) {
    try {
      const cacheKey = isDreamFactory
        ? `idolshow:stage-wins:${songId}`
        : `idolshow:song-wins:${songId}`;
      initialWins = Number(sessionStorage.getItem(cacheKey) || 0) || 0;
    } catch (_) {}
  }

  void getShareCardModule()
    .then((mod) => mod.warmShareCovers(state))
    .catch(() => {});

  const songTitleHtml = `<span class="champ-social-song">「${esc(c.title)}」</span>`;
  const socialNoun = isDreamFactory ? "神级舞台" : "冠军歌曲";
  const socialHtml =
    initialWins > 0
      ? `有 ${initialWins.toLocaleString("zh-CN")} 人和你一样选择了${songTitleHtml}作为${socialNoun}`
      : `正在统计有多少人和你一样选择了${songTitleHtml}…`;

  const againHomeLabel = isDreamFactory ? "再抽一轮" : "换个艺人";

  app.innerHTML = shell(
    `
    <section class="champ champ-cup">
      <div class="champ-cup-stage">
        <p class="champ-cup-artist"><span class="rapper-name">${esc(
          state.artistName || ""
        )}</span></p>
        <p class="champ-cup-born">冠军诞生</p>
        <p class="champ-cup-brand brand-wordmark" aria-label="Idol 巅峰对决">
          <span class="brand-heipa">Idol</span><span class="brand-duel">巅峰对决</span>
        </p>
        <p class="champ-cup-champion-word">C H A M P I O N</p>
        <div class="champ-cup-cover-wrap">
          ${imgTag(coverUrl(c, avatar), {
            alt: c.title,
            className: "champ-cup-cover",
            size: IMAGE_SIZES.champ,
            loading: "eager",
            fetchPriority: "high",
            width: 280,
            height: 280,
            sizes: "(max-width: 640px) 72vw, 280px",
            responsive: true,
          })}
          ${
            c?.previewUrl || c?.playSource === "itunes"
              ? `<button type="button" class="champ-cover-play" id="champ-cover-play" aria-label="试听冠军曲">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l11-6.5L8 5.5z"/></svg>
          </button>`
              : ""
          }
        </div>
        <h1 class="champ-cup-title">${esc(c.title)}</h1>
        <p class="champ-cup-meta">${esc(isDreamFactory ? `${c.chapterLabel || ""} · ${c.artist || ""}` : metaLine(c))}</p>
        ${isDreamFactory && c?.blurb ? `<p class="champ-cup-blurb">${esc(c.blurb)}</p>` : ""}
      </div>

      <div class="podium-row">
        ${podiumCard("亚军", "RUNNER-UP", runnerUp, avatar)}
        ${podiumCard("四强", "SEMI", semis[0], avatar)}
        ${podiumCard("四强", "SEMI", semis[1], avatar)}
      </div>

      <p class="champ-social-proof" id="champ-social-proof">${socialHtml}</p>

      ${c?.previewUrl || c?.playSource === "itunes" || c?.neteaseId ? `<div id="player-mount" class="player-mount champ-player" hidden></div>` : ""}

      <div class="champ-cup-actions">
        <button type="button" class="primary-btn share-bracket-btn" id="share-bracket-btn">生成专属于你的对阵图</button>
        <div class="champ-cup-secondary">
          <button type="button" class="ghost-btn" id="again-same">再来一场</button>
          <button type="button" class="ghost-btn" id="again-home">${againHomeLabel}</button>
          ${
            isDreamFactory
              ? `<a class="ghost-btn" href="#/rank/stages">看神级舞台榜</a>`
              : ""
          }
        </div>
      </div>
    </section>
  `,
    {
      back: "/",
      actions: `<a class="ghost-btn rank-link" href="${
        isDreamFactory ? "#/rank/stages" : "#/rank"
      }">${isDreamFactory ? "神级舞台榜" : "排行榜"}</a>`,
    }
  );
  bindBack();

  const socialEl = document.getElementById("champ-social-proof");
  const paintSocial = (wins) => {
    const n = Number(wins || 0);
    if (!socialEl || n <= 0) return;
    socialEl.innerHTML = `有 ${n.toLocaleString("zh-CN")} 人和你一样选择了<span class="champ-social-song">「${esc(
      c.title
    )}」</span>作为${socialNoun}`;
  };

  let player = null;
  const openChampPlayer = async () => {
    const mount = document.getElementById("player-mount");
    const playBtn = document.getElementById("champ-cover-play");
    if (!mount) return;
    mount.hidden = false;
    playBtn?.classList.add("is-open");
    if (!player) {
      player = createPlayer(mount);
    }
    await player.load(c, {
      autoplay: true,
      artistName: c.rosterArtistName || state.artistName || "",
      artistAliases: [state.artistSearch, c.rosterArtistName].filter(Boolean),
      mapArtistId: c.rosterArtistId || state.artistId || "",
    });
    const card = document.getElementById("cup-player");
    if (card) card.hidden = false;
  };
  document.getElementById("champ-cover-play")?.addEventListener("click", () => {
    openChampPlayer().catch(() => {});
  });

  // still report wins silently（决冠时已报过则 session 去重跳过）
  {
    const payload = {
      song: c,
      artistId: String(state.itunesArtistId || state.artistId || c.stageId || c.id || ""),
      artistName: isDreamFactory ? "梦回大厂" : state.artistName,
      artistAvatar: isDreamFactory ? c.cover || c.coverSm || avatar : avatar,
    };
    if (isDreamFactory) {
      payload.cupType = "dream-factory";
      payload.chapter = c.chapter || "";
    }
    reportChampionWin(payload)
      .then(async (data) => {
        if (data?.songWins != null) {
          paintSocial(data.songWins);
          try {
            const st = loadState() || state;
            st.champSongWins = Number(data.songWins) || 0;
            saveState(st);
          } catch (_) {}
          return;
        }
        if (initialWins > 0) return;
        try {
          if (isDreamFactory) {
            const rank = await fetchStageRank({ limit: 50, q: c.title || "" });
            const hit = (rank.items || []).find(
              (item) =>
                String(item.stageId || item.songId || "") === songId ||
                String(item.title || "").toLowerCase() === String(c.title || "").toLowerCase()
            );
            if (hit?.wins) paintSocial(hit.wins);
          } else {
            const rank = await fetchSongRank({ limit: 20, q: c.title || "" });
            const hit = (rank.items || []).find(
              (item) =>
                String(item.songId || "") === songId ||
                String(item.title || "").toLowerCase() === String(c.title || "").toLowerCase()
            );
            if (hit?.wins) paintSocial(hit.wins);
          }
        } catch (_) {}
      })
      .catch(() => {});
  }

  const shareOpenBtn = document.getElementById("share-bracket-btn");
  const warmShare = () => {
    void getShareCardModule()
      .then((mod) => mod.warmShareCovers(state))
      .catch(() => {});
  };
  shareOpenBtn?.addEventListener("pointerdown", warmShare, { once: true, passive: true });
  shareOpenBtn?.addEventListener("mouseenter", warmShare, { once: true, passive: true });
  shareOpenBtn?.addEventListener("click", () => {
    trackEvent("share_open");
    if (shareOpenBtn) {
      shareOpenBtn.disabled = true;
      shareOpenBtn.textContent = "正在打开…";
    }
    runAfterNextPaint(() => {
      openShareBracket(state);
      if (shareOpenBtn?.isConnected) {
        shareOpenBtn.disabled = false;
        shareOpenBtn.textContent = "生成专属于你的对阵图";
      }
    });
  });
  document.getElementById("again-same").addEventListener("click", () => {
    clearState();
    if (isDreamFactory) navigate("/dream-factory");
    else navigate(`/artist/${state.artistId}`);
  });
  document.getElementById("again-home").addEventListener("click", () => {
    clearState();
    navigate("/");
  });

  maybeShowChampDonateTip();
}

const WEEKLY_HOT_COLORS = ["#4a6d8f", "#5a8ab8", "#6a9fd4", "#7fb3e0", "#9ec5eb"];
const WEEKLY_HOT_NAME_COLORS = ["#9ec5eb", "#7fb3e0", "#6a9fd4", "#5a8ab8", "#4a6d8f"];

function truncateChartName(name, max = 5) {
  const s = String(name || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function renderWeeklyHotChart(data) {
  const artists = (Array.isArray(data?.artists) ? data.artists : [])
    .slice(0, 5)
    .map((a) => ({
      name: a.name || "未知",
      total: Number(a.total) || 0,
    }));
  if (!artists.length) {
    return `<div class="rank-weekly-hot-empty">近 7 日热度 · 自 8.27 起统计<br />投票后将显示 Top 5</div>`;
  }

  const w = 320;
  const h = 168;
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 36;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const maxY = Math.max(1, ...artists.map((a) => a.total));
  const n = artists.length;
  const gap = 10;
  const barW = Math.min(44, (plotW - gap * (n - 1)) / n);
  const totalBarsW = n * barW + (n - 1) * gap;
  const startX = padL + (plotW - totalBarsW) / 2;

  const bars = artists
    .map((a, i) => {
      const color = WEEKLY_HOT_COLORS[i % WEEKLY_HOT_COLORS.length];
      const nameColor = WEEKLY_HOT_NAME_COLORS[i % WEEKLY_HOT_NAME_COLORS.length];
      const bh = Math.max(4, (a.total / maxY) * plotH);
      const x = startX + i * (barW + gap);
      const y = padT + plotH - bh;
      const cx = x + barW / 2;
      return `
        <rect class="rank-weekly-hot-bar" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="5" fill="${color}" />
        <text class="rank-weekly-hot-bar-val" x="${cx}" y="${y - 5}" text-anchor="middle">${a.total}</text>
        <text class="rank-weekly-hot-bar-name" x="${cx}" y="${h - 14}" text-anchor="middle" fill="${nameColor}">${esc(truncateChartName(a.name))}</text>
        <text class="rank-weekly-hot-bar-rank" x="${cx}" y="${h - 2}" text-anchor="middle" fill="${nameColor}">#${i + 1}</text>`;
    })
    .join("");

  return `
    <div class="rank-weekly-hot-inner">
      <div class="rank-weekly-hot-title-row">
        <strong class="rank-weekly-hot-title">近 7 日热度 Top 5</strong>
        <span class="rank-weekly-hot-tip">功能上线 8.27</span>
      </div>
      <svg class="rank-weekly-hot-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="近七日歌手热度 Top 5 柱状图">${bars}</svg>
    </div>`;
}

async function mountWeeklyHotChart() {
  const el = document.getElementById("rank-weekly-hot");
  if (!el) return;
  try {
    const data = await fetchArtistsWeeklyHot();
    if (!document.getElementById("rank-weekly-hot")) return;
    el.innerHTML = renderWeeklyHotChart(data);
  } catch {
    if (document.getElementById("rank-weekly-hot")) {
      el.innerHTML = `<div class="rank-weekly-hot-empty">近 7 日热度 · 暂时无法加载</div>`;
    }
  }
}

async function renderRank(tab = "songs") {
  let kindFilter = "all";
  const rankListSkeleton = (rows = 10) =>
    Array.from({ length: rows }, () => `
      <article class="rank-row rank-row-skeleton" aria-hidden="true">
        <div class="rank-num">·</div>
        <div class="rank-cover-skel"></div>
        <div class="rank-meta">
          <div class="rank-skel-line"></div>
          <div class="rank-skel-line short"></div>
        </div>
      </article>
    `).join("");

  app.innerHTML = shell(
    `<section class="rank-page"><p class="loading-line">加载排行榜…</p></section>`,
    { back: "/" }
  );
  bindBack();

  const tabHref = (t) =>
    t === "artists" ? "/rank/artists" : t === "stages" ? "/rank/stages" : "/rank";

  const paint = async (active, q = "") => {
    const showKindFilter = active === "songs" || active === "artists";
    const isArtistBoard = active === "artists";
    app.innerHTML = shell(
      `
      <section class="rank-page">
        <div class="rank-head">
          <div class="rank-head-main">
            <div class="rank-head-title-row">
              <h1>排行榜</h1>
              <div class="rank-total-wins rank-total-wins--accent rank-grand-total" id="rank-grand-total" aria-live="polite">
                <span class="rank-total-wins-label">总参与人数</span>
                <strong>—</strong>
              </div>
            </div>
            <p class="rank-sub" id="rank-sub"></p>
          </div>
          <div class="rank-weekly-hot" id="rank-weekly-hot" aria-live="polite">
            <div class="rank-weekly-hot-empty">近 7 日热度 · 加载中…</div>
          </div>
        </div>
        <div class="rank-tabs" role="tablist" aria-label="排行榜类型">
          <button type="button" class="mode-chip ${active === "songs" ? "active" : ""}" data-rank-tab="songs">歌曲</button>
          <button type="button" class="mode-chip ${active === "artists" ? "active" : ""}" data-rank-tab="artists">艺人</button>
          <button type="button" class="mode-chip ${active === "stages" ? "active" : ""}" data-rank-tab="stages">神级舞台</button>
        </div>
        ${
          showKindFilter
            ? `<div class="filter-row sort-row rank-region-row" id="rank-kind-row" role="group" aria-label="类型榜">
          ${KIND_FILTERS.map(
            (f) =>
              `<button type="button" class="mode-chip ${kindFilter === f.id ? "active" : ""}" data-rank-kind="${f.id}">${f.label}</button>`
          ).join("")}
        </div>`
            : ""
        }
        <div class="search-row search-row-with-total">
          <input id="rank-search" type="search" placeholder="${
            active === "stages" ? "搜索舞台…" : active === "songs" ? "搜索歌曲…" : "搜索艺人…"
          }" value="${esc(q)}" autocomplete="off" />
          <div class="rank-total-wins rank-total-wins--accent" id="rank-total-wins" aria-live="polite">
            <span class="rank-total-wins-label">${
              active === "stages"
                ? "舞台PK次数"
                : active === "songs" || active === "artists"
                  ? "歌曲PK次数"
                  : "参与次数"
            }</span>
            <strong>—</strong>
          </div>
          <div class="rank-total-wins" id="rank-song-count" aria-live="polite">
            <span class="rank-total-wins-label">${
              active === "stages"
                ? "已入围舞台数"
                : isArtistBoard
                  ? "已入围艺人数"
                  : "已入围歌曲数"
            }</span>
            <strong>—</strong>
          </div>
          <p class="rank-anti-brush-note">🔥 战绩已开启防刷保护<br />（每人每天最多计入5次有效评选）</p>
        </div>
        <div id="rank-list" class="rank-list">${rankListSkeleton()}</div>
      </section>
    `,
      { back: "/" }
    );
    bindBack();
    mountWeeklyHotChart();

    let timer = null;
    const input = document.getElementById("rank-search");
    const RANK_PAGE = 25;
    /** @type {any[]} */
    let allItems = [];
    let shownCount = 0;
    /** @type {IntersectionObserver | null} */
    let moreObserver = null;

    const formatWinRate = (wins, battles) => {
      const b = Number(battles || 0);
      const w = Number(wins || 0);
      if (b <= 0) return null;
      return `${Math.round((w / b) * 1000) / 10}%`;
    };

    const songArtistLine = (item) => {
      let artist = String(item.artist || "").trim();
      // 旧厂牌混战曾把「A vs B」写入 artist；优先用 artistId 还原真实歌手名
      if (/^.+\s+vs\s+.+$/i.test(artist)) {
        const nid = String(item.artistId || "").trim();
        const local = nid
          ? ARTISTS.find((a) => String(a.itunesArtistId || "") === nid)
          : null;
        artist = String(local?.name || "").trim();
      }
      return `${artist || "未知歌手"} · 单曲夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次`;
    };

    const renderRankRow = (item, i, activeTab) => {
      const rank = i + 1;
      const rankClass = rank <= 3 ? `top${rank}` : "";
      const titleClass = rank <= 3 ? `rank-title top${rank}` : "rank-title";
      if (activeTab === "songs") {
        return `
          <article class="rank-row">
            <div class="rank-num ${rankClass}">${rank}</div>
            ${imgTag(item.cover, {
              alt: item.title,
              className: "rank-cover",
              size: IMAGE_SIZES.list,
              width: 52,
              height: 52,
            })}
            <div class="rank-meta">
              <div class="${titleClass}">${esc(item.title)}</div>
              <div class="rank-desc">${esc(songArtistLine(item))}</div>
            </div>
          </article>`;
      }
      if (activeTab === "stages") {
        return `
          <article class="rank-row">
            <div class="rank-num ${rankClass}">${rank}</div>
            ${imgTag(item.cover, {
              alt: item.title,
              className: "rank-cover",
              size: IMAGE_SIZES.list,
              width: 52,
              height: 52,
            })}
            <div class="rank-meta">
              <div class="${titleClass}">${esc(item.title)}</div>
              <div class="rank-desc">${esc(item.chapter || item.artist || "")} · 夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</div>
            </div>
          </article>`;
      }
      return `
        <article class="rank-row">
          <div class="rank-num ${rankClass}">${rank}</div>
          ${imgTag(item.avatar || item.cover, {
            alt: item.name,
            className: "rank-cover round",
            size: IMAGE_SIZES.list,
            width: 52,
            height: 52,
          })}
          <div class="rank-meta">
            <div class="${titleClass}">${esc(item.name)}</div>
            <div class="rank-desc">单曲夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</div>
          </div>
        </article>`;
    };

    const bindRankMore = (box) => {
      moreObserver?.disconnect();
      moreObserver = null;
      const sentinel = box.querySelector("#rank-more-sentinel");
      if (!sentinel || shownCount >= allItems.length) {
        sentinel?.remove();
        return;
      }
      moreObserver = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          const next = allItems.slice(shownCount, shownCount + RANK_PAGE);
          if (!next.length) {
            sentinel.remove();
            moreObserver?.disconnect();
            return;
          }
          const html = next.map((item, i) => renderRankRow(item, shownCount + i, active)).join("");
          sentinel.insertAdjacentHTML("beforebegin", html);
          shownCount += next.length;
          if (shownCount >= allItems.length) {
            sentinel.remove();
            moreObserver?.disconnect();
          }
        },
        { root: null, rootMargin: "200px 0px", threshold: 0 }
      );
      moreObserver.observe(sentinel);
    };

    const formatStat = (n) => {
      const value = Number(n);
      return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
    };

    const modePlaysLabel = (tab) => {
      if (tab === "stages") return "舞台PK次数";
      if (tab === "songs" || tab === "artists") return "歌曲PK次数";
      return "参与次数";
    };

    const modePlaysFromParticipation = (tab, p) => {
      if (!p) return null;
      if (tab === "stages") return p.stagePk ?? p.total;
      if (tab === "songs" || tab === "artists") return p.songPk;
      return p.total;
    };

    const updateRankStatsUi = ({
      grandTotal,
      modePlays,
      modeLabel,
      songCount,
      countLabel,
    } = {}) => {
      const grandEl = document.getElementById("rank-grand-total");
      if (grandEl && grandTotal != null) {
        grandEl.innerHTML = `<span class="rank-total-wins-label">总参与人数</span><strong>${formatStat(
          grandTotal
        )}</strong>`;
      }
      const winsEl = document.getElementById("rank-total-wins");
      if (winsEl && modePlays != null) {
        winsEl.innerHTML = `<span class="rank-total-wins-label">${
          modeLabel || modePlaysLabel(active)
        }</span><strong>${formatStat(modePlays)}</strong>`;
      }
      const songsEl = document.getElementById("rank-song-count");
      if (songsEl && songCount != null) {
        songsEl.innerHTML = `<span class="rank-total-wins-label">${
          countLabel || "已入围歌曲数"
        }</span><strong>${formatStat(songCount)}</strong>`;
      }
    };

    const loadList = async (query) => {
      const box = document.getElementById("rank-list");
      if (!box) return;
      moreObserver?.disconnect();
      moreObserver = null;
      shownCount = 0;
      allItems = [];
      box.innerHTML = rankListSkeleton();
      try {
        let items = [];
        let updatedAt = null;
        let participation = null;
        let songCount = null;
        let stale = false;
        const applySub = (base) => {
          const sub = document.getElementById("rank-sub");
          if (!sub) return;
          sub.textContent = stale
            ? `${base} · 数据可能延迟，稍后再刷新`
            : base;
        };
        // Pull a large board once; UI reveals it in pages of RANK_PAGE on scroll.
        // Always request without server `q` so KV/local cache can hit; filter locally.
        if (active === "songs") {
          const data = await fetchSongRank({ limit: 150, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.songCount;
          items = filterRankItemsByQuery(
            filterRankItemsByKind(data.items || [], kindFilter, "songs"),
            query,
            "songs"
          );
        } else if (active === "stages") {
          const data = await fetchStageRank({ limit: 150, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.stageCount ?? data.songCount;
          items = filterRankItemsByQuery(data.items || [], query, "songs");
        } else {
          const data = await fetchArtistRank({ limit: 150, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.artistCount ?? data.songCount;
          items = filterRankItemsByQuery(
            filterRankItemsByKind(data.items || [], kindFilter, "artists"),
            query,
            "artists"
          );
        }

        if (!participation || songCount == null) {
          try {
            const meta = await fetchRankMeta();
            if (!participation) participation = meta.participation || null;
            if (songCount == null) {
              songCount =
                active === "artists"
                  ? meta.artistCount ?? meta.songCount
                  : active === "stages"
                    ? meta.stageCount ?? meta.songCount
                    : meta.songCount;
            }
            if (meta._stale) stale = true;
          } catch {
            /* keep list even if meta fails */
          }
        }
        updateRankStatsUi({
          grandTotal: participation?.total,
          modePlays: modePlaysFromParticipation(active, participation),
          songCount,
          countLabel:
            active === "stages"
              ? "已入围舞台数"
              : active === "artists"
                ? "已入围艺人数"
                : "已入围歌曲数",
        });

        const kindLabel = kindFilterMeta(kindFilter).label;
        if (active === "songs") {
          applySub("冠军单曲排行 · 约每 5 分钟刷新");
        } else if (active === "artists") {
          const board = `${kindLabel}艺人榜 · 按单曲夺冠次数`;
          applySub(updatedAt ? `${board} · ${String(updatedAt).slice(0, 10)}` : `${board} · 约每 5 分钟刷新`);
        } else if (active === "stages") {
          applySub("梦回大厂神级舞台榜 · 约每 5 分钟刷新");
        }

        if (!items.length) {
          box.innerHTML = `<p class="loading-line">${
            active === "stages"
              ? "暂无舞台数据，去打一场「梦回大厂」吧"
              : active === "artists"
                ? "暂无艺人数据，去打一场单曲对决吧"
                : query
                  ? "没有匹配的结果"
                  : "暂无数据"
          }</p>`;
          return;
        }

        allItems = items;
        const first = allItems.slice(0, RANK_PAGE);
        shownCount = first.length;
        const more =
          shownCount < allItems.length
            ? `<div id="rank-more-sentinel" class="rank-more-sentinel" aria-hidden="true"></div>`
            : "";
        box.classList.remove("rank-list-hangla");
        box.innerHTML =
          first.map((item, i) => renderRankRow(item, i, active)).join("") + more;
        bindRankMore(box);
      } catch (e) {
        showLoadBanner();
        box.innerHTML = `
          <p class="loading-line">排行榜加载失败</p>
          <p class="rank-retry-hint">访问高峰时可能稍慢，请重试。若曾成功打开过，刷新后会优先显示本地缓存。</p>
          <button type="button" class="ghost-btn" id="rank-retry-btn">重新加载</button>`;
        document.getElementById("rank-retry-btn")?.addEventListener("click", () => {
          loadList(query);
        });
      }
    };

    document.querySelectorAll("[data-rank-tab]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const next = chip.dataset.rankTab;
        navigate(tabHref(next));
      });
    });

    document.querySelectorAll("[data-rank-kind]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const next = chip.dataset.rankKind || "all";
        if (next === kindFilter) return;
        kindFilter = next;
        document.querySelectorAll("[data-rank-kind]").forEach((c) => {
          c.classList.toggle("active", c.dataset.rankKind === kindFilter);
        });
        loadList(input?.value?.trim() || "");
      });
    });

    input?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadList(input.value.trim()), 220);
    });

    await loadList(q);
  };

  await paint(tab);
}

function metaLine(song) {
  if (!song) return "";
  const album = song.album || song.collection || "";
  let year = song.year || "";
  if (!year && song.publishTime) {
    const y = new Date(Number(song.publishTime)).getFullYear();
    if (y && !Number.isNaN(y)) year = String(y);
  }
  return [album, year].filter(Boolean).join(" · ") || album || "单曲";
}

function uniquePath(path, champion) {
  const seen = new Set();
  const out = [];
  for (const s of path) {
    if (!s?.title || seen.has(s.id || s.title)) continue;
    seen.add(s.id || s.title);
    out.push(s);
  }
  if (champion && !seen.has(champion.id || champion.title)) out.push(champion);
  return out;
}

window.addEventListener("hashchange", render);
bootstrap();
