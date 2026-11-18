// "Enriched data" tab: browse what enrichment pulled for every connection.
import { profilesPage } from "./api.js";
import { esc } from "./render.js";

const PAGE = 50;
const AVATAR_COLORS = ["#0a2540", "#2b50a1", "#fe6900", "#13315c", "#057642", "#5f4b8b", "#915907"];

function initials(name) {
  const parts = String(name || "?").replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
function color(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || "").trim()) ? String(u).trim() : "");
const dates = (x) => [x.start, x.end].filter(Boolean).join(" – ") || x.period || "";

const STATUS = {
  completed: ["Enriched", "pill-ready"],
  failed: ["Unavailable", "pill-failed"],
  pending: ["Waiting", "pill-progress"],
  processing: ["Enriching…", "pill-progress"],
};

function profileHtml(p) {
  const url = safeUrl(p.linkedin_url);
  const [label, cls] = STATUS[p.status] || [p.status || "Unknown", "pill-progress"];
  const sub = [p.current_title, p.current_company].filter(Boolean).map(esc).join(" · ");
  const exp = p.experience || [], edu = p.education || [], skills = p.skills || [];
  const counts = [exp.length && `${exp.length} roles`, edu.length && `${edu.length} schools`, skills.length && `${skills.length} skills`]
    .filter(Boolean).join(" · ");

  const expHtml = exp.length ? `<div class="dp-block"><h5>Experience</h5><ol class="dp-timeline">${exp.map((e) => `
      <li><span class="dp-role"><b>${esc(e.title || "Role")}</b>${e.company ? ` · ${esc(e.company)}` : ""}</span>
        <span class="muted small">${esc([dates(e), e.duration, e.location, e.type].filter(Boolean).join(" · "))}</span>
        ${e.description ? `<p>${esc(e.description)}</p>` : ""}</li>`).join("")}</ol></div>` : "";
  const eduHtml = edu.length ? `<div class="dp-block"><h5>Education</h5><ul class="dp-edu">${edu.map((e) => `
      <li><b>${esc(e.school || "School")}</b>
        <span>${esc([e.degree, e.field].filter(Boolean).join(", "))}</span>
        <span class="muted small">${esc(dates(e))}</span></li>`).join("")}</ul></div>` : "";
  const skillHtml = skills.length ? `<div class="dp-block"><h5>Skills</h5><div class="dp-skills">${skills.map((s) => `<span class="skill">${esc(s)}</span>`).join("")}</div></div>` : "";
  const errHtml = p.status === "failed" && p.error ? `<p class="dp-error">Couldn't enrich: ${esc(p.error)}</p>` : "";

  return `
  <details class="data-row">
    <summary>
      <span class="avatar" style="background:${color(p.full_name)}">${esc(initials(p.full_name))}</span>
      <span class="dr-main">
        <span class="dr-name">${esc(p.full_name || "(no name)")}</span>
        ${p.headline ? `<span class="dr-headline">${esc(p.headline)}</span>` : ""}
        <span class="dr-meta">${sub ? `<span>${sub}</span>` : ""}${p.location ? `<span>📍 ${esc(p.location)}</span>` : ""}</span>
      </span>
      <span class="dr-side">
        <span class="pill ${cls}">${esc(label)}</span>
        ${counts ? `<span class="muted small">${esc(counts)}</span>` : ""}
      </span>
    </summary>
    <div class="dr-detail">
      ${errHtml}${expHtml}${eduHtml}${skillHtml}
      ${!expHtml && !eduHtml && !skillHtml && !errHtml ? `<p class="muted">No enriched details for this person yet.</p>` : ""}
      ${url ? `<a class="btn-pill" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open LinkedIn profile ↗</a>` : ""}
    </div>
  </details>`;
}

function csvCell(v) {
  const s = String(v ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createDataView({ list, more, summary, q, status, csvButton, countBadge, getDatasetId, getNetworkName }) {
  let shown = 0, total = 0, loading = false, token = 0, debounce = null;

  function renderSummary(s) {
    if (!s) return;
    countBadge.textContent = s.enriched ? Number(s.enriched).toLocaleString() : "";
    summary.innerHTML = `
      <div class="stats">
        <div class="stat"><b>${esc(Number(s.total).toLocaleString())}</b><span>connections</span></div>
        <div class="stat"><b>${esc(Number(s.enriched).toLocaleString())}</b><span>enriched</span></div>
        <div class="stat"><b>${esc(Number(s.unavailable).toLocaleString())}</b><span>unavailable</span></div>
        ${s.pending ? `<div class="stat"><b>${esc(Number(s.pending).toLocaleString())}</b><span>still waiting</span></div>` : ""}
      </div>
      <p class="muted small">What enrichment pulled for each connection in <b>${esc(getNetworkName() || "this network")}</b>. Click a person to see their experience, education and skills.</p>`;
  }

  function renderMore() {
    const left = total - shown;
    more.innerHTML = left > 0
      ? `<button class="btn btn-secondary btn-sm" type="button" data-more>Load ${Math.min(PAGE, left)} more</button>
         <span class="muted small">showing ${shown.toLocaleString()} of ${total.toLocaleString()}</span>`
      : (total ? `<span class="muted small">showing all ${total.toLocaleString()}</span>` : "");
  }

  async function loadPage(reset) {
    if (loading && !reset) return;
    const my = ++token;
    loading = true;
    if (reset) { shown = 0; list.innerHTML = `<div class="thinking big"><span class="spinner"></span> Loading enriched data…</div>`; more.innerHTML = ""; }
    else more.innerHTML = `<span class="thinking"><span class="spinner"></span> Loading more…</span>`;
    try {
      const r = await profilesPage(getDatasetId(), { offset: shown, limit: PAGE, q: q.value.trim(), status: status.value });
      if (my !== token) return;                         // a newer filter request replaced this one
      if (reset) { list.innerHTML = ""; renderSummary(r.summary); }
      total = Number(r.total) || 0;
      const items = r.items || [];
      list.insertAdjacentHTML("beforeend", items.map(profileHtml).join(""));
      shown += items.length;
      if (reset && !items.length) list.innerHTML = `<p class="muted center data-empty">No profiles match this filter.</p>`;
      renderMore();
    } catch (e) {
      if (my !== token) return;
      const msg = `<p class="error-text">Couldn't load the enriched data: ${esc(e.message || "network error")}</p>`;
      if (reset) list.innerHTML = msg; else more.innerHTML = msg;
    } finally {
      if (my === token) loading = false;
    }
  }

  async function downloadCsv() {
    csvButton.disabled = true;
    const label = csvButton.textContent;
    const rows = [["Name", "LinkedIn URL", "Headline", "Current title", "Current company", "Location", "Status",
      "Experience", "Education", "Skills"]];
    try {
      for (let off = 0, all = Infinity; off < all; off += 100) {
        csvButton.textContent = `Preparing… ${off}`;
        const r = await profilesPage(getDatasetId(), { offset: off, limit: 100, q: q.value.trim(), status: status.value });
        all = Number(r.total) || 0;
        for (const p of r.items || []) {
          rows.push([p.full_name, p.linkedin_url, p.headline, p.current_title, p.current_company, p.location, p.status,
            (p.experience || []).map((e) => [e.title, e.company, dates(e)].filter(Boolean).join(" @ ")).join(" | "),
            (p.education || []).map((e) => [e.school, e.degree, e.field].filter(Boolean).join(", ")).join(" | "),
            (p.skills || []).join("; ")]);
        }
        if (!(r.items || []).length) break;
      }
      const blob = new Blob(["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(getNetworkName() || "network").replace(/[^\w\- ]+/g, "").trim() || "network"} - enriched data.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      more.innerHTML = `<p class="error-text">CSV download failed: ${esc(e.message || "network error")}</p>`;
    } finally {
      csvButton.disabled = false;
      csvButton.textContent = label;
    }
  }

  q.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => loadPage(true), 350); });
  status.addEventListener("change", () => loadPage(true));
  more.addEventListener("click", (e) => { if (e.target.closest("[data-more]")) loadPage(false); });
  csvButton.addEventListener("click", downloadCsv);

  return {
    open() { q.value = ""; status.value = ""; loadPage(true); },
    /** Just refresh the count badge on the tab. */
    async peek() {
      try { const r = await profilesPage(getDatasetId(), { limit: 1 }); countBadge.textContent = r.summary?.enriched ? Number(r.summary.enriched).toLocaleString() : ""; }
      catch { countBadge.textContent = ""; }
    },
  };
}
