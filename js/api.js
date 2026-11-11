import { CONFIG } from "../config.js";
import { accessToken } from "./auth.js";

/** Thrown when the session is missing/expired so the app can show the login screen. */
export class AuthRequiredError extends Error {}

async function authHeaders() {
  const token = await accessToken();
  if (!token) throw new AuthRequiredError("Please sign in to continue.");
  return { Authorization: `Bearer ${token}` };
}

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

async function postJson(url, body, signal, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await res.text();
  const data = tryJson(raw);
  if (!res.ok) {
    const msg = (data && typeof data === "object" && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = res.status === 401 && data?.code === "AUTH_REQUIRED" ? new AuthRequiredError(String(msg)) : new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Signed-in call to the dataset edge function. */
async function datasetFn(body, signal) {
  return postJson(CONFIG.DATASET_FN_URL, body, signal, await authHeaders());
}

/** Upload Connections.csv → { dataset_id, name, connections } */
export async function createDataset(file, name, { forceNew = false } = {}) {
  const form = new FormData();
  form.append("file", file);
  if (name) form.append("name", name);
  if (forceNew) form.append("force_new", "1");
  const res = await fetch(CONFIG.DATASET_FN_URL, { method: "POST", body: form, headers: await authHeaders() });
  const data = tryJson(await res.text());
  if (res.status === 401) throw new AuthRequiredError("Please sign in to continue.");
  if (!res.ok || !data || data.ok !== true) {
    throw new Error((data && data.error) || `Upload failed (HTTP ${res.status}).`);
  }
  return data;
}

/** Progress numbers for the enrichment screen (best effort). */
export async function getStatus(datasetId) {
  return datasetFn({ action: "status", dataset_id: datasetId });
}

/** The signed-in user's networks: [{ id, name, created_at, total, enriched, unavailable, ready }]. */
export async function myDatasets() {
  const r = await datasetFn({ action: "my_datasets" });
  return Array.isArray(r?.datasets) ? r.datasets : [];
}

/** Add a dataset (e.g. one entered by ID) to the signed-in user's list. */
export async function rememberDataset(datasetId) {
  return datasetFn({ action: "remember", dataset_id: datasetId });
}

/** One page of a search run's results ("Load more"): { items, total }. */
export async function moreResults(runId, bucket, offset, limit) {
  return datasetFn({ action: "results", run_id: runId, bucket, offset, limit });
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
