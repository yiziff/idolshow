/**
 * Shared iTunes title/artist matching helpers (browser + Node build).
 * Keep in sync: scripts/build-itunes-map.mjs imports these for offline indexing.
 */

/** Best-effort TW/HK traditional → simplified for title compare. */
const TRAD_SIMP = {
  軍: "军",
  國: "国",
  愛: "爱",
  臺: "台",
  灣: "湾",
  麼: "么",
  後: "后",
  發: "发",
  時: "时",
  長: "长",
  東: "东",
  車: "车",
  馬: "马",
  風: "风",
  電: "电",
  樂: "乐",
  們: "们",
  這: "这",
  還: "还",
  來: "来",
  對: "对",
  開: "开",
  關: "关",
  與: "与",
  為: "为",
  會: "会",
  說: "说",
  語: "语",
  質: "质",
  實: "实",
  現: "现",
  萬: "万",
  億: "亿",
};

export function norm(s) {
  let out = String(s || "").toLowerCase();
  out = out.replace(/[軍國愛臺灣麼後發時長東車馬風電樂們這還來對開關與為會說語質實現萬億]/g, (ch) => TRAD_SIMP[ch] || ch);
  return out.replace(/\s+/g, "").replace(/[·．._\-#（）()']/g, "");
}

/** Strip feat./parens noise before title compare. */
export function titleCore(s) {
  return String(s || "")
    .replace(/\s*[\(（][^）)]*[\)）]\s*/g, " ")
    .replace(/\s*[\[【][^\]】]*[\]】]\s*/g, " ")
    .replace(/\s+(?:feat\.?|ft\.?|with)[\s.]*.+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SEQUEL_RE = /(?:pt|part)\.?\s*([2-9]|1\d)\b/i;
const BACKING_RE = /(伴奏|instrumental|acapella|a\s*cappella|karaoke)/i;

/**
 * 命中的曲目其实是另一首歌：续作（Pt.2）、串烧（A / B）、伴奏版。
 * 只在 iTunes 侧多出这些标记、而原曲名没有时才判冲突。
 */
export function versionConflict(want, got) {
  const w = String(want || "");
  const g = String(got || "");
  const gCore = titleCore(g);
  if (SEQUEL_RE.test(gCore) && !SEQUEL_RE.test(titleCore(w))) return true;
  if (gCore.includes("/") && !w.includes("/")) return true;
  if (BACKING_RE.test(g) && !BACKING_RE.test(w)) return true;
  return false;
}

function charClass(ch) {
  if (!ch) return "sep";
  if (/[a-z0-9]/i.test(ch)) return "latin";
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(ch)) return "cjk";
  return "sep";
}

/** 标题信息量：中日韩字比拉丁字母承载更多信息 */
function infoWeight(s) {
  let w = 0;
  for (const ch of s) w += charClass(ch) === "latin" ? 1 : 2;
  return w;
}

/**
 * 包含式匹配容易把「人」配到「闻香识女人」、「GO」配到「Godzilla」。
 * 只接受两类：短串是长串的开头/结尾且在语言或标点边界断开（中英双语标题），
 * 或者短串本身已经覆盖标题大部分。
 */
function isSafeContainment(shorter, longer) {
  if (infoWeight(shorter) < 4) return false;
  if (shorter.length >= longer.length * 0.6) return true;
  if (longer.startsWith(shorter)) {
    const next = charClass(longer[shorter.length]);
    if (next === "sep" || next !== charClass(shorter[shorter.length - 1])) return true;
  }
  if (longer.endsWith(shorter)) {
    const prev = charClass(longer[longer.length - shorter.length - 1]);
    if (prev === "sep" || prev !== charClass(shorter[0])) return true;
  }
  return false;
}

export function titleScore(want, got) {
  const a = norm(titleCore(want));
  const b = norm(titleCore(got));
  if (!a || !b) return 0;
  if (versionConflict(want, got)) return 0;
  if (a === b) return 100;
  if (!a.includes(b) && !b.includes(a)) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (!isSafeContainment(shorter, longer)) return 0;
  return 85;
}

export function nameScore(query, artistName) {
  const q = norm(query);
  const n = norm(artistName);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.includes(q) || q.includes(n)) return 80;
  let hit = 0;
  const parts = q.split(/(?=[a-z\u4e00-\u9fff])/i).filter((t) => t.length >= 2);
  for (const t of parts) if (n.includes(t)) hit += 1;
  return hit * 20;
}

/** Common CN roster name → Apple Music / iTunes artist names */
export const ITUNES_NAME_HINTS = {
  马思唯: ["Masiwei", "Higher Brothers"],
  法老: ["Pharaoh"],
  姜云升: ["Jiang Yunsheng"],
  "GAI周延": ["GAI", "GAI Zhouyan"],
  GAI周延: ["GAI"],
  艾志恒Asen: ["Asen", "艾志恒"],
  艾志恒: ["Asen"],
  罗言: ["罗言"],
  Jony: ["Jony J"],
  "Jony J": ["Jony J"],
  TizzyT: ["Tizzy T"],
  "Tizzy T": ["Tizzy T"],
  Rapeter: ["Rapeter", "Rapeter吴嘉轩"],
  王以太: ["Wang Yitai"],
};

export function splitArtistCredits(raw) {
  return String(raw || "")
    .split(/[,，、/&]|(?:\s+feat\.?\s+)|(?:\s+ft\.?\s+)|(?:\s+with\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function latinTokens(s) {
  return (String(s || "").match(/[A-Za-z][A-Za-z0-9.$#]{1,}/g) || []).filter((t) => t.length >= 3);
}

export function expandArtistAliases(artistName, song, artistAliases = []) {
  const base = [
    artistName,
    song?.artist,
    ...artistAliases,
    ...splitArtistCredits(song?.artist),
    ...splitArtistCredits(artistName),
  ];
  const out = [];
  const seen = new Set();
  for (const raw of base) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const candidates = [s, ...latinTokens(s), ...(ITUNES_NAME_HINTS[s] || [])];
    for (const [cn, en] of Object.entries(ITUNES_NAME_HINTS)) {
      if (s.includes(cn)) candidates.push(...en);
    }
    for (const c of candidates) {
      const key = norm(c);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export function buildSearchTerms(title, artists, album = "") {
  const core = titleCore(title);
  const primaryArtist = artists[0] || "";
  const albumTrim = String(album || "").trim();
  return [
    primaryArtist ? `${primaryArtist} ${core}`.trim() : "",
    albumTrim && primaryArtist ? [primaryArtist, core].join(" ").trim() : "",
    core,
  ].filter((t, i, arr) => t && arr.indexOf(t) === i);
}

export function createTrackMatchState() {
  return { best: null, bestScore: 0 };
}

/**
 * Conservative thresholds: prefer miss → netease over wrong Apple track.
 * @param {{ best: any, bestScore: number }} state
 * @param {any} t raw iTunes track
 */
export function considerTrack(state, t, title, artists, artistBoost = 0) {
  if (!t?.previewUrl || !t.trackName) return;
  const ts = titleScore(title, t.trackName);
  const as = Math.max(...artists.map((a) => nameScore(a, t.artistName || "")), artistBoost, 0);
  if (ts < 85) return;
  if (as < 60 && ts < 100) return;
  if (as < 40) return;
  const score = ts * 0.7 + Math.max(as, 40) * 0.3;
  if (score > state.bestScore) {
    state.bestScore = score;
    state.best = t;
  }
}

export function playSourcePatchFromTrack(best) {
  if (best) {
    return {
      playSource: "itunes",
      previewUrl: best.previewUrl,
      itunesTrackId: String(best.trackId),
      trackViewUrl: best.trackViewUrl || best.collectionViewUrl || "",
      itunesTitle: best.trackName || "",
      itunesArtistName: best.artistName || "",
    };
  }
  return {
    playSource: "netease",
    previewUrl: "",
    itunesTrackId: "",
    trackViewUrl: "",
    itunesTitle: "",
    itunesArtistName: "",
  };
}

export function playSourceCacheKey(artists, title) {
  return `v4|${norm(artists.slice(0, 6).join(","))}|${norm(titleCore(title))}`;
}
