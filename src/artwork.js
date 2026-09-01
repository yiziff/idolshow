export function coverUrl(song, fallback = "") {
  return song?.cover || song?.coverSm || fallback || "";
}

/** Allowed NetEase / display thumb sizes (keeps CDN + Worker cache keys bounded). */
export const IMAGE_SIZES = Object.freeze({
  chip: 96,
  list: 128,
  avatar: 192,
  setup: 256,
  match: 320,
  champ: 640,
  shareThumb: 96,
  shareChamp: 400,
  shareAvatar: 360,
});

const ALLOWED_SIZES = new Set([
  48, 64, 96, 128, 160, 192, 200, 256, 320, 360, 400, 512, 640, 800,
]);

export function normalizeImageSize(size, fallback = 192) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const rounded = Math.round(n);
  if (ALLOWED_SIZES.has(rounded)) return rounded;
  let best = fallback;
  let bestDist = Infinity;
  for (const s of ALLOWED_SIZES) {
    const d = Math.abs(s - rounded);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

function isNeteaseHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h.includes("126.net") || h.includes("music.126");
}

function isItunesHost(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .includes("mzstatic.com");
}

/** Prefer tiny CDN thumbs for share cards (saves MBs vs full covers). */
export function sizedCoverUrl(src, size = 96) {
  const url = String(src || "").trim();
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
  const dim = normalizeImageSize(size, 96);
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.href : "https://heipaclub.com");
    const host = u.hostname.toLowerCase();
    if (isNeteaseHost(host)) {
      // Replace existing ?param=… so we never stack params or keep oversized thumbs.
      return `${u.origin}${u.pathname}?param=${dim}y${dim}`;
    }
    if (isItunesHost(host)) {
      // iTunes: .../source/100x100bb.jpg style — keep as-is if already sized
      return url.replace(/\/\d+x\d+bb\./, `/${dim}x${dim}bb.`);
    }
  } catch {
    /* keep original */
  }
  return url;
}

/** Same-origin proxy so html-to-image / canvas can read covers (CORS). */
export function proxiedImageUrl(src, size) {
  const url = String(src || "").trim();
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  if (url.startsWith("/api/img")) return url;
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.href : "https://heipaclub.com");
    if (typeof location !== "undefined" && u.origin === location.origin) return url;
  } catch {
    /* keep going */
  }
  const dim = size ? normalizeImageSize(size) : 0;
  const qs = dim ? `&s=${dim}` : "";
  return `/api/img?u=${encodeURIComponent(url)}${qs}`;
}

/**
 * Optimized display URL:
 * - resize NetEase / iTunes thumbs to UI size
 * - route NetEase (and optional all remote) images through /api/img for edge cache
 */
export function optimizedImageUrl(src, { size = 192, proxy = "netease" } = {}) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:") || raw.startsWith("blob:")) return raw;

  const dim = normalizeImageSize(size, 192);
  const sized = sizedCoverUrl(raw, dim);
  if (proxy === false) return sized;

  try {
    const u = new URL(sized, typeof location !== "undefined" ? location.href : "https://heipaclub.com");
    if (typeof location !== "undefined" && u.origin === location.origin) return sized;
    if (proxy === true) return proxiedImageUrl(sized, dim);
    if (proxy === "netease" && isNeteaseHost(u.hostname)) return proxiedImageUrl(sized, dim);
  } catch {
    /* keep sized */
  }
  return sized;
}

function escAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export const IMG_FALLBACK_SRC =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect fill="#e6e4df" width="100%" height="100%"/></svg>`
  );

/** proxy fail → direct CDN → grey SVG. Never strip src (avoids broken-image icon). */
export function onCoverError(img) {
  if (!img || img.dataset.imgErr === "2") return;
  const direct = img.getAttribute("data-direct-src") || img.dataset.directSrc || "";
  if (direct && img.dataset.imgErr !== "1") {
    img.dataset.imgErr = "1";
    img.removeAttribute("srcset");
    img.src = direct;
    return;
  }
  img.dataset.imgErr = "2";
  img.removeAttribute("srcset");
  img.removeAttribute("data-full-src");
  img.src = IMG_FALLBACK_SRC;
  img.classList.add("img-broken", "img-fallback");
}

export function installCoverErrorHandler() {
  if (typeof window === "undefined") return;
  window.__heipaImgError = onCoverError;
}

function imgOnErrorAttr() {
  return ` onerror="window.__heipaImgError&&window.__heipaImgError(this)"`;
}

function directSrcAttr(src, size) {
  const direct = sizedCoverUrl(src, size ?? IMAGE_SIZES.avatar);
  if (!direct || direct.startsWith("data:") || direct.startsWith("blob:") || direct.startsWith("/")) {
    return "";
  }
  return ` data-direct-src="${escAttr(direct)}"`;
}

export function bindImageFallback(img) {
  if (!img || img.dataset.fallbackBound === "1") return;
  img.dataset.fallbackBound = "1";
  img.addEventListener("error", () => onCoverError(img));
}

installCoverErrorHandler();

function buildResponsiveSrcset(src, { size, proxy }) {
  const base = normalizeImageSize(size ?? IMAGE_SIZES.avatar, IMAGE_SIZES.avatar);
  const candidates = Array.from(
    new Set([
      base,
      normalizeImageSize(Math.round(base * 1.5), base),
      normalizeImageSize(base * 2, base),
    ])
  )
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (candidates.length <= 1) return "";
  const parts = candidates.map((dim) => {
    const href = optimizedImageUrl(src, { size: dim, proxy });
    return href ? `${href} ${dim}w` : "";
  });
  return parts.filter(Boolean).join(", ");
}

/**
 * @param {string} src
 * @param {{
 *   alt?: string,
 *   className?: string,
 *   size?: number,
 *   proxy?: boolean | "netease",
 *   loading?: "lazy" | "eager",
 *   fetchPriority?: "high" | "low" | "auto",
 *   width?: number,
 *   height?: number,
 *   sizes?: string,
 *   responsive?: boolean,
 * }} [opts]
 */
export function imgTag(
  src,
  {
    alt = "",
    className = "",
    size,
    proxy = "netease",
    loading = "lazy",
    fetchPriority = "auto",
    width,
    height,
    sizes,
    responsive = false,
  } = {}
) {
  const safeAlt = escAttr(alt);
  if (!src) {
    return `<div class="${className} img-fallback" aria-hidden="true"></div>`;
  }
  const href = optimizedImageUrl(src, {
    size: size ?? IMAGE_SIZES.avatar,
    proxy,
  });
  const safeHref = escAttr(href);
  const loadingAttr = loading === "eager" ? "eager" : "lazy";
  const prio =
    fetchPriority === "high" || fetchPriority === "low"
      ? ` fetchpriority="${fetchPriority}"`
      : "";
  const w = width != null ? ` width="${Number(width) || ""}"` : "";
  const h = height != null ? ` height="${Number(height) || ""}"` : "";
  const srcset =
    responsive && !href.startsWith("data:") && !href.startsWith("blob:")
      ? buildResponsiveSrcset(src, { size: size ?? IMAGE_SIZES.avatar, proxy })
      : "";
  const srcsetAttr = srcset ? ` srcset="${escAttr(srcset)}"` : "";
  const sizesAttr = sizes ? ` sizes="${escAttr(sizes)}"` : "";
  const directAttr = directSrcAttr(src, size ?? IMAGE_SIZES.avatar);
  return `<img class="${className}" src="${safeHref}"${directAttr}${srcsetAttr}${sizesAttr} alt="${safeAlt}" loading="${loadingAttr}" decoding="async" referrerpolicy="no-referrer"${prio}${w}${h}${imgOnErrorAttr()} />`;
}
