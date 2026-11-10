/*
 * Edge Function: create-linkedin-dataset
 *
 * Public helper for the Connection Intelligence website.
 *
 *   POST multipart/form-data  { file: Connections.csv, name?: string }
 *     → if the same network (same set of profile URLs) was uploaded before, returns
 *       that dataset instead: { ok, reused: true, already_enriched, dataset_id, ... }
 *       (send force_new=1 to skip this and enrich from scratch)
 *     → otherwise uploads the CSV to "linkedin-csv-imports" under web/fp-<fingerprint>/,
 *       creates a li_datasets row (status "created"),
 *       returns { ok: true, reused: false, dataset_id, source_filename, source_bucket }
 *
 *   POST application/json  { action: "status", dataset_id }
 *     → returns { ok: true, dataset, profiles, queue } for the progress screen
 *
 * Deploy with JWT verification OFF (the website calls it without a login):
 *   supabase functions deploy create-linkedin-dataset --no-verify-jwt
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "linkedin-csv-imports";
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB is far above any real Connections.csv
const MAX_NAME = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function admin() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

// LinkedIn exports start with a few "Notes:" lines before the real header row.
function looksLikeConnectionsCsv(text: string) {
  const head = text.slice(0, 5000).toLowerCase();
  return head.includes("first name") && head.includes("last name") && head.includes("url");
}

function countConnections(text: string) {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /first name/i.test(l) && /last name/i.test(l));
  if (headerIdx < 0) return 0;
  return lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0).length;
}

// ---------- re-upload detection ----------
// Fingerprint = SHA-256 of the sorted, de-duplicated profile URLs. The same network
// exported twice (or uploaded twice) gets the same fingerprint even if the notes
// lines or row order differ.
function profileUrls(text: string): string[] {
  const found = text.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s",]+/gi) ?? [];
  const norm = found.map((u) =>
    u.toLowerCase().replace(/^http:/, "https:").replace(/\/\/[a-z]{2,3}\.linkedin/, "//www.linkedin")
      .split(/[?#]/)[0].replace(/\/+$/, ""));
  return [...new Set(norm)].sort();
}

async function fingerprint(text: string): Promise<string> {
  const urls = profileUrls(text);
  const basis = urls.length ? urls.join("\n") : text.trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

const fpFolder = (fp: string) => `web/fp-${fp}`;
const LEGACY_MARKERS = "web/legacy-scanned";
const LEGACY_SCAN_LIMIT = 25;

type Db = ReturnType<typeof admin>;

/** Index uploads made before fingerprinting existed (web/<id>.csv) — once per file. */
async function indexLegacyUploads(db: Db) {
  const { data: markers } = await db.storage.from(BUCKET).list(LEGACY_MARKERS, { limit: 1000 });
  const scanned = new Set((markers ?? []).map((m) => m.name));
  const { data: rows } = await db.from("li_datasets").select("id, source_filename")
    .eq("source_bucket", BUCKET).like("source_filename", "web/%.csv").not("source_filename", "like", "web/fp-%")
    .order("created_at", { ascending: false }).limit(LEGACY_SCAN_LIMIT);
  for (const row of rows ?? []) {
    if (scanned.has(row.id)) continue;
    const { data: blob } = await db.storage.from(BUCKET).download(row.source_filename);
    if (blob) {
      const fp = await fingerprint(await blob.text());
      await db.storage.from(BUCKET).upload(`${fpFolder(fp)}/${row.id}.ref`, new Blob([row.source_filename]), { upsert: true });
    }
    await db.storage.from(BUCKET).upload(`${LEGACY_MARKERS}/${row.id}`, new Blob([""]), { upsert: true });
  }
}

async function queueStatus(db: Db, datasetId: string) {
  const { data } = await db.rpc("get_linkedin_enrichment_queue_status", { p_dataset_id: datasetId });
  const q = Array.isArray(data) ? data[0] : data;
  const n = (k: string) => Number(q?.[k] ?? 0) || 0;
  return { completed: n("completed"), failed: n("failed"), pending: n("pending"), processing: n("processing"), total: n("total") };
}

/** Best existing dataset for this fingerprint: a finished one first, else the furthest along. */
async function findExisting(db: Db, fp: string) {
  try { await indexLegacyUploads(db); } catch (e) { console.error(JSON.stringify({ stage: "LEGACY_INDEX", error: String(e) })); }
  const { data: files } = await db.storage.from(BUCKET).list(fpFolder(fp), { limit: 100 });
  const ids = [...new Set((files ?? []).map((f) => f.name.replace(/\.(csv|ref)$/i, "")).filter((id) => UUID_RE.test(id)))];
  if (!ids.length) return null;

  const { data: rows } = await db.from("li_datasets").select("id, name, created_at").in("id", ids);
  let best: { id: string; name: string; done: boolean; score: number; q: Awaited<ReturnType<typeof queueStatus>> } | null = null;
  for (const row of rows ?? []) {
    const q = await queueStatus(db, row.id);
    if (q.total === 0) continue; // never imported — not worth reusing
    const done = q.pending === 0 && q.processing === 0 && q.completed > 0;
    const score = (done ? 1e9 : 0) + q.completed;
    if (!best || score > best.score) best = { id: row.id, name: row.name, done, score, q };
  }
  return best;
}

async function handleUpload(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ ok: false, error: "Attach the CSV as 'file'." }, 400);
  if (file.size === 0) return json({ ok: false, error: "The file is empty." }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: "The file is larger than 15 MB." }, 413);
  if (!/\.csv$/i.test(file.name)) return json({ ok: false, error: "Upload the Connections.csv file." }, 400);

  const text = await file.text();
  if (!looksLikeConnectionsCsv(text)) {
    return json({
      ok: false,
      error: "This doesn't look like LinkedIn's Connections.csv (no First Name / Last Name / URL columns).",
    }, 422);
  }
  const connections = countConnections(text);
  if (connections === 0) return json({ ok: false, error: "No connections found in the file." }, 422);

  const rawName = String(form.get("name") ?? "").trim().slice(0, MAX_NAME);
  const name = rawName || `LinkedIn Connections ${new Date().toISOString().slice(0, 10)}`;
  const forceNew = ["1", "true", "yes", "on"].includes(String(form.get("force_new") ?? "").toLowerCase());

  const db = admin();
  const fp = await fingerprint(text);

  if (!forceNew) {
    const existing = await findExisting(db, fp);
    if (existing) {
      return json({
        ok: true,
        reused: true,
        already_enriched: existing.done,
        dataset_id: existing.id,
        name: existing.name,
        connections,
        enriched: existing.q.completed,
        unavailable: existing.q.failed,
      });
    }
  }

  const datasetId = crypto.randomUUID();
  const path = `${fpFolder(fp)}/${datasetId}.csv`;

  const { error: upErr } = await db.storage.from(BUCKET).upload(path, new Blob([text], { type: "text/csv" }), {
    contentType: "text/csv",
    upsert: false,
  });
  if (upErr) {
    console.error(JSON.stringify({ stage: "UPLOAD_FAILED", error: upErr.message }));
    return json({ ok: false, error: "Could not store the file. Please try again." }, 500);
  }

  const { error: insErr } = await db.from("li_datasets").insert({
    id: datasetId,
    name,
    status: "created",
    source_filename: path,
    source_bucket: BUCKET,
  });
  if (insErr) {
    console.error(JSON.stringify({ stage: "DATASET_INSERT_FAILED", error: insErr.message }));
    await db.storage.from(BUCKET).remove([path]);
    return json({ ok: false, error: "Could not create the dataset. Please try again." }, 500);
  }

  return json({ ok: true, reused: false, dataset_id: datasetId, name, connections, source_filename: path, source_bucket: BUCKET });
}

async function handleStatus(datasetId: string) {
  if (!UUID_RE.test(datasetId)) return json({ ok: false, error: "dataset_id must be a valid UUID." }, 400);
  const db = admin();

  const { data: dataset, error: dsErr } = await db
    .from("li_datasets").select("id, name, status, created_at").eq("id", datasetId).maybeSingle();
  if (dsErr) {
    console.error(JSON.stringify({ stage: "STATUS_DATASET", error: dsErr.message }));
    return json({ ok: false, error: "Status lookup failed." }, 500);
  }
  if (!dataset) return json({ ok: false, error: "Dataset not found." }, 404);

  const { count: profiles } = await db
    .from("li_profiles").select("id", { count: "exact", head: true }).eq("dataset_id", datasetId);

  let queue: unknown = null;
  const { data: q, error: qErr } = await db.rpc("get_linkedin_enrichment_queue_status", { p_dataset_id: datasetId });
  if (!qErr) queue = q;

  return json({ ok: true, dataset, profiles: profiles ?? 0, queue });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  try {
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) return await handleUpload(req);

    const body = await req.json().catch(() => null);
    if (body && body.action === "status") return await handleStatus(String(body.dataset_id ?? "").trim());
    return json({ ok: false, error: "Send a CSV (multipart) or {action:'status', dataset_id}." }, 400);
  } catch (err) {
    console.error(JSON.stringify({ stage: "UNHANDLED", error: String(err) }));
    return json({ ok: false, error: "Unexpected server error." }, 500);
  }
});
