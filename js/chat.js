import { CONFIG } from "../config.js";
import { search, moreResults } from "./api.js";
import { esc, renderResult, peopleHtml, loadMoreHtml, shapeExtraRow } from "./render.js";

const THINKING_STEPS = [
  "Understanding your question…",
  "Scanning your whole network…",
  "Screening the strongest candidates…",
  "Writing the reasons for each match…",
];

export function createChat({ log, form, input, button, suggestions, getDatasetId, storageKey }) {
  let busy = false;
  const history = loadHistory();

  function loadHistory() {
    try { return JSON.parse(sessionStorage.getItem(storageKey) || "[]"); } catch { return []; }
  }
  function saveHistory() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(history.slice(-12))); } catch { /* quota */ }
  }

  function scrollDown() { log.scrollTo({ top: log.scrollHeight, behavior: "smooth" }); }

  function addBubble(role, html) {
    const el = document.createElement("div");
    el.className = `msg msg-${role}`;
    el.innerHTML = role === "user"
      ? `<div class="bubble">${html}</div>`
      : `<div class="bot-avatar">ci</div><div class="bubble">${html}</div>`;
    log.appendChild(el);
    scrollDown();
    return el;
  }

  function welcome() {
    addBubble("bot", `<p><b>Your network is ready.</b> Ask about the people you know: skills, companies, schools, locations, or who could mentor or refer you.</p>`);
  }

  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    busy = true;
    button.disabled = true;
    suggestions.classList.add("hidden");
    addBubble("user", esc(q));

    const pending = addBubble("bot", `<div class="thinking"><span class="spinner"></span><span class="thinking-text">${THINKING_STEPS[0]}</span></div>`);
    const textEl = pending.querySelector(".thinking-text");
    let step = 0;
    const timer = setInterval(() => { step = Math.min(step + 1, THINKING_STEPS.length - 1); textEl.textContent = THINKING_STEPS[step]; }, 9000);

    try {
      const result = await search(getDatasetId(), q);
      const html = renderResult(result, CONFIG.RESULTS_PAGE_SIZE);
      const bubble = pending.querySelector(".bubble");
      bubble.innerHTML = html;
      bubble.dataset.hidx = String(history.length);
      history.push({ q, html });
      saveHistory();
    } catch (e) {
      pending.querySelector(".bubble").innerHTML =
        `<p class="error-text">Search failed: ${esc(e.message || "network error")}.</p><button class="btn-pill" data-retry="${esc(q)}">Try again</button>`;
    } finally {
      clearInterval(timer);
      busy = false;
      button.disabled = false;
      scrollDown();
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; autosize(); ask(q); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
  input.addEventListener("input", autosize);

  // "Load more" / "Show all": page through every result of that search run.
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
    // keep the restored chat (after a refresh) in sync with what's on screen
    const bubble = section.closest(".bubble");
    const idx = Number(bubble?.dataset.hidx);
    if (bubble && Number.isInteger(idx) && history[idx]) { history[idx].html = bubble.innerHTML; saveHistory(); }
  }

  // Chips (suggestions, "Try next"), retry and load-more buttons, anywhere in the chat
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-query]");
    if (chip && chip.closest("#view-4")) { ask(chip.dataset.query); return; }
    const retry = e.target.closest("[data-retry]");
    if (retry) { ask(retry.dataset.retry); return; }
    const more = e.target.closest("[data-load]");
    if (more && more.closest(".load-more")) loadMore(more.closest(".load-more"), more.dataset.load === "all");
  });

  return {
    open() {
      if (log.childElementCount) return;
      welcome();
      history.forEach((h, i) => {
        addBubble("user", esc(h.q));
        const b = addBubble("bot", h.html).querySelector(".bubble");
        b.dataset.hidx = String(i);
        b.querySelectorAll(".load-more").forEach((x) => delete x.dataset.busy);
      });
      if (history.length) suggestions.classList.add("hidden");
      input.focus();
    },
    reset() { log.innerHTML = ""; history.length = 0; saveHistory(); suggestions.classList.remove("hidden"); },
  };
}
