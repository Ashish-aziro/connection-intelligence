import { CONFIG } from "../config.js";

function unesc(t) {
  return t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function tryJson(v) {
  if (typeof v !== "string") return v;
  const t = v.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  for (const x of [t, unesc(t)]) { try { return JSON.parse(x); } catch {} }
  return v;
}

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await res.text();
  const data = tryJson(raw);
  if (!res.ok) {
    const msg = (data && typeof data === "object" && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Upload Connections.csv → { dataset_id, name, connections } */
export async function createDataset(file, name, { forceNew = false } = {}) {
  const form = new FormData();
  form.append("file", file);
  if (name) form.append("name", name);
  if (forceNew) form.append("force_new", "1");
  const res = await fetch(CONFIG.DATASET_FN_URL, { method: "POST", body: form });
  const data = tryJson(await res.text());
  if (!res.ok || !data || data.ok !== true) {
    throw new Error((data && data.error) || `Upload failed (HTTP ${res.status}).`);
  }
  return data;
}

/** Progress numbers for the enrichment screen (best effort). */
export async function getStatus(datasetId) {
  return postJson(CONFIG.DATASET_FN_URL, { action: "status", dataset_id: datasetId });
}

/** One Unified run. Each call is a fresh session so it never lands in the "wait for query" step. */
export async function runUnified(datasetId, signal) {
  const data = await postJson(CONFIG.UNIFIED_URL, { question: JSON.stringify({ dataset_id: datasetId }) }, signal);
  const text = data && typeof data === "object" ? data.text ?? data.json ?? data : data;
  return { raw: data, reply: tryJson(text) };
}

/** Ask 05A one question. Returns the parsed result (object) or Markdown (string). */
export async function search(datasetId, query, signal) {
  const payload = { dataset_id: datasetId, query, output_format: CONFIG.SEARCH_OUTPUT_FORMAT };
  const data = await postJson(CONFIG.SEARCH_URL, { question: JSON.stringify(payload) }, signal);
  let r = data;
  for (let i = 0; i < 4; i++) {
    if (!r || typeof r !== "object" || Array.isArray(r)) break;
    if ("best_fit" in r || "near_matches" in r) break;
    if (typeof r.text === "string") { r = tryJson(r.text); continue; }
    if (r.data !== undefined) { r = tryJson(r.data); continue; }
    break;
  }
  return r;
}
