/**
 * HeipaClub share card — Music Cup style: pure Canvas 2D, not html2canvas.
 * Fixed 1080w → crisp lines/text, fast draw, JPEG under ~600KB.
 *
 * Cover images are warm-cached (Map) after bracket is ready so share draw is near-instant.
 */
import QRCode from "qrcode";
import { coverUrl, proxiedImageUrl, sizedCoverUrl } from "./artwork.js";

const W = 1080;
const SITE_URL = "https://idolshow.local";
const FONT = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
const ACC = "#6a9fd4";
const ACC_BRIGHT = "#9ec5eb";
const INK = "#111110";
const MUTED = "#5c5a55";
const CREAM = "#e8e6e1";
const CREAM_DEEP = "#d6d2ca";

/** @type {Map<string, HTMLImageElement | null>} null = confirmed failure */
const coverCache = new Map();
/** @type {Map<string, Promise<HTMLImageElement | null>>} */
const inflight = new Map();

const THUMB_SIZE = 96;
const CHAMP_SIZE = 400;
const AVATAR_SIZE = 360;
const WARM_CONCURRENCY = 8;

function songKey(song) {
  if (!song) return "";
  return String(song.id || song.neteaseId || song.title || "");
}

function sameSong(a, b) {
  const ka = songKey(a);
  const kb = songKey(b);
  return Boolean(ka && kb && ka === kb);
}

function metaLine(song) {
  if (!song) return "";
  const album = song.album || song.collection || "";
  let year = song.year || "";
  if (!year && song.publishTime) {
    const y = new Date(Number(song.publishTime)).getFullYear();
    if (y && !Number.isNaN(y)) year = String(y);
  }
  return [album, year].filter(Boolean).join(" · ") || album || "";
}

/** Cache key = proxied sized URL (same as draw path). */
function coverCacheKey(src, size) {
  const sized = sizedCoverUrl(src, size);
  if (!sized) return "";
  return proxiedImageUrl(sized, size);
}

/**
 * Load one cover into cache. Dedupes concurrent requests; caches null on failure.
 * @param {string} src raw cover URL
 * @param {number} size
 * @param {number} [ms]
 * @returns {Promise<HTMLImageElement | null>}
 */
function loadImg(src, size, ms = 6000) {
  const key = coverCacheKey(src, size);
  if (!key) return Promise.resolve(null);
  if (coverCache.has(key)) return Promise.resolve(coverCache.get(key) ?? null);
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.referrerPolicy = "no-referrer";
    const t = setTimeout(() => {
      im.src = "";
      coverCache.set(key, null);
      inflight.delete(key);
      resolve(null);
    }, ms);
    im.onload = () => {
      clearTimeout(t);
      coverCache.set(key, im);
      inflight.delete(key);
      resolve(im);
    };
    im.onerror = () => {
      clearTimeout(t);
      coverCache.set(key, null);
      inflight.delete(key);
      resolve(null);
    };
    im.src = key;
  });
  inflight.set(key, job);
  return job;
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const n = Math.min(limit, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return out;
}

function collectShareSongs(state) {
  const bracket = state?.bracket;
  const rounds = bracket?.rounds || [];
  const first = rounds[0] || [];
  const champion = bracket?.champion;
  const avatar = state?.artistAvatar || "";
  const songMap = new Map();
  for (const m of first) {
    for (const s of [m.a, m.b]) {
      if (s) songMap.set(songKey(s), s);
    }
  }
  if (champion) songMap.set(songKey(champion), champion);
  return { songMap, champion, avatar, first, rounds, bracket };
}

/**
 * Background-warm first-round thumbs + champ/avatar. Fire-and-forget from UI.
 * @param {object} state
 * @returns {Promise<void>}
 */
export async function warmShareCovers(state) {
  if (!state?.bracket?.rounds?.[0]?.length) return;
  const { songMap, champion, avatar } = collectShareSongs(state);
  const thumbJobs = [...songMap.values()].map((song) => ({
    src: coverUrl(song, avatar),
    size: THUMB_SIZE,
    ms: 5000,
  }));
  const bigJobs = [];
  if (champion || avatar) {
    bigJobs.push({
      src: coverUrl(champion, avatar),
      size: CHAMP_SIZE,
      ms: 7000,
    });
  }
  if (avatar) {
    bigJobs.push({ src: avatar, size: AVATAR_SIZE, ms: 5000 });
  }
  await mapPool([...thumbJobs, ...bigJobs], WARM_CONCURRENCY, (job) =>
    loadImg(job.src, job.size, job.ms)
  );
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fitText(ctx, text, maxW) {
  let t = String(text ?? "");
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function wrapText(ctx, text, maxW, maxLines) {
  const raw = String(text ?? "");
  const lines = [];
  let cur = "";
  for (const ch of raw) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = fitText(ctx, `${lines[maxLines - 1]}…`, maxW);
  }
  return lines.length ? lines : [""];
}

function hashHue(seed) {
  const s = String(seed || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function placeholderLetter(song) {
  const title = String(song?.title || "").trim();
  if (!title) return "♪";
  const ch = [...title][0];
  return ch || "♪";
}

function drawCover(ctx, img, x, y, size, radius, song = null) {
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    const hue = hashHue(songKey(song) || song?.title || "x");
    ctx.fillStyle = `hsl(${hue} 28% 42%)`;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `700 ${Math.round(size * 0.42)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(placeholderLetter(song), x + size / 2, y + size / 2 + 1);
  }
  ctx.restore();
}

function shortRoundLabel(size, roundIndex) {
  const remaining = size / 2 ** roundIndex;
  if (remaining === 2) return "决赛";
  if (remaining === 4) return "半决赛";
  if (remaining === 8) return "8强";
  return `${remaining}强`;
}

/**
 * @param {object} state
 * @returns {Promise<Blob>}
 */
export async function buildShareCardBlob(state) {
  const { songMap, champion, avatar, first, rounds, bracket } = collectShareSongs(state);
  const size = bracket?.size || first.length * 2 || 16;
  const artistName = state.artistName || "";

  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`900 44px ${FONT}`),
        document.fonts.load(`700 22px ${FONT}`),
        document.fonts.load(`800 34px ${FONT}`),
        document.fonts.load(`400 36px "ZCOOL QingKe HuangYou"`),
      ]),
      new Promise((r) => setTimeout(r, 1200)),
    ]);
  } catch {
    /* system fonts */
  }

  // Prefer warm cache; miss → load (still short timeout)
  const [champImg, artistImg, ...thumbEntries] = await Promise.all([
    loadImg(coverUrl(champion, avatar), CHAMP_SIZE, 7000),
    loadImg(avatar, AVATAR_SIZE, 5000),
    ...[...songMap.entries()].map(async ([key, song]) => {
      const im = await loadImg(coverUrl(song, avatar), THUMB_SIZE, 5000);
      return [key, im];
    }),
  ]);
  const thumbs = new Map(thumbEntries);

  /* Layout — mirror Music Cup column geometry */
  const M = 28;
  const PW = 168;
  const PH = 44;
  const DX = 84;
  const STUB = 11;
  const cols = Math.max(1, rounds.length - 1);
  const PAIR = size >= 32 ? 118 : size >= 16 ? 128 : size >= 8 ? 148 : 168;
  const GAP = size >= 32 ? 62 : size >= 16 ? 70 : 88;
  const pairs = Math.max(1, first.length / 2);
  const blockH = (pairs - 1) * (PAIR + GAP) + PAIR + PH;
  const chartH = Math.max(blockH, 460);
  const padTop = (chartH - blockH) / 2;
  const chartTop = 150;
  const cy = chartTop + chartH / 2;
  const footH = 208;
  const H = Math.ceil(chartTop + chartH + 34 + footH);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  /* Background — artist wash drawn lower (above QR) so champ cover doesn't hide it */
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#f2f0eb");
  bg.addColorStop(0.45, CREAM);
  bg.addColorStop(1, CREAM_DEEP);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* Header — brand wordmark (黑怕 + lime 巅峰对决) like fig.4 */
  ctx.save();
  ctx.translate(W / 2, 48);
  ctx.transform(1, 0, -0.12, 1, 0, 0);
  ctx.font = `400 36px "ZCOOL QingKe HuangYou", ${FONT}`;
  ctx.textBaseline = "middle";
  const heipa = "Idol";
  const duel = "巅峰对决";
  const heipaW = ctx.measureText(heipa).width;
  const duelW = ctx.measureText(duel).width;
  const gap = 4;
  const totalW = heipaW + gap + duelW + 16;
  const x0 = -totalW / 2;
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.fillText(heipa, x0, 0);
  const duelX = x0 + heipaW + gap;
  roundRect(ctx, duelX - 6, -18, duelW + 16, 36, 4);
  ctx.fillStyle = ACC_BRIGHT;
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.fillText(duel, duelX + 2, 0);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `900 44px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(fitText(ctx, artistName || "Idol", W - M * 2), W / 2, 108);
  if (champion?.title) {
    ctx.font = `700 22px ${FONT}`;
    ctx.fillStyle = "#c9a227";
    ctx.fillText(fitText(ctx, `冠军 · ${champion.title}`, W - M * 2), W / 2, 140);
  }

  /* Column Y positions (left/right symmetric) */
  const lv = [];
  {
    const l0 = [];
    for (let p = 0; p < pairs; p++) {
      const yA = chartTop + padTop + PH / 2 + p * (PAIR + GAP);
      l0.push(yA, yA + PAIR);
    }
    lv.push(l0);
    for (let k = 1; k < cols; k++) {
      const prev = lv[k - 1];
      const cur = [];
      for (let i = 0; i < prev.length; i += 2) cur.push((prev[i] + prev[i + 1]) / 2);
      lv.push(cur);
    }
  }

  const colX = (k, side) => (side === 0 ? M + k * DX : W - M - PW - k * DX);

  /** Songs in one half of round r, top→bottom */
  const colSongs = (r, side) => {
    const ms = rounds[r] || [];
    const h = Math.ceil(ms.length / 2);
    const slice = side === 0 ? ms.slice(0, h) : ms.slice(h);
    const out = [];
    for (const m of slice) {
      out.push({
        song: m.a,
        onPath: Boolean(champion && sameSong(m.a, champion)),
        won: Boolean(m.winner && sameSong(m.a, m.winner)),
      });
      out.push({
        song: m.b,
        onPath: Boolean(champion && sameSong(m.b, champion)),
        won: Boolean(m.winner && sameSong(m.b, m.winner)),
      });
    }
    return out;
  };

  /* Champion block metrics — cover +25%, title ~30% larger */
  const A = Math.round((chartH >= 680 ? 168 : 128) * 1.25);
  const titleFs = 42;
  const titleStep = 52;
  ctx.font = `900 ${titleFs}px ${FONT}`;
  const nameLines = wrapText(ctx, champion?.title || "冠军", 440, 2);
  const albumTxt = metaLine(champion);
  const champBlockH =
    A + 16 + 40 + 14 + nameLines.length * titleStep + (albumTxt ? 28 : 0);
  const artY = cy - champBlockH / 2;
  const artX = (W - A) / 2;
  const artCY = artY + A / 2;

  /* Connector lines */
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let side = 0; side < 2; side++) {
    for (let k = 0; k < cols; k++) {
      const x = colX(k, side);
      const edge = side === 0 ? x + PW : x;
      const jx = side === 0 ? edge + STUB : edge - STUB;
      const ys = lv[k];
      ctx.strokeStyle = "rgba(17,17,16,0.14)";
      for (let i = 0; i < ys.length; i += 2) {
        ctx.beginPath();
        ctx.moveTo(edge, ys[i]);
        ctx.lineTo(jx, ys[i]);
        ctx.lineTo(jx, ys[i + 1]);
        ctx.lineTo(edge, ys[i + 1]);
        ctx.stroke();
      }
      if (k === cols - 1) {
        const mid = (ys[0] + ys[1]) / 2;
        ctx.beginPath();
        ctx.moveTo(jx, mid);
        ctx.lineTo(jx, artCY);
        ctx.lineTo(side === 0 ? artX : artX + A, artCY);
        ctx.stroke();
      }
    }
  }

  /* Champion path (green) */
  ctx.strokeStyle = ACC;
  ctx.lineWidth = 2.6;
  for (let side = 0; side < 2; side++) {
    for (let k = 0; k < cols; k++) {
      const entries = colSongs(k, side);
      const i = entries.findIndex((e) => e.onPath);
      if (i < 0) continue;
      const x = colX(k, side);
      const edge = side === 0 ? x + PW : x;
      const jx = side === 0 ? edge + STUB : edge - STUB;
      const y = lv[k][i];
      const nextY = k + 1 < cols ? lv[k + 1][Math.floor(i / 2)] : artCY;
      ctx.beginPath();
      ctx.moveTo(edge, y);
      ctx.lineTo(jx, y);
      ctx.lineTo(jx, nextY);
      if (k === cols - 1) ctx.lineTo(side === 0 ? artX : artX + A, nextY);
      ctx.stroke();
    }
  }

  /* Round labels on outer columns */
  for (let side = 0; side < 2; side++) {
    for (let k = 0; k < cols; k++) {
      const x = colX(k, side);
      ctx.font = `700 15px ${FONT}`;
      ctx.fillStyle = MUTED;
      ctx.textAlign = "center";
      ctx.fillText(shortRoundLabel(size, k), x + PW / 2, chartTop - 10);
    }
  }

  /* Song pills */
  function pill(x, yC, entry) {
    const y = yC - PH / 2;
    const onPath = entry.onPath;
    const won = entry.won;
    const dim = !onPath && !won;
    roundRect(ctx, x, y, PW, PH, 11);
    if (onPath) {
      ctx.fillStyle = "rgba(201, 232, 120, 0.5)";
    } else if (won) {
      ctx.fillStyle = "rgba(255,255,255,0.92)";
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
    }
    ctx.fill();
    if (onPath) {
      ctx.strokeStyle = "rgba(143, 191, 32, 0.55)";
      ctx.lineWidth = 1.6;
      roundRect(ctx, x, y, PW, PH, 11);
      ctx.stroke();
    } else {
      ctx.strokeStyle = dim ? "rgba(17,17,16,0.06)" : "rgba(17,17,16,0.1)";
      ctx.lineWidth = 1.2;
      roundRect(ctx, x, y, PW, PH, 11);
      ctx.stroke();
    }
    const cov = 28;
    const key = songKey(entry.song);
    ctx.save();
    if (dim) ctx.globalAlpha = 0.42;
    else if (won && !onPath) ctx.globalAlpha = 0.82;
    drawCover(ctx, thumbs.get(key), x + 8, y + (PH - cov) / 2, cov, 6, entry.song);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `${onPath ? 700 : won ? 600 : 500} 17px ${FONT}`;
    ctx.fillStyle = dim ? "rgba(17,17,16,0.45)" : INK;
    ctx.fillText(
      fitText(ctx, entry.song?.title || "—", PW - cov - 24),
      x + 8 + cov + 8,
      yC + 1
    );
    ctx.restore();
    ctx.textBaseline = "alphabetic";
  }

  for (let side = 0; side < 2; side++) {
    for (let k = 0; k < cols; k++) {
      const entries = colSongs(k, side);
      const x = colX(k, side);
      entries.forEach((e, i) => {
        if (lv[k][i] != null) pill(x, lv[k][i], e);
      });
    }
  }

  /* Champion cover */
  ctx.save();
  ctx.shadowColor = "rgba(106,159,212,0.28)";
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 10;
  roundRect(ctx, artX, artY, A, A, 22);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();
  drawCover(ctx, champImg, artX, artY, A, 22, champion);
  roundRect(ctx, artX, artY, A, A, 22);
  ctx.strokeStyle = "rgba(17,17,16,0.12)";
  ctx.lineWidth = 2;
  ctx.stroke();

  /* Crown */
  ctx.save();
  ctx.translate(artX + A - 6, artY - 2);
  ctx.rotate(0.28);
  ctx.font = "48px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#c9a227";
  ctx.fillText("♛", 0, 0);
  ctx.restore();

  let y = artY + A + 14;
  const badgeTxt = "冠军 · CHAMPION";
  ctx.font = `800 18px ${FONT}`;
  const badgeW = ctx.measureText(badgeTxt).width + 44;
  roundRect(ctx, (W - badgeW) / 2, y, badgeW, 36, 18);
  const badgeGrad = ctx.createLinearGradient((W - badgeW) / 2, y, (W + badgeW) / 2, y);
  badgeGrad.addColorStop(0, ACC_BRIGHT);
  badgeGrad.addColorStop(1, ACC);
  ctx.fillStyle = badgeGrad;
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(badgeTxt, W / 2, y + 19);
  ctx.textBaseline = "alphabetic";
  y += 36 + 12;

  ctx.font = `900 ${titleFs}px ${FONT}`;
  ctx.fillStyle = "#c9a227";
  for (const ln of nameLines) {
    ctx.fillText(ln, W / 2, y + Math.round(titleFs * 0.85));
    y += titleStep;
  }
  if (albumTxt) {
    ctx.font = `500 18px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(fitText(ctx, albumTxt, 360), W / 2, y + 20);
  }

  /* Footer separator */
  const fy = chartTop + chartH + 34;
  ctx.strokeStyle = "rgba(17,17,16,0.1)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(M, fy);
  ctx.lineTo(W - M, fy);
  ctx.stroke();

  /* Soft artist wash — lower mid (red-box zone below champ title, above footer) */
  if (artistImg) {
    const aw = 390;
    const washCY = fy - 168;
    const ax = (W - aw) / 2;
    const ay = washCY - aw * 0.38;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.ellipse(W / 2, washCY, aw * 0.44, aw * 0.4, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(artistImg, ax, ay, aw, aw);
    ctx.restore();
  }

  const QS = 118;
  const rowY = fy + 28;
  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, SITE_URL, {
    width: QS - 16,
    margin: 1,
    color: { dark: "#111110", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });

  /* Bottom-right: [HEIPACLUB + slogan][QR] — QR flush right */
  const slogan = "给你的本命团体办一场真正的 K-pop 巅峰对决";
  const brandText = "KPOPCLUB";
  ctx.font = `800 26px ${FONT}`;
  const brandFullW = ctx.measureText(brandText).width;
  ctx.font = `500 15px ${FONT}`;
  const sloganMaxW = 280;
  const sloganW = Math.min(ctx.measureText(slogan).width, sloganMaxW);
  const textW = Math.max(brandFullW, sloganW);
  const footGap = 16;
  const blockW = textW + footGap + QS;
  const blockX = W - M - blockW;
  const tx = blockX;
  const qrX = blockX + textW + footGap;

  ctx.textAlign = "left";
  ctx.font = `800 26px ${FONT}`;
  const brandGrad = ctx.createLinearGradient(tx, 0, tx + brandFullW, 0);
  brandGrad.addColorStop(0, "#4a6d8f");
  brandGrad.addColorStop(0.55, "#6a9fd4");
  brandGrad.addColorStop(1, "#8aab28");
  ctx.fillStyle = brandGrad;
  ctx.fillText(brandText, tx, rowY + 46);

  ctx.font = `500 15px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(fitText(ctx, slogan, textW), tx, rowY + 78);

  roundRect(ctx, qrX, rowY, QS, QS, 14);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.drawImage(qrCanvas, qrX + 8, rowY + 8, QS - 16, QS - 16);

  /* JPEG with size budget (Music Cup: ≤ ~590KB) */
  let blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
  for (const q of [0.82, 0.74]) {
    if (!blob || blob.size <= 580000) break;
    blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
  }
  if (!blob) throw new Error("share jpeg failed");
  return blob;
}
