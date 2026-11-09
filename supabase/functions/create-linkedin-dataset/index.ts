/*
 * Edge Function: create-linkedin-dataset
 *
 * Public helper for the Connection Intelligence website.
 *
 *   POST multipart/form-data  { file: Connections.csv, name?: string }
 *     → uploads the CSV to the "linkedin-csv-imports" bucket,
 *       creates a li_datasets row (status "created"),
 *       returns { ok: true, dataset_id, source_filename, source_bucket }
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

  const datasetId = crypto.randomUUID();
  const path = `web/${datasetId}.csv`;
  const db = admin();

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

  return json({ ok: true, dataset_id: datasetId, name, connections, source_filename: path, source_bucket: BUCKET });
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
