/**
 * Hybrid player: ALWAYS try iTunes first, NetEase only as fallback.
 * Aligned with cn-rap-cup / heipaclub.
 */

import { IMAGE_SIZES, optimizedImageUrl } from "./artwork.js";
import { neteaseSongPage, songPlayUrl } from "./netease.js";
import { resolvePlaySource } from "./itunes.js";

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sourceLabel(song) {
  if (song?.playSource === "itunes" || (song?.previewUrl && song?.playSource !== "netease")) {
    return "试听 · 约 30 秒";
  }
  return "试听";
}

export function createPlayer(root) {
  root.innerHTML = `
    <div class="player-card" id="cup-player" hidden>
      <div class="player-card-top">
        <div class="cover-thumb empty" id="cup-cover" aria-hidden="true"></div>
        <div class="player-meta-text">
          <div class="song-title" id="cup-title">选一首歌试听</div>
          <div class="song-sub" id="cup-sub">点选歌曲开始试听</div>
        </div>
      </div>
      <audio id="cup-audio" preload="metadata"></audio>
      <div class="scrubber">
        <span class="t" id="cup-cur">0:00</span>
        <input type="range" id="cup-seek" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
        <span class="t" id="cup-dur">0:00</span>
      </div>
      <div class="player-actions">
        <button type="button" id="cup-play">播放</button>
        <a class="ghost-link" id="cup-open" href="#" target="_blank" rel="noopener">外链打开</a>
      </div>
      <p class="player-hint" id="cup-hint"></p>
    </div>
  `;

  const card = root.querySelector("#cup-player");
  const audio = root.querySelector("#cup-audio");
  const cover = root.querySelector("#cup-cover");
  const title = root.querySelector("#cup-title");
  const sub = root.querySelector("#cup-sub");
  const cur = root.querySelector("#cup-cur");
  const dur = root.querySelector("#cup-dur");
  const seek = root.querySelector("#cup-seek");
  const playBtn = root.querySelector("#cup-play");
  const openLink = root.querySelector("#cup-open");
  const hint = root.querySelector("#cup-hint");

  let current = null;
  let lastLoadOpts = {};
  let seeking = false;
  /** Bump to cancel in-flight load()/play() after stop or newer load. */
  let loadSeq = 0;

  function hardStopAudio() {
    audio.pause();
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      /* ignore */
    }
  }

  function setPlayingUi(on) {
    card.classList.toggle("is-playing", on);
    playBtn.textContent = on ? "暂停" : "播放";
  }

  function paintMeta(song) {
    title.textContent = song.title || "未知曲目";
    const meta = [song.artist, song.album || song.collection].filter(Boolean).join(" · ");
    sub.textContent = [meta, sourceLabel(song)].filter(Boolean).join(" · ") || sourceLabel(song);
    if (song.cover) {
      const thumb = optimizedImageUrl(song.cover, { size: IMAGE_SIZES.list });
      cover.style.backgroundImage = `url("${thumb.replace(/"/g, "%22")}")`;
      cover.classList.remove("empty");
    } else {
      cover.style.backgroundImage = "";
      cover.classList.add("empty");
    }

    const useItunes =
      song.playSource === "itunes" ||
      (Boolean(song.previewUrl) && song.playSource !== "netease");
    if (useItunes && song.trackViewUrl) {
      openLink.href = song.trackViewUrl;
      openLink.textContent = "Apple Music";
      openLink.hidden = false;
    } else if (song.neteaseId) {
      openLink.href = neteaseSongPage(song.neteaseId);
      openLink.textContent = "网易云";
      openLink.hidden = false;
    } else {
      openLink.hidden = true;
    }
  }

  /**
   * Pick play URL. Rule: iTunes preview first; NetEase only if no Apple preview.
   * Caller must run resolvePlaySource before this when itunes is not yet confirmed.
   */
  async function resolveUrl(song) {
    if (song?.playSource === "itunes" && song.previewUrl) {
      return { url: song.previewUrl, via: "itunes", song };
    }
    if (song?.previewUrl && song?.playSource !== "netease") {
      return { url: song.previewUrl, via: "itunes", song };
    }
    if (song?.neteaseId) {
      const url = await songPlayUrl(song.neteaseId);
      if (url) return { url, via: "netease", song };
    }
    return { url: null, via: null, song };
  }

  async function load(song, { autoplay = true, artistName = "", artistAliases = [], mapArtistId = "" } = {}) {
    const seq = ++loadSeq;
    lastLoadOpts = { artistName, artistAliases, mapArtistId };
    current = song;
    card.hidden = false;
    paintMeta(song);
    hint.textContent = "拉取播放地址中…";
    setPlayingUi(false);
    hardStopAudio();

    let working = song;
    const confirmedItunes =
      working.playSource === "itunes" && Boolean(working.previewUrl);
    const alreadyResolved =
      confirmedItunes || working.playSource === "netease";

    // 未决议：先查 iTunes；已决议：不再重复请求
    if (!alreadyResolved) {
      if (working.previewUrl && !working.neteaseId) {
        working = { ...working, playSource: "itunes" };
      } else {
        try {
          working = await resolvePlaySource(working, artistName || working.artist || "", {
            artistAliases,
            mapArtistId: mapArtistId || working.rosterArtistId || "",
          });
        } catch {
          /* keep working */
        }
      }
      if (seq !== loadSeq) return;
      current = working;
      paintMeta(working);
    }

    let { url, via } = await resolveUrl(working);
    if (seq !== loadSeq) return;

    if (!url) {
      if (!working?.neteaseId && !working?.previewUrl) {
        hint.textContent = "没有可用的试听源。";
      } else {
        hint.textContent = "试听繁忙，请稍后再试，或点外链打开。";
      }
      return;
    }

    if (via === "itunes") {
      current = { ...working, playSource: "itunes", previewUrl: url };
      paintMeta(current);
      hint.textContent = "试听约 30 秒";
    } else {
      current = { ...working, playSource: "netease" };
      paintMeta(current);
      hint.textContent = "";
    }

    audio.src = url;
    if (autoplay) {
      try {
        if (seq !== loadSeq) return;
        await audio.play();
        if (seq !== loadSeq) {
          hardStopAudio();
          setPlayingUi(false);
          return;
        }
        setPlayingUi(true);
        if (via === "itunes") hint.textContent = "试听约 30 秒";
        else hint.textContent = "";
      } catch {
        if (seq !== loadSeq) return;
        hint.textContent = "浏览器拦截了自动播放，点「播放」即可。";
        setPlayingUi(false);
      }
    }
  }

  playBtn.addEventListener("click", async () => {
    if (!audio.src) {
      if (current) await load(current, { autoplay: true, ...lastLoadOpts });
      return;
    }
    if (audio.paused) {
      try {
        await audio.play();
        setPlayingUi(true);
      } catch {
        hint.textContent = "播放失败，试试外链打开。";
      }
    } else {
      audio.pause();
      setPlayingUi(false);
    }
  });

  audio.addEventListener("timeupdate", () => {
    if (seeking) return;
    const d = audio.duration || 0;
    cur.textContent = fmt(audio.currentTime);
    dur.textContent = fmt(d);
    if (d > 0) seek.value = String(Math.round((audio.currentTime / d) * 1000));
  });

  audio.addEventListener("ended", () => setPlayingUi(false));
  audio.addEventListener("pause", () => setPlayingUi(false));
  audio.addEventListener("play", () => setPlayingUi(true));
  audio.addEventListener("error", () => {
    setPlayingUi(false);
    hint.textContent = "试听繁忙，请稍后再试，或点外链打开。";
  });

  seek.addEventListener("pointerdown", () => {
    seeking = true;
  });
  seek.addEventListener("pointerup", () => {
    seeking = false;
    const d = audio.duration || 0;
    if (d > 0) audio.currentTime = (Number(seek.value) / 1000) * d;
  });
  seek.addEventListener("input", () => {
    const d = audio.duration || 0;
    if (d > 0) cur.textContent = fmt((Number(seek.value) / 1000) * d);
  });

  return {
    el: card,
    load,
    stop() {
      loadSeq += 1;
      hardStopAudio();
      setPlayingUi(false);
      hint.textContent = "";
    },
  };
}

/** Pause/clear every <audio> on the page (orphaned nodes after route swaps). */
export function stopAllPageAudio() {
  document.querySelectorAll("audio").forEach((a) => {
    try {
      a.pause();
      a.removeAttribute("src");
      a.load();
    } catch {
      /* ignore */
    }
  });
}
