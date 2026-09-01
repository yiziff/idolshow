/**
 * idolshow home page — editorial / ins layout
 */
export function mountHomeView(ctx) {
  const {
    app,
    shell,
    esc,
    navigate,
    ARTISTS,
    KIND_FILTERS,
    kindFilterMeta,
    filterArtistsByKind,
    mergeLocalArtistsWithItunes,
    fillAvatarForArtist,
    imgTag,
    IMAGE_SIZES,
    fetchArtistRank,
    loadState,
    trackEvent,
    openMessageWall,
    openSupportSite,
    runAfterNextPaint,
    openAboutSite,
  } = ctx;

  let sortMode = "fans";
  let kindMode = "all";
  let homeLimit = 50;
  let homeShowAll = false;
  const rankWins = new Map();
  let lastPaintQuery = "";

  const topByFans = (list, n = Infinity) => {
    const sorted = [...list].sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0));
    if (!Number.isFinite(n) || n >= sorted.length) return sorted;
    return sorted.slice(0, n);
  };

  const basePool = () => filterArtistsByKind(ARTISTS, kindMode);
  const filteredLocalList = (q = "") => {
    const query = q.trim().toLowerCase();
    const regioned = basePool();
    if (query) {
      return regioned.filter((a) =>
        [a.name, a.search, a.tag, a.blurb, a.kind, a.origin].join(" ").toLowerCase().includes(query)
      );
    }
    const limit = homeShowAll ? Infinity : homeLimit;
    return topByFans(regioned, limit);
  };
  const artistRankKey = (a) => String(a.neteaseArtistId || a.itunesArtistId || a.id || a.name || "");
  const sortList = (list) => {
    const arr = [...list];
    if (sortMode === "alpha") {
      arr.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "en", { numeric: true })
      );
      return arr;
    }
    if (sortMode === "rank") {
      arr.sort((a, b) => {
        const wa = rankWins.get(artistRankKey(a)) || rankWins.get(a.name) || 0;
        const wb = rankWins.get(artistRankKey(b)) || rankWins.get(b.name) || 0;
        if (wb !== wa) return wb - wa;
        return Number(b.fans || 0) - Number(a.fans || 0);
      });
      return arr;
    }
    arr.sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0));
    return arr;
  };

  let searchToken = 0;
  let input;

  const paintMoreBar = (shown, poolTotal, query) => {
    const bar = document.getElementById("home-more");
    if (!bar) return;
    if (query || homeShowAll || shown >= poolTotal) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML = `<div class="home-more-row"><button type="button" class="ghost-btn" id="home-more-btn">加载更多</button></div>`;
    document.getElementById("home-more-btn")?.addEventListener("click", () => {
      homeLimit += 50;
      paintGrid(input?.value || "");
    });
  };

  const paintGrid = async (q = "") => {
    const token = ++searchToken;
    const query = String(q || "").trim();
    const poolTotal = query ? 0 : basePool().length;
    const localList = sortList(filteredLocalList(q));
    const grid = document.getElementById("artist-grid");
    const count = document.getElementById("artist-count");
    if (!grid) return;

    const writeGrid = (list) => {
      if (count) {
        count.hidden = kindMode === "all" && !query;
        count.textContent = query
          ? `${list.length} 个结果`
          : kindMode === "all"
            ? `${list.length} 位艺人`
            : `${kindFilterMeta(kindMode).label} · ${list.length} 位`;
      }
      grid.innerHTML = list.length
        ? list
            .map((a, index) => {
              const wins = rankWins.get(artistRankKey(a)) || 0;
              const kindLabel = a.kind === "group" ? "团体" : a.kind === "solo" ? "个人" : "";
              const metaBits = [];
              if (a.tag) metaBits.push(a.tag);
              if (a.blurb) metaBits.push(a.blurb.replace(/^[^·]+·\s*/, "").slice(0, 18));
              if (wins && sortMode === "rank") metaBits.push(`夺冠 ${wins}`);
              return `<button type="button" class="artist-card artist-card-ins" data-artist="${a.id}">
          <div class="artist-card-ins-cover">
            ${imgTag(a.avatar, { alt: a.name, className: "artist-avatar", size: IMAGE_SIZES.avatar, loading: index < 6 ? "eager" : "lazy", width: 280, height: 350, sizes: "(max-width:640px) 45vw, 180px", responsive: true })}
            ${kindLabel ? `<span class="artist-card-ins-tag">${esc(kindLabel)}</span>` : ""}
          </div>
          <div class="artist-card-ins-body">
            <h3 class="artist-card-ins-name">${esc(a.name)}</h3>
            <p class="artist-card-ins-meta">${esc(metaBits.join(" · ") || "开启单曲对决")}</p>
          </div>
        </button>`;
            })
            .join("")
        : `<p class="loading-line">没有匹配的艺人，换个关键词试试。</p>`;
      list.slice(0, 24).forEach((a) => { if (!a.avatar) fillAvatarForArtist(a); });
      lastPaintQuery = query;
      paintMoreBar(list.length, poolTotal, query);
    };

    writeGrid(localList);
    if (query.length >= 2) {
      const merged = sortList(await mergeLocalArtistsWithItunes(query, localList));
      if (token !== searchToken) return;
      writeGrid(merged);
    }
  };

  app.innerHTML = shell(
    `<section class="hero hero-ins">
      <div class="hero-ins-cover">
        <div class="hero-ins-cover-aura" aria-hidden="true"></div>
        <span class="hero-ins-watermark" aria-hidden="true">IDOL</span>
        <div class="hero-ins-cover-frame">
          <span class="hero-ins-spark hero-ins-spark--tl" aria-hidden="true">✦</span>
          <span class="hero-ins-spark hero-ins-spark--br" aria-hidden="true">✦</span>
          <p class="hero-ins-eyebrow">内娱偶像 · 单曲对决</p>
          <h1 class="hero-ins-headline" aria-label="本命单曲">
            <span class="hero-ins-char" style="--i:0">本</span><span class="hero-ins-char" style="--i:1">命</span><span class="hero-ins-char hero-ins-char--split" style="--i:2">单</span><span class="hero-ins-char" style="--i:3">曲</span>
          </h1>
          <p class="hero-ins-caption"><span>选出你的巅峰之选</span></p>
        </div>
      </div>
      <p class="hero-ins-lead">为喜欢的团体或个人，办一场属于她的对决</p>
      <div class="hero-ins-tags">
        <span class="hero-ins-tag hero-ins-tag--fill">单曲 1v1</span>
        <span class="hero-ins-tag">梦回大厂</span>
        <span class="hero-ins-tag">iTunes 试听</span>
      </div>
      <div class="hero-ins-links">
        <button type="button" data-about-site>关于本站</button>
        <button type="button" data-support-site>支持运营</button>
        <button type="button" data-message-wall>留言墙</button>
      </div>
    </section>
    <div class="home-ins-toolbar">
      <div class="home-ins-section-head">
        <h2>发现艺人</h2>
        <span id="artist-count" hidden></span>
      </div>
      <input id="artist-search" class="home-ins-search" type="search" placeholder="搜索团体或个人…" autocomplete="off" />
      <div class="home-ins-filters">
        <div class="home-ins-filter-group" id="kind-row" role="group" aria-label="类型筛选">
          <span class="home-ins-filter-label">类型</span>
          ${KIND_FILTERS.map((f) => `<button type="button" class="mode-chip${f.id === "all" ? " active" : ""}" data-kind="${f.id}">${f.label}</button>`).join("")}
        </div>
        <div class="home-ins-filter-group" id="sort-row" role="group" aria-label="排序方式">
          <span class="home-ins-filter-label">排序</span>
          <button type="button" class="mode-chip active" data-sort="fans">热度</button>
          <button type="button" class="mode-chip" data-sort="alpha">A–Z</button>
          <button type="button" class="mode-chip" data-sort="rank">夺冠</button>
        </div>
      </div>
    </div>
    <div class="home-ins-gallery">
    <div class="artist-grid artist-grid-ins" id="artist-grid"></div>
    <div class="home-more" id="home-more" hidden></div>
    </div>`,
    { sponsorTicker: false, actions: `<a class="ghost-btn dream-factory-top-btn" href="#/dream-factory">梦回大厂</a>` }
  );

  input = document.getElementById("artist-search");
  document.getElementById("artist-grid")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-artist]");
    if (card) navigate(`/artist/${card.dataset.artist}`);
  });
  app.querySelector("[data-about-site]")?.addEventListener("click", () => openAboutSite?.());
  app.querySelector("[data-support-site]")?.addEventListener("click", () => { trackEvent("support_open"); openSupportSite(); });
  app.querySelector("[data-message-wall]")?.addEventListener("click", () => openMessageWall());

  let timer = null;
  const apply = (force = false) => {
    clearTimeout(timer);
    const nextQuery = String(input?.value || "").trim();
    if (!force && nextQuery === lastPaintQuery) return;
    timer = setTimeout(() => runAfterNextPaint(() => paintGrid(input?.value || "")), 180);
  };
  input?.addEventListener("input", () => apply(false));
  document.querySelectorAll("#sort-row [data-sort]").forEach((chip) => {
    chip.addEventListener("click", () => {
      sortMode = chip.dataset.sort || "fans";
      document.querySelectorAll("#sort-row .mode-chip").forEach((c) => c.classList.toggle("active", c === chip));
      apply(true);
    });
  });
  document.querySelectorAll("#kind-row [data-kind]").forEach((chip) => {
    chip.addEventListener("click", () => {
      kindMode = chip.dataset.kind || "all";
      homeLimit = 50;
      homeShowAll = false;
      document.querySelectorAll("#kind-row .mode-chip").forEach((c) => c.classList.toggle("active", c.dataset.kind === kindMode));
      apply(true);
    });
  });

  fetchArtistRank({ limit: 200 }).then((data) => {
    for (const item of data.items || []) {
      const wins = Number(item.wins || 0) || 0;
      if (item.artistId) rankWins.set(String(item.artistId), wins);
      if (item.name) rankWins.set(String(item.name), wins);
    }
    if (sortMode === "rank") apply(true);
  }).catch(() => {});

  paintGrid("");
  const saved = loadState();
  if (saved?.bracket && !saved.bracket.champion && saved.phase !== "done") {
    const resume = document.createElement("p");
    resume.className = "home-ins-resume";
    resume.innerHTML = `<button type="button" class="ghost-btn" id="resume-btn">继续 · ${esc(saved.artist?.name || saved.artistName || "进行中")}</button>`;
    app.querySelector(".shell")?.appendChild(resume);
    document.getElementById("resume-btn")?.addEventListener("click", () => navigate("/play"));
  }
}
