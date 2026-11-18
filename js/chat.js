// Search workspace: nested search history on the left, ask box on top, results below.
//  - Searches run in the background: switch between past searches (or start another)
//    while one is still running.
//  - "Refine" searches within a previous search's results; refinements are shown
//    nested under their parent search, like folders.
import { CONFIG } from "../config.js";
import { search, moreResults, refineResults, researchCompanies } from "./api.js";
import { esc, renderResult, peopleHtml, loadMoreHtml, shapeExtraRow } from "./render.js";

const THINKING_STEPS = [
  "Understanding your question…",
  "Scanning your whole network…",
  "Screening the strongest candidates…",
  "Writing the reasons for each match…",
];
const REFINE_STEPS = [
  "Understanding your refinement…",
  "Re-ranking the people in your earlier results…",
  "Keeping only people from the earlier search…",
  "Writing the reasons for each match…",
];
const MAX_SAVED = 40;
const CHEVRON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ELBOW = `<svg class="h-arrow" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 2v6a3 3 0 0 0 3 3h7M10 8l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function createChat({ pane, form, input, button, suggestions, historyList, historyEmpty, historyNetwork,
  newButton, getDatasetId, getNetworkName, userId }) {
  // entry: { id, parentId, q, fullQ, runIds, html, at, status: "pending"|"done"|"error", error, count, collapsed }
  let entries = [];
  let activeId = null;
  let refineParentId = null;
  let key = null;
  const tickers = new Map();           // pending entry id → interval for the "thinking" text

  // ---------- storage (per user + network; only finished searches are kept) ----------
  function load() {
    key = `ci.history.v2:${userId}:${getDatasetId()}`;
    try { entries = JSON.parse(localStorage.getItem(key) || "[]"); } catch { entries = []; }
    if (!Array.isArray(entries)) entries = [];
    entries = entries.filter((e) => e && e.status !== "pending").map((e) => {
      const x = { status: "done", parentId: null, ...e };
      // searches saved before refining existed: recover the run id from their "Load more" markup
      if (!x.runIds?.length) {
        const m = String(x.html || "").match(/data-run="([0-9a-f-]{36})"/i);
        x.runIds = m ? [m[1]] : [];
      }
      return x;
    });
  }
  function save() {
    let list = entries.filter((e) => e.status === "done").slice(0, MAX_SAVED);
    while (list.length) {
      try { localStorage.setItem(key, JSON.stringify(list)); return; } catch { list = list.slice(0, -1); }
    }
  }
  const byId = (id) => entries.find((e) => e.id === id);
  const childrenOf = (id) => entries.filter((e) => e.parentId === id).sort((a, b) => a.at - b.at);
  const roots = () => entries.filter((e) => !e.parentId || !byId(e.parentId)).sort((a, b) => b.at - a.at);
  function chain(e) {                  // [root, ..., e]
    const out = [];
    for (let x = e; x; x = x.parentId ? byId(x.parentId) : null) out.unshift(x);
    return out;
  }

  // ---------- sidebar: a tree of searches ----------
  function itemHtml(e, depth) {
    const kids = childrenOf(e.id);
    const caret = kids.length
      ? `<button class="h-caret" type="button" data-toggle="${esc(e.id)}" aria-label="${e.collapsed ? "Expand" : "Collapse"}" aria-expanded="${!e.collapsed}">${CHEVRON}</button>`
      : `<span class="h-caret h-caret-empty"></span>`;
    const meta = e.status === "pending"
      ? `<span class="spinner"></span> searching…`
      : e.status === "error" ? `<span class="h-err">failed</span>`
      : esc([e.count != null ? `${e.count} best fit${e.count === 1 ? "" : "s"}` : "", timeAgo(e.at)].filter(Boolean).join(" · "));
    return `<li class="h-node" style="--depth:${depth}">
        <div class="h-row">
          ${caret}
          <button class="history-item${e.id === activeId ? " active" : ""}${e.status === "pending" ? " pending" : ""}${depth ? " refined" : ""}"
            type="button" data-hid="${esc(e.id)}" title="${esc(e.q)}">
            <span class="h-q">${depth ? ELBOW : ""}${esc(e.q)}</span>
            <span class="h-meta">${meta}</span>
          </button>
        </div>
        ${kids.length && !e.collapsed ? `<ul class="h-children">${kids.map((k) => itemHtml(k, depth + 1)).join("")}</ul>` : ""}
      </li>`;
  }

  function renderHistory() {
    historyNetwork.textContent = getNetworkName() || "";
    historyList.innerHTML = roots().map((e) => itemHtml(e, 0)).join("");
    historyEmpty.classList.toggle("hidden", entries.length > 0);
  }

  // ---------- refine mode in the ask box ----------
  const chip = document.createElement("div");
  chip.className = "refine-chip hidden";
  form.prepend(chip);
  const defaultPlaceholder = input.placeholder;

  function setRefine(parentId) {
    refineParentId = parentId;
    const p = parentId ? byId(parentId) : null;
    if (!p) {
      chip.classList.add("hidden");
      input.placeholder = defaultPlaceholder;
      return;
    }
    const path = chain(p).map((x) => x.q).join(" › ");
    chip.innerHTML = `<span class="rc-label">Searching within</span>
      <span class="rc-path" title="${esc(path)}">${esc(path)}</span>
      ${p.count != null ? `<span class="rc-count">${esc(p.count)} best fits${p.nearCount ? ` + ${esc(p.nearCount)} near` : ""}</span>` : ""}
      <button class="rc-x" type="button" data-refine-off aria-label="Search the whole network instead">✕</button>`;
    chip.classList.remove("hidden");
    input.placeholder = "Narrow these results… e.g. “based in Atlanta” or “with startup experience”";
    input.focus();
  }

  // ---------- results pane ----------
  function stepText(e) {
    const steps = e.parentId ? REFINE_STEPS : THINKING_STEPS;
    return steps[Math.min(steps.length - 1, Math.floor((Date.now() - e.at) / 9000))];
  }

  function titleHtml(e) {
    const path = chain(e);
    const crumbs = path.length > 1
      ? `<div class="crumbs">${path.slice(0, -1).map((x) => `<button class="crumb" type="button" data-hid="${esc(x.id)}">${esc(x.q)}</button>`).join(`<span class="crumb-sep">›</span>`)}<span class="crumb-sep">›</span></div>`
      : "";
    const actions = e.status === "done" && e.runIds?.length
      ? `<button class="btn btn-secondary btn-sm" type="button" data-refine="${esc(e.id)}" title="Search within these results">
           <span aria-hidden="true">⌕</span> Refine these results</button>`
      : "";
    return `<header class="result-title">
        <div class="rt-main">${crumbs}<h2>${esc(e.q)}</h2></div>
        <div class="rt-side"><span class="muted small">${esc(timeAgo(e.at))}</span>${actions}</div>
      </header>`;
  }

  function render() {
    const e = activeId ? byId(activeId) : null;
    renderHistory();
    if (!e) return showWelcome();
    suggestions.classList.add("hidden");
    let body;
    if (e.status === "pending") {
      body = `<div class="thinking big"><span class="spinner"></span><span class="thinking-text">${esc(stepText(e))}</span></div>
        <p class="muted small">You can open other searches on the left while this one runs.</p>`;
    } else if (e.status === "error") {
      body = `<p class="error-text">Search failed: ${esc(e.error || "network error")}.</p>
        <button class="btn-pill" type="button" data-rerun="${esc(e.id)}">Try again</button>`;
    } else {
      body = e.html;
    }
    pane.innerHTML = `<div class="result-card" data-hid="${esc(e.id)}">${titleHtml(e)}<div class="result-body">${body}</div></div>`;
    pane.querySelectorAll(".load-more").forEach((x) => delete x.dataset.busy);
  }

  function select(id) {
    activeId = id;
    render();
    pane.scrollIntoView({ block: "nearest" });
  }

  function showWelcome() {
    activeId = null;
    renderHistory();
    pane.innerHTML = `
      <div class="result-card welcome">
        <h2>Search ${esc(getNetworkName() || "your network")}</h2>
        <p class="muted">Ask about the people you know: skills, companies, schools, locations, or who could mentor or refer you.
        Your searches are saved on the left. Use <b>Refine these results</b> on any search to narrow it down without
        starting over — refinements appear nested under the search they came from.</p>
      </div>`;
    suggestions.classList.remove("hidden");
  }

  // ---------- running a search (in the background) ----------
  function startTicker(e) {
    tickers.set(e.id, setInterval(() => {
      if (activeId !== e.id) return;
      const el = pane.querySelector(".thinking-text");
      if (el) el.textContent = stepText(e);
    }, 3000));
  }
  function stopTicker(id) { clearInterval(tickers.get(id)); tickers.delete(id); }

  /** Build a result object (same shape 05A returns) for a refinement. */
  function refinedResult(res, ref) {
    const why = new Map([...(res.best_fit || []), ...(res.near_matches || [])].map((x) => [x.profile_id, x]));
    const shape = (items, kind) => items.map((x) => {
      const item = shapeExtraRow(x, kind);
      const w = why.get(x.profile_id);
      if (w?.why) item.why = w.why;
      if (kind === "near" && w?.gap) item.gap = w.gap;
      if (w?.companies) item.companies = w.companies;
      return item;
    });
    return {
      ok: true,
      run_id: null,                    // everything is shown at once, no paging
      refined_within: ref.within_total,
      interpreted_goal: res.interpreted_goal,
      totals: { best_fit_total: ref.best_total, near_match_total: ref.near_total },
      best_fit: shape(ref.best || [], "best"),
      near_matches: shape(ref.near || [], "near"),
      suggested_next_searches: [],
      interpretation_notes: res.interpretation_notes || [],
    };
  }

  /**
   * After a search, quietly research the companies (current and past) of the people it showed,
   * so the next searches can describe those companies from their own LinkedIn pages.
   * Results go to the shared company cache, reused by every user and network.
   */
  async function researchShown(datasetId, result) {
    const ids = [...(result?.best_fit || []), ...(result?.near_matches || [])]
      .map((x) => x.profile_id).filter(Boolean).slice(0, 40);
    if (!ids.length) return;
    try {
      for (let i = 0; i < 6; i++) {                 // ≤60 company pages per search
        const r = await researchCompanies(datasetId, { profileIds: ids, link: i === 0 });
        if (!r?.ok || !r.claimed) break;
      }
    } catch { /* best effort: never disturbs the search */ }
  }

  async function run(e) {
    e.status = "pending";
    e.at = Date.now();
    e.error = null;
    startTicker(e);
    if (activeId === e.id) render(); else renderHistory();
    try {
      const datasetId = getDatasetId();
      const res = await search(datasetId, e.fullQ);
      let result = res;
      const runId = res && typeof res === "object" ? res.run_id : null;
      const parent = e.parentId ? byId(e.parentId) : null;
      if (parent) {
        if (!runId || !parent.runIds?.length) throw new Error("This search can't be refined (no saved results to search within).");
        e.runIds = [...parent.runIds, runId];
        result = refinedResult(res, await refineResults(e.runIds));
      } else {
        e.runIds = runId ? [runId] : [];
      }
      e.html = renderResult(result, CONFIG.RESULTS_PAGE_SIZE);
      e.count = Number(result?.totals?.best_fit_total ?? (result?.best_fit || []).length) || 0;
      e.nearCount = Number(result?.totals?.near_match_total ?? (result?.near_matches || []).length) || 0;
      e.status = "done";
      save();
      researchShown(datasetId, result);   // background: verified company facts for the people shown
    } catch (err) {
      e.status = "error";
      e.error = err.message || "network error";
    } finally {
      stopTicker(e.id);
      if (activeId === e.id) render(); else renderHistory();
    }
  }

  function ask(question) {
    const q = question.trim();
    if (!q) return;
    const parent = refineParentId ? byId(refineParentId) : null;
    const e = {
      id: newId(),
      parentId: parent ? parent.id : null,
      q,
      // 05A sees the whole intent; the server then keeps only people from the parent results.
      fullQ: parent ? `${parent.fullQ || parent.q}, ${q}` : q,
      runIds: [],
      html: "",
      at: Date.now(),
      status: "pending",
    };
    if (parent) parent.collapsed = false;
    entries = [e, ...entries];
    setRefine(null);
    select(e.id);
    run(e);                             // not awaited: the user can keep navigating
  }

  // ---------- "Load more" / "Show all" (whole-network searches) ----------
  async function loadMore(box, all) {
    if (box.dataset.busy) return;
    box.dataset.busy = "1";
    const section = box.closest(".result-section");
    const bucket = box.dataset.bucket;
    const runId = box.dataset.run;
    const total = Number(box.dataset.total);
    let shown = Number(box.dataset.shown);
    const pageSize = CONFIG.RESULTS_PAGE_SIZE;
    box.innerHTML = `<span class="thinking"><span class="spinner"></span> Loading more…</span>`;
    try {
      let list = section.querySelector(".people");
      if (!list) { list = document.createElement("div"); list.className = "people"; box.before(list); }
      do {
        const want = all ? Math.min(200, total - shown) : Math.min(pageSize, total - shown);
        const page = await moreResults(runId, bucket, shown, want);
        const items = (page.items || []).map((x) => shapeExtraRow(x, bucket));
        if (!items.length) break;
        list.insertAdjacentHTML("beforeend", peopleHtml(items, bucket));
        shown += items.length;
        section.querySelector(".shown").textContent = String(shown);
      } while (all && shown < total);
      box.outerHTML = loadMoreHtml(runId, bucket, shown, total, pageSize) || "";
    } catch (err) {
      box.innerHTML = `<span class="error-text">Couldn't load more: ${esc(err.message || "network error")}</span>
        <button class="btn-text" type="button" data-load="page">Try again</button>`;
      box.dataset.shown = String(shown);
      delete box.dataset.busy;
      return;
    }
    const card = section.closest(".result-card");
    const e = byId(card?.dataset.hid);
    if (e) { e.html = card.querySelector(".result-body").innerHTML; save(); }
  }

  // ---------- wiring ----------
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
  form.addEventListener("submit", (ev) => { ev.preventDefault(); const q = input.value; input.value = ""; autosize(); ask(q); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
    if (ev.key === "Escape" && refineParentId) setRefine(null);
  });
  input.addEventListener("input", autosize);
  newButton.addEventListener("click", () => { setRefine(null); showWelcome(); input.focus(); });

  historyList.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-toggle]");
    if (t) {
      const e = byId(t.dataset.toggle);
      if (e) { e.collapsed = !e.collapsed; save(); renderHistory(); }
      return;
    }
    const b = ev.target.closest("[data-hid]");
    if (b) select(b.dataset.hid);
  });

  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#view-4")) return;
    if (ev.target.closest("[data-refine-off]")) { setRefine(null); return; }
    const ref = ev.target.closest("[data-refine]");
    if (ref) { setRefine(ref.dataset.refine); form.scrollIntoView({ block: "nearest" }); return; }
    const crumb = ev.target.closest(".crumb[data-hid]");
    if (crumb) { select(crumb.dataset.hid); return; }
    const rerun = ev.target.closest("[data-rerun]");
    if (rerun) { const e = byId(rerun.dataset.rerun); if (e) run(e); return; }
    const chipQ = ev.target.closest("[data-query]");
    if (chipQ) { ask(chipQ.dataset.query); return; }
    const more = ev.target.closest("[data-load]");
    if (more && more.closest(".load-more")) loadMore(more.closest(".load-more"), more.dataset.load === "all");
  });

  return {
    /** Show the workspace for the current network (reloads its saved searches). */
    open() {
      tickers.forEach((t) => clearInterval(t));
      tickers.clear();
      setRefine(null);
      load();
      const latest = roots()[0];
      if (latest) select(latest.id); else showWelcome();
      input.focus();
    },
    reset() { entries = []; save(); showWelcome(); },
  };
}
