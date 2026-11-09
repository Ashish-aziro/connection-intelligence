import { CONFIG } from "../config.js";
import { runUnified, getStatus } from "./api.js";
import { readProgress } from "./render.js";

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

// Errors that will never fix themselves by calling again (quota / billing / auth on the scraper).
const FATAL_PATTERNS = [
  [/item limit exceeded|usage limit|monthly limit|free user|plan limit|insufficient (credit|fund)|payment required|402/i,
    "The LinkedIn scraper (Apify) has hit its plan limit, so no profiles can be enriched. Upgrade the Apify plan or switch to another Apify token, then click Retry."],
  [/apify.*(unauthori[sz]ed|invalid token|401|403)|token.*(invalid|expired)/i,
    "The Apify token used for enrichment was rejected. Update the token, then click Retry."],
];

function fatalReason(reply) {
  const text = typeof reply === "string" ? reply : JSON.stringify(reply ?? "");
  for (const [re, msg] of FATAL_PATTERNS) if (re.test(text)) return msg;
  return null;
}

function isReady(reply) {
  if (reply && typeof reply === "object") {
    if (reply.ready_for_search === true || reply.search_ready === true) return true;
    const st = String(reply.state || reply.phase || "").toUpperCase();
    if (st === "WAITING_FOR_QUERY" || st === "SEARCH_READY") return true;
  }
  return typeof reply === "string" && /WAITING_FOR_QUERY|ready_for_search"?\s*:\s*true/i.test(reply);
}

function replyError(reply) {
  if (reply && typeof reply === "object" && reply.ok === false) return reply.error || reply.message || "Unified flow reported an error.";
  if (typeof reply === "string" && /^error:/i.test(reply.trim())) return reply.trim();
  return null;
}

function replyMessage(reply) {
  if (typeof reply === "string") return reply.replace(/\s+/g, " ").slice(0, 160);
  if (reply && typeof reply === "object") {
    return reply.message || reply.status_text || reply.progress_text || reply.state || reply.phase || "";
  }
  return "";
}

/** Tracks whether enrichment is actually moving. */
function createStallWatch() {
  let key = null;
  let changedAt = Date.now();
  let callsSinceChange = 0;
  return {
    observe(p) {
      const k = p ? `${p.imported ?? ""}|${p.done ?? ""}|${p.failed ?? ""}` : null;
      if (k !== null && k !== key) { key = k; changedAt = Date.now(); callsSinceChange = 0; }
    },
    countCall() { callsSinceChange += 1; },
    stalled() {
      return Date.now() - changedAt > CONFIG.STALL_AFTER_MS && callsSinceChange >= CONFIG.STALL_AFTER_CALLS;
    },
    minutes() { return Math.round((Date.now() - changedAt) / 60000); },
  };
}

/**
 * Drive the Unified flow until the dataset is search-ready.
 * ui = { onProgress({label, pct, phase}), onReady(), onError(msg) }
 */
export function startEnrichment(datasetId, ui) {
  const ctrl = new AbortController();
  const watch = createStallWatch();
  let finished = false;
  let lastPct = 3;
  let lastProgress = null;

  const stop = (msg) => {
    if (finished) return;
    finished = true;
    ctrl.abort();
    ui.onError(msg);
  };

  const pollStatus = async () => {
    while (!finished && !ctrl.signal.aborted) {
      try {
        const p = readProgress(await getStatus(datasetId));
        if (p && !finished) {
          lastProgress = p;
          watch.observe(p);
          if (p.total && p.done != null) {
            lastPct = Math.max(lastPct, Math.min(95, Math.round(((p.done + (p.failed || 0)) / p.total) * 90) + 5));
            ui.onProgress({ label: `Enriched ${p.done} of ${p.total} profiles${p.failed ? ` · ${p.failed} unavailable` : ""}`, pct: lastPct, phase: "enrich" });
          } else if (p.imported) {
            lastPct = Math.max(lastPct, 10);
            ui.onProgress({ label: `Imported ${p.imported} connections · enriching…`, pct: lastPct, phase: "enrich" });
          }
        }
      } catch { /* status is best effort */ }
      await sleep(CONFIG.STATUS_POLL_MS, ctrl.signal);
    }
  };

  const stalledMessage = () => {
    const done = lastProgress?.done ?? 0;
    const total = lastProgress?.total ?? "?";
    return `Enrichment has not moved for ${watch.minutes()} minutes (still ${done} of ${total} profiles), so we stopped retrying. ` +
      "The most common cause is the Apify scraper's plan limit (\"free user item limit exceeded\" on its runs). " +
      "Fix the Apify plan or token, then click Retry. Your upload is saved.";
  };

  const drive = async () => {
    let errors = 0;
    for (let attempt = 1; attempt <= CONFIG.ENRICH_MAX_ATTEMPTS && !finished; attempt++) {
      if (watch.stalled()) return stop(stalledMessage());
      try {
        watch.countCall();
        const { reply } = await runUnified(datasetId, ctrl.signal);
        if (finished) return;
        if (isReady(reply)) { finished = true; ctrl.abort(); ui.onReady(); return; }
        const fatal = fatalReason(reply);
        if (fatal) return stop(fatal);
        const err = replyError(reply);
        if (err) throw new Error(err);
        errors = 0;
        const msg = replyMessage(reply);
        if (msg) ui.onProgress({ label: msg, pct: lastPct, phase: attempt === 1 ? "import" : "enrich" });
      } catch (e) {
        if (finished) return;
        const fatal = fatalReason(e.message);
        if (fatal) return stop(fatal);
        // Gateway timeouts (long enrichment runs) are normal: the work continues server-side.
        const transient = !e.status || e.status >= 500 || e.status === 429;
        errors = transient ? errors + 0.34 : errors + 1;
        if (errors >= 3) return stop(e.message || "Enrichment failed.");
      }
      await sleep(CONFIG.ENRICH_RETRY_DELAY_MS, ctrl.signal);
    }
    if (!finished) stop("Enrichment is taking unusually long. Click Retry to keep going.");
  };

  ui.onProgress({ label: "Importing your connections…", pct: lastPct, phase: "import" });
  pollStatus();
  drive();
  return () => { finished = true; ctrl.abort(); };
}
