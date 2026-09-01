/**
 * Single-elimination bracket for song cups.
 * Field size snaps down to nearest power of 2 (min 4, max 32).
 * From NetEase hot-50 we typically take 32.
 */

export function nearestFieldSize(n, { min = 4, max = 32 } = {}) {
  const capped = Math.min(max, Math.max(min, n));
  let size = 4;
  while (size * 2 <= capped) size *= 2;
  return size;
}

export function pickSongs(songs, mode = "battle") {
  const list = songs.map((s, i) => ({
    id: String(s.id || s.neteaseId || `${i}-${s.title}`),
    neteaseId: s.neteaseId ? String(s.neteaseId) : s.id ? String(s.id) : null,
    title: s.title,
    artist: s.artist || "",
    album: s.album || s.collection || "",
    collection: s.collection || s.album || "",
    year: s.year || "",
    cover: s.cover || "",
    coverSm: s.coverSm || s.cover || "",
    duration_ms: s.duration_ms || null,
    publishTime: s.publishTime || null,
    playSource: s.playSource || null,
    previewUrl: s.previewUrl || "",
    itunesTrackId: s.itunesTrackId || "",
    trackViewUrl: s.trackViewUrl || "",
    labelId: s.labelId || null,
    labelName: s.labelName || "",
    rosterArtistId: s.rosterArtistId || "",
    rosterArtistName: s.rosterArtistName || "",
    duelSide: s.duelSide || "",
    chapter: s.chapter || "",
    chapterLabel: s.chapterLabel || "",
    blurb: s.blurb || "",
    stageId: s.stageId || "",
  }));
  // battle / random: keep hot ranking for the field, shuffle for pairing
  if (mode === "battle" || mode === "random") {
    return shuffle([...list]);
  }
  return list;
}

/**
 * Build field: take hottest `size` songs, then apply mode.
 * battle = shuffle before pairing (1v1 Battle) — avoids #1 vs #2 early.
 */
export function buildField(songs, { mode = "battle", max = 32 } = {}) {
  const size = nearestFieldSize(Math.min(songs.length, max), { max });
  const hottest = songs.slice(0, size);
  return pickSongs(hottest, mode);
}

export function buildBracket(songs, { mode = "battle", max = 32, field: presetField } = {}) {
  const field = presetField?.length
    ? presetField
    : buildField(songs, { mode, max });
  const size = field.length;
  const rounds = [];
  const first = [];
  for (let i = 0; i < field.length; i += 2) {
    first.push({
      id: `r0-m${i / 2}`,
      a: field[i],
      b: field[i + 1],
      winner: null,
    });
  }
  rounds.push(first);

  let matchCount = first.length / 2;
  let round = 1;
  while (matchCount >= 1) {
    const row = [];
    for (let i = 0; i < matchCount; i++) {
      row.push({
        id: `r${round}-m${i}`,
        a: null,
        b: null,
        winner: null,
        from: [`r${round - 1}-m${i * 2}`, `r${round - 1}-m${i * 2 + 1}`],
      });
    }
    rounds.push(row);
    matchCount /= 2;
    round += 1;
  }

  return {
    size,
    mode,
    rounds,
    path: [],
    champion: null,
    createdAt: new Date().toISOString(),
  };
}

export function currentMatch(bracket) {
  for (const round of bracket.rounds) {
    for (const m of round) {
      if (m.a && m.b && !m.winner) return m;
    }
  }
  return null;
}

export function roundName(size, roundIndex) {
  const remaining = size / 2 ** roundIndex;
  if (remaining <= 1) return "冠军";
  if (remaining === 2) return "决赛";
  if (remaining === 4) return "半决赛";
  if (remaining === 8) return "四分之一决赛";
  return `${remaining} 强`;
}

export function roundLabel(bracket, match) {
  const idx = findRoundIndex(bracket, match.id);
  if (idx < 0) return "对决";
  return roundName(bracket.size, idx);
}

export function findRoundIndex(bracket, matchId) {
  return bracket.rounds.findIndex((r) => r.some((m) => m.id === matchId));
}

export function isRoundComplete(bracket, roundIndex) {
  const round = bracket.rounds[roundIndex];
  return Boolean(round?.length) && round.every((m) => m.winner);
}

/** Music Cup–style interstitial copy for the round about to be played. */
export function splashForBracket(bracket, { subject = "首歌", pickHint = "一首" } = {}) {
  const match = currentMatch(bracket);
  if (!match) return null;
  const idx = findRoundIndex(bracket, match.id);
  if (idx < 0) return null;
  const remaining = bracket.size / 2 ** idx;
  const matchCount = bracket.rounds[idx].length;
  let title = `${remaining}强`;
  if (remaining === 2) title = "决赛";
  else if (remaining === 4) title = "半决赛";
  else if (remaining === 8) title = "8强";
  return {
    title,
    sub: `${remaining} ${subject} · ${matchCount} 场对决 · 点选更喜欢的${pickHint}`,
    remaining,
    roundIndex: idx,
  };
}

/** Finalist podium: champion, runner-up, two semi losers. */
export function podiumFromBracket(bracket) {
  const champion = bracket.champion || null;
  const rounds = bracket.rounds || [];
  const final = rounds[rounds.length - 1]?.[0] || null;
  let runnerUp = null;
  if (final?.a && final?.b && final.winner) {
    const wid = final.winner.id || final.winner.title;
    runnerUp = (final.a.id || final.a.title) === wid ? final.b : final.a;
  }
  const semis = [];
  if (rounds.length >= 2) {
    for (const m of rounds[rounds.length - 2]) {
      if (!m?.a || !m?.b || !m.winner) continue;
      const wid = m.winner.id || m.winner.title;
      const loser = (m.a.id || m.a.title) === wid ? m.b : m.a;
      if (loser) semis.push(loser);
    }
  }
  return { champion, runnerUp, semis };
}

export function progressText(bracket) {
  const decided = bracket.rounds.flat().filter((m) => m.winner).length;
  const total = bracket.rounds.flat().length;
  return `${decided} / ${total}`;
}

export function chooseWinner(bracket, matchId, side) {
  const next = structuredClone(bracket);
  let match = null;
  let roundIndex = -1;
  for (let ri = 0; ri < next.rounds.length; ri++) {
    const found = next.rounds[ri].find((m) => m.id === matchId);
    if (found) {
      match = found;
      roundIndex = ri;
      break;
    }
  }
  if (!match || match.winner || !match.a || !match.b) return next;
  if (side !== "a" && side !== "b") return next;

  const winner = side === "a" ? match.a : match.b;
  match.winner = winner;
  next.path = [...(next.path || []), winner];

  const nextRound = next.rounds[roundIndex + 1];
  if (!nextRound) {
    next.champion = winner;
    return next;
  }

  for (const parent of nextRound) {
    if (!parent.from) continue;
    const slot = parent.from.indexOf(matchId);
    if (slot === 0) parent.a = winner;
    if (slot === 1) parent.b = winner;
  }

  if (roundIndex === next.rounds.length - 1) {
    next.champion = winner;
  }

  return next;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
