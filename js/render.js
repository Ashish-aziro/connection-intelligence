// Pure render helpers: everything returns HTML strings built from escaped data.

export function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

function initials(name) {
  const parts = String(name || "?").replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const AVATAR_COLORS = ["#0a66c2", "#057642", "#b24020", "#5f4b8b", "#915907", "#0e7490", "#be185d"];
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function scoreClass(score) {
  const s = Number(score);
  if (s >= 85) return "score-high";
  if (s >= 70) return "score-mid";
  return "score-low";
}

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : "";
}

function personCard(p, kind) {
  const url = safeUrl(p.linkedin_url);
  const name = esc(p.name || "(no name)");
  const sub = [p.title, p.company].filter(Boolean).map(esc).join(" · ");
  const meta = [
    p.location && `<span>📍 ${esc(p.location)}</span>`,
    p.seniority && `<span>${esc(p.seniority)}</span>`,
    p.years_experience != null && p.years_experience !== "" && `<span>${esc(fmt(p.years_experience))} yrs exp.</span>`,
  ].filter(Boolean).join("");
  const gap = kind === "near" ? (p.gap || "") : (p.note || "");
  const evidence = Array.isArray(p.evidence) ? p.evidence.filter(Boolean).slice(0, 8) : [];

  return `
  <article class="person">
    <div class="avatar" style="background:${avatarColor(p.name)}">${esc(initials(p.name))}</div>
    <div class="person-body">
      <div class="person-top">
        <div>
          <h4>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name}</h4>
          ${sub ? `<p class="person-sub">${sub}</p>` : ""}
        </div>
        ${p.score != null ? `<div class="score ${scoreClass(p.score)}" title="Match score">${esc(fmt(p.score))}</div>` : ""}
      </div>
      ${meta ? `<div class="person-meta">${meta}</div>` : ""}
      ${p.why ? `<p class="why">${esc(p.why)}</p>` : ""}
      ${gap ? `<p class="gap"><strong>${kind === "near" ? "Gap" : "Note"}:</strong> ${esc(gap)}</p>` : ""}
      <div class="person-actions">
        ${url ? `<a class="btn-pill" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View profile</a>` : ""}
        ${evidence.length ? `<details><summary>Evidence (${evidence.length})</summary><ul>${evidence.map((e) => `<li>${esc(typeof e === "string" ? e : JSON.stringify(e))}</li>`).join("")}</ul></details>` : ""}
      </div>
    </div>
  </article>`;
}

function section(title, rows, total, kind) {
  const list = Array.isArray(rows) ? rows : [];
  return `
  <section class="result-section">
    <header class="result-section-head">
      <h3>${esc(title)}</h3>
      <span class="count">showing ${list.length} of ${esc(total ?? list.length)}</span>
    </header>
    ${list.length ? `<div class="people">${list.map((p) => personCard(p, kind)).join("")}</div>`
                  : `<p class="muted">No ${kind === "near" ? "near matches" : "best fits"} for this search.</p>`}
  </section>`;
}

export function renderResult(r) {
  if (typeof r === "string") return `<div class="md">${renderMarkdown(r)}</div>`;
  if (!r || typeof r !== "object") return `<p class="error-text">The search returned nothing readable.</p>`;
  if (r.ok === false) return `<p class="error-text">Search failed: ${esc(r.error || r.message || "unknown error")}</p>`;

  const t = r.totals || {};
  const stats = [
    t.profiles_scanned != null && `<div class="stat"><b>${esc(t.profiles_scanned)}</b><span>profiles scanned</span></div>`,
    `<div class="stat"><b>${esc(t.best_fit_total ?? (r.best_fit || []).length)}</b><span>best fits</span></div>`,
    `<div class="stat"><b>${esc(t.near_match_total ?? (r.near_matches || []).length)}</b><span>near matches</span></div>`,
  ].filter(Boolean).join("");

  const next = Array.isArray(r.suggested_next_searches) ? r.suggested_next_searches : [];
  const notes = Array.isArray(r.interpretation_notes) ? r.interpretation_notes : [];

  return `
  <div class="result">
    ${r.interpreted_goal ? `<p class="goal">${esc(r.interpreted_goal)}</p>` : ""}
    <div class="stats">${stats}</div>
    ${section("Best fits", r.best_fit, t.best_fit_total, "best")}
    ${section("Near matches", r.near_matches, t.near_match_total, "near")}
    ${next.length ? `<div class="next"><span>Try next:</span>${next.map((s) => {
      const q = typeof s === "string" ? s : s.query;
      const why = typeof s === "string" ? "" : s.reason;
      return q ? `<button class="chip" data-query="${esc(q)}" title="${esc(why || "")}">${esc(q)}</button>` : "";
    }).join("")}</div>` : ""}
    ${notes.length ? `<details class="notes"><summary>How your question was read</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
  </div>`;
}

// ---- tiny, escaped Markdown renderer (fallback when the flow returns Markdown) ----
function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
}

export function renderMarkdown(md) {
  const lines = String(md).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|\s*:?-{3}/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); i++; continue; }
    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*-\s+/, ""));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join("");
}

// ---- progress numbers from the status endpoint (shape-tolerant) ----
function pickNum(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

export function readProgress(status) {
  if (!status || typeof status !== "object") return null;
  let q = status.queue;
  if (Array.isArray(q)) q = q[0];
  if (typeof q === "string") { try { q = JSON.parse(q); } catch { q = null; } }
  const src = q && typeof q === "object" ? q : {};
  const total = pickNum(src, ["total", "total_profiles", "profiles_total", "total_count"]) ?? (status.profiles || null);
  const done = pickNum(src, ["enriched", "completed", "done", "enriched_count", "completed_count", "succeeded"]);
  const failed = pickNum(src, ["failed", "failed_count", "errors"]);
  const pending = pickNum(src, ["pending", "queued", "pending_count", "queued_count", "remaining"]);
  return { total, done, failed, pending, imported: status.profiles ?? null };
}
