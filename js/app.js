import { CONFIG } from "../config.js";
import { createDataset } from "./api.js";
import { startEnrichment } from "./enrich.js";
import { createChat } from "./chat.js";

const $ = (id) => document.getElementById(id);
const STORE = "ci.state.v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let state = loadState();          // { step, datasetId, ready, name }
let selectedFile = null;
let stopEnrichment = null;
let elapsedTimer = null;

function loadState() {
  try { return { step: 1, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; } catch { return { step: 1 }; }
}
function setState(patch) {
  state = { ...state, ...patch };
  localStorage.setItem(STORE, JSON.stringify(state));
}

// ---------- views ----------
function show(step) {
  document.querySelectorAll("[data-view]").forEach((v) => v.classList.toggle("hidden", Number(v.dataset.view) !== step));
  document.querySelectorAll("#stepper li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("active", n === step);
    li.classList.toggle("done", n < step);
  });
  const hasDataset = Boolean(state.datasetId);
  $("dataset-tag").classList.toggle("hidden", !hasDataset);
  $("btn-reset").classList.toggle("hidden", !hasDataset && step < 2);
  if (hasDataset) $("dataset-tag").textContent = state.name || `Dataset ${state.datasetId.slice(0, 8)}…`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), 3500);
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

// ---------- step 2: file ----------
function countConnections(text) {
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => /first name/i.test(l) && /last name/i.test(l));
  return h < 0 ? -1 : lines.slice(h + 1).filter((l) => l.trim()).length;
}

async function pickFile(file) {
  showError("upload-error", "");
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) return showError("upload-error", "Please choose the Connections.csv file (not the ZIP).");
  if (file.size > CONFIG.MAX_FILE_BYTES) return showError("upload-error", "That file is larger than 15 MB. Is it the right file?");

  const n = countConnections(await file.text());
  if (n < 0) return showError("upload-error", "This CSV has no “First Name / Last Name” columns. Make sure it's Connections.csv from LinkedIn.");
  if (n === 0) return showError("upload-error", "The file has no connections in it.");

  selectedFile = file;
  $("file-name").textContent = file.name;
  $("file-meta").textContent = `${n.toLocaleString()} connections · ${(file.size / 1024).toFixed(0)} KB`;
  $("file-summary").classList.remove("hidden");
  $("dropzone").classList.add("hidden");
  $("btn-upload").disabled = false;
}

function clearFile() {
  selectedFile = null;
  $("file-input").value = "";
  $("file-summary").classList.add("hidden");
  $("dropzone").classList.remove("hidden");
  $("btn-upload").disabled = true;
}

async function upload() {
  if (!selectedFile) return;
  const btn = $("btn-upload");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner light"></span> Uploading…`;
  showError("upload-error", "");
  try {
    const res = await createDataset(selectedFile, $("dataset-name").value.trim(), { forceNew: $("force-new").checked });
    setState({ datasetId: res.dataset_id, name: res.name, ready: false, step: 3 });
    if (res.reused && res.already_enriched) {
      toast(`Already enriched — reusing “${res.name}” (${Number(res.enriched || 0).toLocaleString()} profiles). No new scraping.`);
    } else if (res.reused) {
      toast(`You uploaded this network before — continuing that enrichment instead of starting over.`);
    } else {
      toast(`Uploaded ${Number(res.connections || 0).toLocaleString()} connections`);
    }
    beginEnrichment();   // an already-enriched dataset comes back "ready" on the first Unified call
  } catch (e) {
    showError("upload-error", e.message || "Upload failed. Please try again.");
  } finally {
    btn.disabled = !selectedFile;
    btn.textContent = "Upload & start enrichment";
  }
}

// ---------- step 3: enrichment ----------
const PHASES = ["upload", "import", "enrich", "index", "ready"];
function markPhase(phase) {
  const idx = PHASES.indexOf(phase);
  document.querySelectorAll("#phases li").forEach((li) => {
    const i = PHASES.indexOf(li.dataset.phase);
    li.classList.toggle("done", i < idx || phase === "ready");
    li.classList.toggle("active", i === idx && phase !== "ready");
  });
}

function beginEnrichment() {
  show(3);
  $("enrich-dataset").textContent = state.datasetId;
  $("enrich-title").textContent = "Enriching your network…";
  $("view-3").querySelector(".enrich").classList.remove("stalled");
  document.querySelectorAll("#phases li.failed").forEach((li) => li.classList.remove("failed"));
  showError("enrich-error", "");
  $("btn-retry").classList.add("hidden");
  $("progress-bar").style.width = "3%";
  markPhase("import");

  const started = Date.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $("progress-elapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);

  stopEnrichment?.();
  stopEnrichment = startEnrichment(state.datasetId, {
    onProgress({ label, pct, phase }) {
      if (label) $("progress-label").textContent = label;
      if (pct) $("progress-bar").style.width = `${pct}%`;
      if (phase) markPhase(phase);
    },
    onReady() {
      clearInterval(elapsedTimer);
      markPhase("ready");
      $("progress-bar").style.width = "100%";
      $("progress-label").textContent = "Done. Your network is ready.";
      $("enrich-title").textContent = "Your network is ready";
      setState({ ready: true, step: 4 });
      setTimeout(openChat, 900);
    },
    onError(msg) {
      clearInterval(elapsedTimer);
      $("view-3").querySelector(".enrich").classList.add("stalled");
      $("enrich-title").textContent = "Enrichment paused";
      $("progress-label").textContent = "Stopped — no new calls are being made.";
      document.querySelectorAll("#phases li.active").forEach((li) => li.classList.add("failed"));
      showError("enrich-error", msg);
      $("btn-retry").classList.remove("hidden");
    },
  });
}

// ---------- step 4: chat ----------
const chat = createChat({
  log: $("chat-log"),
  form: $("composer"),
  input: $("question"),
  button: $("btn-ask"),
  suggestions: $("suggestions"),
  getDatasetId: () => state.datasetId,
  storageKey: "ci.chat.v1",
});

function openChat() {
  show(4);
  chat.open();
}

// ---------- wiring ----------
function resetAll() {
  if (!confirm("Start over with a new CSV? Your current dataset stays saved in the database.")) return;
  stopEnrichment?.();
  clearInterval(elapsedTimer);
  localStorage.removeItem(STORE);
  chat.reset();
  state = { step: 1 };
  clearFile();
  show(1);
}

function wire() {
  $("to-step-2").addEventListener("click", () => { setState({ step: 2 }); show(2); });
  $("back-to-1").addEventListener("click", () => { setState({ step: 1 }); show(1); });
  $("btn-upload").addEventListener("click", upload);
  $("file-clear").addEventListener("click", clearFile);
  $("file-input").addEventListener("change", (e) => pickFile(e.target.files[0]));
  $("btn-retry").addEventListener("click", beginEnrichment);
  $("btn-reset").addEventListener("click", resetAll);
  $("brand-home").addEventListener("click", (e) => { e.preventDefault(); show(state.ready ? 4 : state.step || 1); });

  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

  $("form-existing").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("existing-id").value.trim();
    if (!UUID_RE.test(id)) return showError("existing-error", "That isn't a valid dataset ID (UUID).");
    showError("existing-error", "");
    setState({ datasetId: id, name: `Dataset ${id.slice(0, 8)}…`, ready: false, step: 3 });
    beginEnrichment();   // Unified returns "ready" immediately if it's already enriched
  });
}

wire();
if (state.datasetId && state.ready) openChat();
else if (state.datasetId) beginEnrichment();
else show(state.step === 2 ? 2 : 1);
