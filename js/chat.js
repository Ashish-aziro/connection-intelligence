import { search } from "./api.js";
import { esc, renderResult } from "./render.js";

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
      const html = renderResult(result);
      pending.querySelector(".bubble").innerHTML = html;
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

  // Chips (suggestions, "Try next") and retry buttons, anywhere in the chat
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-query]");
    if (chip && chip.closest("#view-4")) { ask(chip.dataset.query); return; }
    const retry = e.target.closest("[data-retry]");
    if (retry) ask(retry.dataset.retry);
  });

  return {
    open() {
      if (log.childElementCount) return;
      welcome();
      for (const h of history) { addBubble("user", esc(h.q)); addBubble("bot", h.html); }
      if (history.length) suggestions.classList.add("hidden");
      input.focus();
    },
    reset() { log.innerHTML = ""; history.length = 0; saveHistory(); suggestions.classList.remove("hidden"); },
  };
}
