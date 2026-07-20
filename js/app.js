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
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("rom")) db.createObjectStore("rom");
      if (!db.objectStoreNames.contains("states")) db.createObjectStore("states");
      if (!db.objectStoreNames.contains("hdpack")) db.createObjectStore("hdpack");
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
let romBytes = null; // pristine ROM bytes (Uint8Array), never modified
let romLabel = "";
let running = false;
let paused = false;

// ---------------------------------------------------------------------------
// Enhancement options (see patches.js) — persisted in localStorage
// ---------------------------------------------------------------------------

const OPTIONS_KEY = "faxanaduOptions";

function loadOptions() {
  try {
    return JSON.parse(localStorage.getItem(OPTIONS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveOptions(opts) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
  } catch (e) {
    console.warn("Could not persist options:", e);
  }
}

let options = loadOptions();

function buildEnhancementsUI() {
  const box = document.getElementById("enhancements");
  const note = document.createElement("p");
  note.className = "note";
  note.innerHTML =
    "Optional tweaks ported from " +
    '<a href="https://github.com/Daivuk/Daxanadu">Daxanadu</a> by David St-Louis (MIT). ' +
    "All off by default for the authentic experience. ROM changes apply on the next Power On / Reset.";

  for (const patch of ROM_PATCHES) {
    const row = document.createElement("label");
    row.className = "opt";
    row.title = patch.hint;
    if (patch.kind === "toggle") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.patch = patch.id;
      cb.checked = options[patch.id] === true;
      cb.addEventListener("change", () => {
        options[patch.id] = cb.checked;
        saveOptions(options);
        hintRestart();
      });
      row.append(cb, ` ${patch.label}`);
    } else {
      const sel = document.createElement("select");
      sel.dataset.patch = patch.id;
      for (const c of patch.choices) {
        const o = document.createElement("option");
        o.value = c.value;
        o.textContent = c.label;
        sel.append(o);
      }
      sel.value = options[patch.id] || patch.default;
      sel.addEventListener("change", () => {
        options[patch.id] = sel.value;
        saveOptions(options);
        hintRestart();
      });
      row.append(`${patch.label}: `, sel);
    }
    box.append(row);
  }

  // Area-name overlay (no ROM edit, takes effect immediately)
  const row = document.createElement("label");
  row.className = "opt";
  row.title = AREA_NAMES_OPTION.hint;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = options[AREA_NAMES_OPTION.id] === true;
  cb.addEventListener("change", () => {
    options[AREA_NAMES_OPTION.id] = cb.checked;
    saveOptions(options);
  });
  row.append(cb, ` ${AREA_NAMES_OPTION.label}`);
  box.append(row, note);
}

function hintRestart() {
  const el = document.getElementById("enh-restart-hint");
  if (running) el.classList.remove("hidden");
}

// Grey out patches whose expected bytes aren't present in this ROM revision.
function updatePatchCompatibility() {
  const compat = patchCompatibility(romBytes);
  document.querySelectorAll("#enhancements [data-patch]").forEach((el) => {
    const ok = compat[el.dataset.patch] !== false;
    el.disabled = !ok;
    el.closest(".opt").classList.toggle("incompatible", !ok);
    if (!ok) el.closest(".opt").title = "Not available: this ROM revision has different bytes at the patch site.";
  });
}

function buildRomString() {
  const { bytes, applied, skipped } = applyRomPatches(romBytes, options);
  if (applied.length) console.info("Enhancements applied:", applied.join(", "));
  if (skipped.length) console.warn("Enhancements skipped (ROM mismatch):", skipped.join(", "));
  return bufferToBinaryString(bytes.buffer);
}

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
  romBytes = new Uint8Array(buffer.slice(0));
  romLabel = label;
  updatePatchCompatibility();
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
  if (!romBytes) return;
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
  browser.loadROM(buildRomString());
  browser.fitInParent();
  running = true;
  paused = false;
  showPanel("none");
  els.toolbar.classList.remove("hidden");
  els.pause.innerHTML = "&#10074;&#10074; Pause";
  document.getElementById("enh-restart-hint").classList.add("hidden");
  startAreaWatcher();
  HD.attach(browser, els.screen);
  HD.setEnabled(options.hd_enabled === true);
  requestAnimationFrame(() => HD.syncSize());
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
  browser.loadROM(buildRomString()); // full power cycle, picks up option changes
  if (paused) togglePause();
  document.getElementById("enh-restart-hint").classList.add("hidden");
}

async function eject() {
  if (browser) {
    browser.destroy();
    browser = null;
  }
  running = false;
  paused = false;
  romBytes = null;
  stopAreaWatcher();
  HD_BUILDER.stop();
  HD.detach();
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
// Area-name overlay (ported from Daxanadu's RoomWatcher — reads CPU RAM)
// ---------------------------------------------------------------------------

let areaTimer = null;
let lastAreaName = "";
let areaHideTimeout = null;

function startAreaWatcher() {
  stopAreaWatcher();
  lastAreaName = "";
  areaTimer = setInterval(() => {
    if (!running || paused || options[AREA_NAMES_OPTION.id] !== true) return;
    const mem = browser.nes.cpu.mem;
    const name = areaNameFor(mem[0x0024], mem[0x0063]);
    if (name && name !== lastAreaName) {
      lastAreaName = name;
      const el = document.getElementById("area-name");
      el.textContent = name;
      el.classList.add("show");
      clearTimeout(areaHideTimeout);
      areaHideTimeout = setTimeout(() => el.classList.remove("show"), 3000);
    }
  }, 250);
}

function stopAreaWatcher() {
  clearInterval(areaTimer);
  areaTimer = null;
  clearTimeout(areaHideTimeout);
  const el = document.getElementById("area-name");
  if (el) el.classList.remove("show");
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
  HD.syncSize();
}

// ---------------------------------------------------------------------------
// HD pack UI
// ---------------------------------------------------------------------------

function hdStatus(msg) {
  document.getElementById("hd-status").textContent = msg;
}

async function loadHdPackFiles(fileList) {
  try {
    const files = Array.from(fileList);
    const pack = await buildHdPackFromFiles(files);
    HD.setPack(pack);
    // persist raw files for next session
    const stored = await Promise.all(
      files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))
    );
    await idbPutHdPack({ files: stored, savedAt: Date.now() });
    hdStatus(`Pack loaded: ${pack.ruleCount} tile rules at ${pack.scale}x.`);
    document.getElementById("hd-enable").checked = true;
    options.hd_enabled = true;
    saveOptions(options);
    HD.setEnabled(true);
    HD.syncSize();
  } catch (e) {
    console.error(e);
    hdStatus(`Could not load pack: ${e.message}`);
  }
}

async function restoreHdPack() {
  const entry = await idbGetHdPack();
  if (!entry) return;
  try {
    const pack = await buildHdPackFromFiles(entry.files);
    HD.setPack(pack);
    hdStatus(`Pack restored: ${pack.ruleCount} tile rules at ${pack.scale}x.`);
  } catch (e) {
    console.warn("Stored HD pack failed to load:", e);
  }
}

function wireHdUI() {
  const enable = document.getElementById("hd-enable");
  enable.checked = options.hd_enabled === true;
  enable.addEventListener("change", () => {
    options.hd_enabled = enable.checked;
    saveOptions(options);
    HD.setEnabled(enable.checked);
    HD.syncSize();
  });

  const input = document.getElementById("hd-files");
  document.getElementById("hd-load").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files.length) loadHdPackFiles(input.files);
  });

  document.getElementById("hd-clear").addEventListener("click", async () => {
    HD.setPack(null);
    await idbDeleteHdPack();
    hdStatus("Pack removed. HD mode now renders native tiles only.");
  });

  const rec = document.getElementById("hd-record");
  rec.addEventListener("change", () => {
    if (rec.checked) {
      if (!HD.active) {
        rec.checked = false;
        hdStatus("Enable HD graphics and start the game before recording.");
        return;
      }
      HD_BUILDER.start();
      hdStatus("Recording tiles… play through areas you want in the template.");
    } else {
      HD_BUILDER.stop();
      hdStatus(`Recording paused. ${HD_BUILDER.count} unique tiles collected.`);
    }
  });

  document.getElementById("hd-export").addEventListener("click", async () => {
    if (HD_BUILDER.count === 0) {
      hdStatus("Nothing recorded yet. Turn on recording and play first.");
      return;
    }
    const n = await HD_BUILDER.export();
    hdStatus(`Exported template pack with ${n} tiles (faxanadu-hd.png + hires.txt).`);
  });
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
  buildEnhancementsUI();
  wireHdUI();
  await restoreHdPack();
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
