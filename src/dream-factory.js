/**
 * 梦回大厂 · 舞台 PK 逻辑
 */
import { STAGES } from "./data/stages.js";
import { buildBracket, nearestFieldSize } from "./tournament.js";

export const DREAM_FIELD_SIZE = 32;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function stagesToPkSongs(stages) {
  return stages.map((s) => {
    const displayTitle = s.subtitle ? `${s.title} · ${s.subtitle}` : s.title;
    return {
      id: s.id,
      title: displayTitle,
      artist: (s.performers || []).join(" · "),
      album: s.chapterLabel || "",
      collection: s.chapterLabel || "",
      year: "2018",
      cover: s.cover || "",
      coverSm: s.coverSm || s.cover || "",
      previewUrl: s.previewUrl || "",
      playSource: s.playSource || (s.previewUrl ? "itunes" : "none"),
      itunesTrackId: s.itunesTrackId || "",
      trackViewUrl: s.trackViewUrl || "",
      chapter: s.chapter,
      chapterLabel: s.chapterLabel,
      blurb: s.blurb || "",
      stageId: s.id,
      stageTitle: s.title,
      stageSubtitle: s.subtitle || "",
    };
  });
}

export function drawDreamFactoryField(stages = STAGES, size = DREAM_FIELD_SIZE) {
  const pool = shuffle(stages);
  const n = nearestFieldSize(Math.min(pool.length, size), { min: 4, max: size });
  return pool.slice(0, n);
}

export function startDreamFactoryBracket(stages = STAGES) {
  const field = stagesToPkSongs(drawDreamFactoryField(stages));
  return buildBracket(field, { max: DREAM_FIELD_SIZE, field });
}

export function chapterCounts(stages = STAGES) {
  const counts = {};
  for (const s of stages) {
    counts[s.chapter] = (counts[s.chapter] || 0) + 1;
  }
  return counts;
}
