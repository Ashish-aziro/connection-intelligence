import { CONFIG } from "../config.js";
import { createDataset, myDatasets, rememberDataset, earlierUploads, getStatus, AuthRequiredError } from "./api.js";
import { startEnrichment } from "./enrich.js";
import { createChat } from "./chat.js";
import { currentSession, onAuthChange, signOut } from "./auth.js";
import { initLogin } from "./login.js";
import { esc } from "./render.js";

const $ = (id) => document.getElementById(id);

// Per-user storage keys so two people on one browser never see each other's state.
let STORE = "ci.state.v1";
let state = { step: 1 };          // { step, datasetId, ready, name }
let selectedFile = null;
let stopEnrichment = null;
let elapsedTimer = null;
let chat = null;
let user = null;

function loadState() {
  try { return { step: 1, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; } catch { return { step: 1 }; }
}
function setState(patch) {
  state = { ...state, ...patch };
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage blocked */ }
}

// ---------- views ----------
function showAuthScreen(which = "view-auth") {
  stopEnrichment?.();
  clearInterval(elapsedTimer);
  document.querySelectorAll("[data-view]").forEach((v) => v.classList.add("hidden"));
  $("stepper").classList.add("hidden");
  ["view-auth", "view-reset"].forEach((id) => $(id).classList.toggle("hidden", id !== which));
  ["dataset-tag", "btn-reset", "user-menu"].forEach((id) => $(id).classList.add("hidden"));
}

function show(step) {
  ["view-auth", "view-reset"].forEach((id) => $(id).classList.add("hidden"));
  // The search workspace uses the full page width and drops the step bar.
  document.querySelector(".shell").classList.toggle("wide", step === 4);
  $("stepper").classList.toggle("hidden", step === 4);
  $("user-menu").classList.toggle("hidden", !user);
  if (step === 1) loadMyNetworks();
  document.querySelectorAll("[data-view]").forEach((v) => v.classList.toggle("hidden", Number(v.dataset.view) !== step));
  document.querySelectorAll("#stepper li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("active", n === step);
    li.classList.toggle("done", n < step);
  });
  const hasDataset = Boolean(state.datasetId) && step > 1;
  $("dataset-tag").classList.toggle("hidden", !hasDataset);
  $("btn-reset").classList.toggle("hidden", !hasDataset && step < 2);
  if (hasDataset) $("dataset-tag").textContent = displayName();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// The network's name for the header; never show a raw ID.
function displayName() {
  const n = String(state.name || "");
  return n && !/^Dataset [0-9a-f]{8}/i.test(n) ? n : "Your network";
}

/** Fetch the real name from the server (older saved state may only have an ID). */
function refreshName() {
  if (!state.datasetId) return;
  getStatus(state.datasetId).then((s) => {
    const name = s?.dataset?.name;
    if (name && name !== state.name) {
      setState({ name });
      $("dataset-tag").textContent = displayName();
      $("enrich-dataset").textContent = displayName();
    }
  }).catch(() => {});
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
    if (e instanceof AuthRequiredError) return showAuthScreen();
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
  refreshName();
  $("enrich-dataset").textContent = displayName();
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
function openChat() {
  show(4);
  chat.open();
}

// ---------- home: the signed-in user's networks as tiles ----------
const TILE_COLORS = ["#0a2540", "#2b50a1", "#fe6900", "#13315c", "#057642", "#5f4b8b"];
function tileColor(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}
const NETWORK_ICON = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
  <circle cx="12" cy="6" r="2.6"/><circle cx="5.5" cy="17" r="2.6"/><circle cx="18.5" cy="17" r="2.6"/>
  <path d="M10.7 8.3 6.8 14.7M13.3 8.3l3.9 6.4M8.1 17h7.8"/></svg>`;

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function networkTile(d, { action = "open" } = {}) {
  const status = d.ready
    ? `<span class="pill pill-ready">Ready to search</span>`
    : `<span class="pill pill-progress">${esc(d.enriched)} of ${esc(d.total)} enriched</span>`;
  const attr = action === "add" ? "data-add" : "data-open";
  return `<button class="network-tile" type="button" ${attr}="${esc(d.id)}" data-name="${esc(d.name)}" title="${esc(d.name)}">
      <span class="net-icon" style="background:${tileColor(d.name)}">${NETWORK_ICON}</span>
      <span class="net-body">
        <span class="net-name">${esc(d.name)}</span>
        <span class="net-meta">${esc(Number(d.total).toLocaleString())} connections · ${esc(fmtDate(d.created_at))}</span>
        ${status}
      </span>
      <span class="net-go" aria-hidden="true">${action === "add" ? "+" : "→"}</span>
    </button>`;
}

async function loadMyNetworks() {
  const box = $("my-networks");
  let items = [];
  try { items = await myDatasets(); } catch (e) {
    if (e instanceof AuthRequiredError) return showAuthScreen();
    return box.classList.add("hidden");
  }
  box.classList.toggle("hidden", items.length === 0);
  $("guide-card").querySelector(".step-badge").textContent = items.length ? "Add a new network" : "Step 1";
  $("network-list").innerHTML = items.map((d) => networkTile(d)).join("") +
    `<button class="network-tile network-new" type="button" data-new>
       <span class="net-icon net-icon-new">+</span>
       <span class="net-body"><span class="net-name">Upload a new network</span>
       <span class="net-meta">Add another Connections.csv</span></span>
     </button>`;
}

async function loadEarlierUploads() {
  const list = $("earlier-list");
  showError("earlier-error", "");
  try {
    const items = await earlierUploads();
    list.innerHTML = items.length
      ? items.map((d) => networkTile(d, { action: "add" })).join("")
      : `<p class="muted small">Nothing to add — every earlier network is already in someone's list.</p>`;
  } catch (e) {
    if (e instanceof AuthRequiredError) return showAuthScreen();
    list.innerHTML = "";
    showError("earlier-error", e.message || "Couldn't load earlier networks.");
  }
}

function openNetwork(id, name) {
  setState({ datasetId: id, name, ready: false, step: 3 });
  beginEnrichment();   // a ready network comes back "ready" on the first Unified call → chat
}

async function addEarlier(id, name, btn) {
  btn.disabled = true;
  try {
    await rememberDataset(id);
    toast(`Added “${name}” to your networks`);
    $("earlier-box").open = false;
    await loadMyNetworks();
  } catch (e) {
    btn.disabled = false;
    showError("earlier-error", e.message || "Couldn't add that network.");
  }
}

// ---------- wiring ----------
function resetAll() {
  if (!confirm("Start over with a new CSV? Your current dataset stays saved in the database.")) return;
  stopEnrichment?.();
  clearInterval(elapsedTimer);
  try { localStorage.removeItem(STORE); } catch { /* storage blocked */ }
  state = { step: 1 };   // saved searches stay with their network
  clearFile();
  show(1);
}

async function doSignOut() {
  stopEnrichment?.();
  await signOut();
  try { sessionStorage.clear(); } catch { /* storage blocked */ }
  location.reload();
}

function wire() {
  $("to-step-2").addEventListener("click", () => { setState({ step: 2 }); show(2); });
  $("back-to-1").addEventListener("click", () => { setState({ step: 1 }); show(1); });
  $("btn-upload").addEventListener("click", upload);
  $("file-clear").addEventListener("click", clearFile);
  $("file-input").addEventListener("change", (e) => pickFile(e.target.files[0]));
  $("btn-retry").addEventListener("click", beginEnrichment);
  $("btn-reset").addEventListener("click", resetAll);
  // Logo / product name = home: your networks + add a new one.
  $("brand-home").addEventListener("click", (e) => {
    e.preventDefault();
    if (!user) return;
    stopEnrichment?.();
    clearInterval(elapsedTimer);
    show(1);
  });

  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

  $("network-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (b) return openNetwork(b.dataset.open, b.dataset.name);
    if (e.target.closest("[data-new]")) { setState({ step: 2 }); show(2); }
  });
  $("earlier-box").addEventListener("toggle", () => { if ($("earlier-box").open) loadEarlierUploads(); });
  $("earlier-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (b) addEarlier(b.dataset.add, b.dataset.name, b);
  });
  $("btn-signout").addEventListener("click", doSignOut);
}

// ---------- boot: nothing is shown until we know who is signed in ----------
let started = false;

function enterApp(session) {
  if (started) return;
  started = true;
  user = session.user;
  const email = user.email || "";
  $("user-email").textContent = email;
  $("user-avatar").textContent = (email[0] || "?").toUpperCase();
  STORE = `ci.state.v1:${user.id}`;
  state = loadState();
  chat = createChat({
    pane: $("chat-log"),
    form: $("composer"),
    input: $("question"),
    button: $("btn-ask"),
    suggestions: $("suggestions"),
    historyList: $("history-list"),
    historyEmpty: $("history-empty"),
    historyNetwork: $("history-network"),
    newButton: $("history-new"),
    getDatasetId: () => state.datasetId,
    getNetworkName: () => displayName(),
    userId: user.id,
  });
  // After login, land on home (your networks). Only an unfinished enrichment resumes on its own.
  if (state.datasetId && !state.ready) beginEnrichment();
  else show(state.step === 2 ? 2 : 1);
}

async function boot() {
  wire();
  initLogin({ onSignedIn: (session) => session && enterApp(session) });

  onAuthChange((session, event) => {
    if (event === "PASSWORD_RECOVERY") return showAuthScreen("view-reset");
    if (session && !started) enterApp(session);
    if (!session && started) location.reload();
  });

  if (/type=recovery/.test(location.hash)) return showAuthScreen("view-reset");
  const session = await currentSession();
  if (session) enterApp(session);
  else showAuthScreen();
}

boot();
