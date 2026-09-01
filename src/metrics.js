/**
 * Privacy-friendly product event tracking.
 * Fire-and-forget: analytics must never block gameplay or sharing.
 */

const ENDPOINT = "/api/metrics/event";
const ALLOWED_EVENTS = new Set([
  "share_open",
  "share_image_ready",
  "cup_start",
  "about_open",
  "perf_lcp_slow",
  "perf_inp_slow",
  "perf_cls_poor",
]);

export function trackEvent(event) {
  if (!ALLOWED_EVENTS.has(event)) return;
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    }).catch(() => {});
  } catch {
    // Analytics failures must remain invisible to users.
  }
}

/**
 * Client-side baseline signals for Web Vitals long-tail.
 * Only emits coarse events when thresholds are exceeded.
 */
export function initPerfVitalsTracking() {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  let lcpSent = false;
  let clsSent = false;
  let inpSent = false;
  let clsValue = 0;
  const hidden = () => document.visibilityState === "hidden";

  try {
    const lcpObs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (!last || hidden() || lcpSent) return;
      if (Number(last.startTime || 0) > 3000) {
        lcpSent = true;
        trackEvent("perf_lcp_slow");
      }
    });
    lcpObs.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    /* ignore unsupported */
  }

  try {
    const clsObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        clsValue += Number(e.value || 0);
      }
      if (!clsSent && clsValue > 0.25) {
        clsSent = true;
        trackEvent("perf_cls_poor");
      }
    });
    clsObs.observe({ type: "layout-shift", buffered: true });
  } catch {
    /* ignore unsupported */
  }

  try {
    const inpObs = new PerformanceObserver((list) => {
      if (inpSent) return;
      for (const e of list.getEntries()) {
        const candidate = Number(e.duration || e.processingEnd - e.startTime || 0);
        if (candidate > 500) {
          inpSent = true;
          trackEvent("perf_inp_slow");
          break;
        }
      }
    });
    inpObs.observe({ type: "event", buffered: true, durationThreshold: 40 });
  } catch {
    /* ignore unsupported */
  }
}
