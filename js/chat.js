// Search workspace: past searches on the left, ask box on top, results below.
import { CONFIG } from "../config.js";
import { search, moreResults } from "./api.js";
import { esc, renderResult, peopleHtml, loadMoreHtml, shapeExtraRow } from "./render.js";

const THINKING_STEPS = [
  "Understanding your question…",
  "Scanning your whole network…",
  "Screening the strongest candidates…",
  "Writing the reasons for each match…",
];
const MAX_SAVED = 25;

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function countsFromHtml(html) {
  const m = String(html).match(/<b>(\d[\d,]*)<\/b><span>best fits/);
  return m ? `${m[1]} best fits` : "";
}

export function createChat({ pane, form, input, button, suggestions, historyList, historyEmpty, historyNetwork,
  newButton, getDatasetId, getNetworkName, userId }) {
  let busy = false;
  let entries = [];      // [{ id, q, html, at }] newest first, for the current network
  let activeId = null;
  let key = null;

  // ---------- storage (per user + network, survives sign-out/in) ----------
  function storageKey() { return `ci.history.v2:${userId}:${getDatasetId()}`; }
  function load() {
    key = storageKey();
    try { entries = JSON.parse(localStorage.getItem(key) || "[]"); } catch { entries = []; }
    if (!Array.isArray(entries)) entries = [];
  }
  function save() {
    let list = entries.slice(0, MAX_SAVED);
    while (list.length) {
      try { localStorage.setItem(key, JSON.stringify(list)); return; } catch { list = list.slice(0, -1); }
    }
  }

  // ---------- sidebar ----------
  function renderHistory(pendingQ = null) {
    historyNetwork.textContent = getNetworkName() || "";
    const pending = pendingQ
      ? `<li><button class="history-item active pending" type="button" disabled>
           <span class="h-q">${esc(pendingQ)}</span><span class="h-meta"><span class="spinner"></span> searching…</span>
         </button></li>`
      : "";
    historyList.innerHTML = pending + entries.map((e) => `
      <li><button class="history-item${!pendingQ && e.id === activeId ? " active" : ""}" type="button" data-hid="${esc(e.id)}" title="${esc(e.q)}">
        <span class="h-q">${esc(e.q)}</span>
        <span class="h-meta">${esc([countsFromHtml(e.html), timeAgo(e.at)].filter(Boolean).join(" · "))}</span>
      </button></li>`).join("");
    historyEmpty.classList.toggle("hidden", entries.length > 0 || Boolean(pendingQ));
  }

  // ---------- results pane ----------
  function showEntry(id) {
    const e = entries.find((x) => x.id === id);
    if (!e) return showWelcome();
    activeId = id;
    pane.innerHTML = `
      <div class="result-card" data-hid="${esc(e.id)}">
        <header class="result-title"><h2>${esc(e.q)}</h2><span class="muted small">${esc(timeAgo(e.at))}</span></header>
        <div class="result-body">${e.html}</div>
      </div>`;
    pane.querySelectorAll(".load-more").forEach((x) => delete x.dataset.busy);
    suggestions.classList.add("hidden");
    renderHistory();
    pane.scrollIntoView({ block: "nearest" });
  }

  function showWelcome() {
    activeId = null;
    pane.innerHTML = `
      <div class="result-card welcome">
        <h2>Search ${esc(getNetworkName() || "your network")}</h2>
        <p class="muted">Ask about the people you know: skills, companies, schools, locations, or who could mentor or refer you.
        Your searches are saved on the left so you can come back to them.</p>
      </div>`;
    suggestions.classList.remove("hidden");
    renderHistory();
  }

  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    busy = true;
    button.disabled = true;
    suggestions.classList.add("hidden");
    renderHistory(q);
    pane.innerHTML = `
      <div class="result-card">
        <header class="result-title"><h2>${esc(q)}</h2></header>
        <div class="thinking big"><span class="spinner"></span><span class="thinking-text">${THINKING_STEPS[0]}</span></div>
      </div>`;
    const textEl = pane.querySelector(".thinking-text");
    let step = 0;
    const timer = setInterval(() => { step = Math.min(step + 1, THINKING_STEPS.length - 1); textEl.textContent = THINKING_STEPS[step]; }, 9000);

    try {
      const result = await search(getDatasetId(), q);
      const entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, q, at: Date.now(),
        html: renderResult(result, CONFIG.RESULTS_PAGE_SIZE) };
      entries = [entry, ...entries].slice(0, MAX_SAVED);
      save();
      showEntry(entry.id);
    } catch (e) {
      renderHistory();
      pane.innerHTML = `
        <div class="result-card">
          <header class="result-title"><h2>${esc(q)}</h2></header>
          <p class="error-text">Search failed: ${esc(e.message || "network error")}.</p>
          <button class="btn-pill" type="button" data-retry="${esc(q)}">Try again</button>
        </div>`;
    } finally {
      clearInterval(timer);
      busy = false;
      button.disabled = false;
    }
  }

  // ---------- "Load more" / "Show all" ----------
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
    } catch (e) {
      box.innerHTML = `<span class="error-text">Couldn't load more: ${esc(e.message || "network error")}</span>
        <button class="btn-text" type="button" data-load="page">Try again</button>`;
      box.dataset.shown = String(shown);
      delete box.dataset.busy;
      return;
    }
    // keep the saved search in sync with what's on screen
    const card = section.closest(".result-card");
    const entry = entries.find((x) => x.id === card?.dataset.hid);
    if (entry) { entry.html = card.querySelector(".result-body").innerHTML; save(); }
  }

  // ---------- wiring ----------
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; autosize(); ask(q); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener("input", autosize);
  newButton.addEventListener("click", () => { if (!busy) { showWelcome(); input.focus(); } });
  historyList.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hid]");
    if (b && !busy) showEntry(b.dataset.hid);
  });

  // Chips (suggestions, "Try next"), retry and load-more buttons inside the workspace
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#view-4")) return;
    const chip = e.target.closest("[data-query]");
    if (chip) { ask(chip.dataset.query); return; }
    const retry = e.target.closest("[data-retry]");
    if (retry) { ask(retry.dataset.retry); return; }
    const more = e.target.closest("[data-load]");
    if (more && more.closest(".load-more")) loadMore(more.closest(".load-more"), more.dataset.load === "all");
  });

  return {
    /** Show the workspace for the current network (reloads its saved searches). */
    open() {
      load();
      if (entries.length) showEntry(entries[0].id);
      else showWelcome();
      input.focus();
    },
    reset() { entries = []; save(); showWelcome(); },
  };
}
