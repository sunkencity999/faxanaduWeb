/*
 * Faxanadu web player.
 *
 * Ships with no game data: the ROM comes from a user-supplied file (or, for
 * local development, an optional gitignored rom/faxanadu.nes), is cached in
 * IndexedDB, and never leaves the browser.
 */
"use strict";

// ---------------------------------------------------------------------------
// IndexedDB — one store for the ROM, one for save states
// ---------------------------------------------------------------------------

const DB_NAME = "faxanaduWeb";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("rom")) db.createObjectStore("rom");
      if (!db.objectStoreNames.contains("states")) db.createObjectStore("states");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// ROM handling
// ---------------------------------------------------------------------------

// jsnes takes ROM data as a binary string (one char per byte).
function bufferToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  return chunks.join("");
}

function isINes(buffer) {
  const b = new Uint8Array(buffer.slice(0, 4));
  return b[0] === 0x4e && b[1] === 0x45 && b[2] === 0x53 && b[3] === 0x1a; // "NES\x1a"
}

// ---------------------------------------------------------------------------
// UI elements
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  screenWrap: $("screen-wrap"),
  screen: $("screen"),
  loader: $("loader"),
  loadError: $("load-error"),
  pickRom: $("pick-rom"),
  romInput: $("rom-input"),
  powerPanel: $("poweron"),
  romName: $("rom-name"),
  power: $("power"),
  ejectPre: $("eject-pre"),
  pausedBadge: $("paused-badge"),
  toolbar: $("toolbar"),
  pause: $("pause"),
  reset: $("reset"),
  slot: $("slot"),
  saveState: $("save-state"),
  loadState: $("load-state"),
  screenshot: $("screenshot"),
  fullscreen: $("fullscreen"),
  eject: $("eject"),
};

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

let browser = null; // jsnes.Browser instance, created at power-on
let romString = null; // loaded ROM as binary string
let romLabel = "";
let running = false;
let paused = false;

function showError(msg) {
  els.loadError.textContent = msg;
  els.loadError.classList.remove("hidden");
}

function showPanel(which) {
  els.loader.classList.toggle("hidden", which !== "loader");
  els.powerPanel.classList.toggle("hidden", which !== "power");
  els.pausedBadge.classList.add("hidden");
}

async function acceptRom(buffer, label, { persist } = { persist: true }) {
  if (!isINes(buffer)) {
    showError(`"${label}" is not an iNES ROM (missing NES header).`);
    return false;
  }
  romString = bufferToBinaryString(buffer);
  romLabel = label;
  if (persist) {
    try {
      await idbPut("rom", "rom", { data: buffer, name: label });
    } catch (e) {
      console.warn("Could not cache ROM in IndexedDB:", e);
    }
  }
  els.romName.textContent = label;
  showPanel("power");
  return true;
}

function powerOn() {
  if (!romString) return;
  if (browser) browser.destroy();
  els.screen.innerHTML = "";
  browser = new jsnes.Browser({
    container: els.screen,
    onError: (e) => {
      console.error("Emulator crashed:", e);
      showError("The emulator crashed. Reload the page and try again.");
      showPanel("loader");
      running = false;
    },
  });
  browser.loadROM(romString);
  browser.fitInParent();
  running = true;
  paused = false;
  showPanel("none");
  els.toolbar.classList.remove("hidden");
  els.pause.innerHTML = "&#10074;&#10074; Pause";
  window.focus();
}

function togglePause() {
  if (!running) return;
  paused = !paused;
  if (paused) {
    browser.stop();
    els.pausedBadge.classList.remove("hidden");
    els.pause.innerHTML = "&#9654; Resume";
  } else {
    browser.start();
    els.pausedBadge.classList.add("hidden");
    els.pause.innerHTML = "&#10074;&#10074; Pause";
  }
}

function reset() {
  if (!running) return;
  browser.loadROM(romString); // full power cycle
  if (paused) togglePause();
}

async function eject() {
  if (browser) {
    browser.destroy();
    browser = null;
  }
  running = false;
  paused = false;
  romString = null;
  els.screen.innerHTML = "";
  els.toolbar.classList.add("hidden");
  try {
    await idbDelete("rom", "rom");
  } catch (e) {
    console.warn("Could not remove cached ROM:", e);
  }
  showPanel("loader");
  els.loadError.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Save states
// ---------------------------------------------------------------------------

async function refreshSlotLabels() {
  for (const option of els.slot.options) {
    const meta = await idbGet("states", "slot" + option.value).catch(() => null);
    option.textContent = meta
      ? `Slot ${option.value} — ${new Date(meta.savedAt).toLocaleString()}`
      : `Slot ${option.value} — empty`;
  }
}

async function saveState() {
  if (!running || paused) return;
  const slot = els.slot.value;
  try {
    const state = browser.nes.toJSON();
    await idbPut("states", "slot" + slot, { state, savedAt: Date.now(), rom: romLabel });
    await refreshSlotLabels();
    flashButton(els.saveState, "Saved!");
  } catch (e) {
    console.error("Save state failed:", e);
    flashButton(els.saveState, "Failed");
  }
}

async function loadState() {
  if (!running) return;
  const slot = els.slot.value;
  const entry = await idbGet("states", "slot" + slot).catch(() => null);
  if (!entry) {
    flashButton(els.loadState, "Empty");
    return;
  }
  try {
    browser.nes.fromJSON(entry.state);
    if (paused) togglePause();
    flashButton(els.loadState, "Loaded!");
  } catch (e) {
    console.error("Load state failed:", e);
    flashButton(els.loadState, "Failed");
  }
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), 1200);
}

// ---------------------------------------------------------------------------
// Screenshot & fullscreen
// ---------------------------------------------------------------------------

function downloadScreenshot() {
  const canvas = els.screen.querySelector("canvas");
  if (!canvas) return;
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `faxanadu-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  a.click();
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    els.screenWrap.requestFullscreen().catch(() => {});
  }
}

function refit() {
  if (browser) browser.fitInParent();
}

// ---------------------------------------------------------------------------
// ROM sources: file picker, drag & drop, dev fetch, IndexedDB cache
// ---------------------------------------------------------------------------

async function handleFile(file) {
  if (!file) return;
  const buffer = await file.arrayBuffer();
  await acceptRom(buffer, file.name);
}

els.pickRom.addEventListener("click", () => els.romInput.click());
els.romInput.addEventListener("change", () => handleFile(els.romInput.files[0]));

["dragover", "dragenter"].forEach((ev) =>
  els.screenWrap.addEventListener(ev, (e) => {
    e.preventDefault();
    els.screenWrap.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.screenWrap.addEventListener(ev, (e) => {
    e.preventDefault();
    els.screenWrap.classList.remove("dragover");
  })
);
els.screenWrap.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

// Local development convenience: serve your own ROM from the gitignored
// rom/ directory and it is picked up automatically.
async function tryDevRom() {
  try {
    const res = await fetch("rom/faxanadu.nes");
    if (!res.ok) return false;
    const buffer = await res.arrayBuffer();
    if (!isINes(buffer)) return false;
    return acceptRom(buffer, "faxanadu.nes (local)", { persist: false });
  } catch {
    return false;
  }
}

async function init() {
  await refreshSlotLabels();
  const cached = await idbGet("rom", "rom").catch(() => null);
  if (cached && isINes(cached.data)) {
    await acceptRom(cached.data, cached.name, { persist: false });
    return;
  }
  if (await tryDevRom()) return;
  showPanel("loader");
}

// ---------------------------------------------------------------------------
// Toolbar & shortcuts
// ---------------------------------------------------------------------------

els.power.addEventListener("click", powerOn);
els.ejectPre.addEventListener("click", eject);
els.pause.addEventListener("click", togglePause);
els.reset.addEventListener("click", reset);
els.saveState.addEventListener("click", saveState);
els.loadState.addEventListener("click", loadState);
els.screenshot.addEventListener("click", downloadScreenshot);
els.fullscreen.addEventListener("click", toggleFullscreen);
els.eject.addEventListener("click", eject);

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  switch (e.key) {
    case "p":
    case "P":
      togglePause();
      break;
    case "f":
    case "F":
      if (running) toggleFullscreen();
      break;
    case "F5":
      e.preventDefault();
      saveState();
      break;
    case "F8":
      e.preventDefault();
      loadState();
      break;
  }
});

window.addEventListener("resize", refit);
document.addEventListener("fullscreenchange", refit);

init();
