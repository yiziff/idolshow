/**
 * 梦回大厂 · 落地页
 */
import { CHAPTER_META, STAGES_SEED } from "./data/stages.seed.js";
import { STAGES } from "./data/stages.js";
import { chapterCounts, DREAM_FIELD_SIZE, startDreamFactoryBracket } from "./dream-factory.js";

export function mountDreamFactoryView(ctx) {
  const { app, shell, esc, navigate, saveState, trackEvent } = ctx;
  const counts = chapterCounts(STAGES);
  const total = STAGES.length || STAGES_SEED.length;

  const chapterCards = CHAPTER_META.map((ch) => {
    const n = counts[ch.id] || 0;
    return `<div class="dream-chapter-card" data-chapter="${ch.id}">
      <span class="dream-chapter-badge" style="background: var(${ch.cssVar})">${esc(ch.label)}</span>
      <strong>${n}</strong>
      <span>个舞台</span>
    </div>`;
  }).join("");

  const stageList = (STAGES.length ? STAGES : STAGES_SEED)
    .map((s) => {
      const ch = CHAPTER_META.find((c) => c.id === s.chapter);
      const title = s.subtitle ? `${s.title} · ${s.subtitle}` : s.title;
      return `<li class="dream-stage-row" data-chapter="${s.chapter}">
        <span class="dream-stage-badge" style="background: var(${ch?.cssVar || "--chapter-theme"})">${esc(s.chapterLabel || "")}</span>
        <div class="dream-stage-meta">
          <strong>${esc(title)}</strong>
          <span>${esc((s.performers || []).join(" · "))}</span>
          <em>${esc(s.blurb || "")}</em>
        </div>
      </li>`;
    })
    .join("");

  app.innerHTML = shell(
    `<section class="dream-factory">
      <div class="dream-hero">
        <p class="dream-eyebrow">偶像练习生 · 2018</p>
        <h1>梦回<em>大厂</em></h1>
        <p class="dream-tagline">从 ${total} 个神级舞台中随机抽取 ${DREAM_FIELD_SIZE} 强，单败淘汰直到选出你心中的本命舞台。</p>
        <button type="button" class="primary-btn dream-start-btn" id="dream-start">开启梦回大厂</button>
      </div>
      <div class="dream-chapters" aria-label="环节预览">
        <h2>七大环节</h2>
        <div class="dream-chapter-grid">${chapterCards}</div>
      </div>
      <div class="dream-stage-catalog">
        <h2>全部舞台 <span>${total}</span></h2>
        <ul class="dream-stage-list">${stageList}</ul>
      </div>
    </section>`,
    { back: "/", actions: `<a class="ghost-btn dream-factory-top-btn" href="#/dream-factory">梦回大厂</a>` }
  );

  document.getElementById("dream-start")?.addEventListener("click", () => {
    trackEvent?.("dream_factory_start");
    const bracket = startDreamFactoryBracket();
    saveState({
      cupType: "dream-factory",
      artistId: "dream-factory",
      artistName: "梦回大厂",
      artistAvatar: "",
      artistSearch: "",
      phase: "bracket",
      bracket,
      createdAt: new Date().toISOString(),
    });
    navigate("/bracket");
  });
}
