// All endpoints the site talks to. No secrets here — every URL below is public.
export const CONFIG = {
  // Unified flow (import + enrichment). Called with {"dataset_id": "..."} until it reports ready.
  UNIFIED_URL: "https://apex.aziro.ai/apexflow/api/v1/prediction/de2f4e23-59a6-4b77-a42a-b977d9f56bad",

  // 05A search flow. Called once per question.
  SEARCH_URL: "https://apex.aziro.ai/apexflow/api/v1/prediction/407a121d-d5e9-4b53-8c35-4a760ee3b87b",

  // Supabase edge function that stores the CSV and creates the li_datasets row.
  DATASET_FN_URL: "https://jkuchkrbwxpoozcyarzt.supabase.co/functions/v1/create-linkedin-dataset",

  // "json" lets the site draw its own result cards. ("table" returns Markdown.)
  SEARCH_OUTPUT_FORMAT: "json",

  ENRICH_RETRY_DELAY_MS: 8000,   // pause between Unified calls while enriching
  STATUS_POLL_MS: 5000,          // progress refresh while enriching
  ENRICH_MAX_ATTEMPTS: 200,      // safety stop (~30+ min)
  // Stop calling Unified when progress hasn't moved for this long AND this many calls.
  // Each Unified call starts scraper runs, so a stuck loop wastes runs (or money).
  STALL_AFTER_MS: 4 * 60 * 1000,
  STALL_AFTER_CALLS: 4,
  MAX_FILE_BYTES: 15 * 1024 * 1024,
};
