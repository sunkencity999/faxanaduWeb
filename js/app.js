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
  syncGamepadPlayer();
  renderGamepadUI();
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
// Keyboard remapping — stored in jsnes's own localStorage format ("keys":
// { keyCode: [player, button, label] }), so its KeyboardController picks the
// mapping up automatically on every power-on via loadKeys().
// ---------------------------------------------------------------------------

const BINDABLE_ACTIONS = [
  { button: "BUTTON_UP", label: "D-pad Up" },
  { button: "BUTTON_DOWN", label: "D-pad Down" },
  { button: "BUTTON_LEFT", label: "D-pad Left" },
  { button: "BUTTON_RIGHT", label: "D-pad Right" },
  { button: "BUTTON_A", label: "A — jump" },
  { button: "BUTTON_B", label: "B — attack / magic" },
  { button: "BUTTON_START", label: "Start — pause / item menu" },
  { button: "BUTTON_SELECT", label: "Select — switch item screens" },
  { button: "BUTTON_TURBO_A", label: "Turbo A" },
  { button: "BUTTON_TURBO_B", label: "Turbo B" },
];

// jsnes's built-in defaults (player 2 numpad entries preserved untouched).
function defaultKeys() {
  const C = jsnes.Controller;
  return {
    88: [1, C.BUTTON_A, "X"],
    89: [1, C.BUTTON_B, "Y"],
    90: [1, C.BUTTON_B, "Z"],
    17: [1, C.BUTTON_SELECT, "Right Ctrl"],
    13: [1, C.BUTTON_START, "Enter"],
    38: [1, C.BUTTON_UP, "Up"],
    40: [1, C.BUTTON_DOWN, "Down"],
    37: [1, C.BUTTON_LEFT, "Left"],
    39: [1, C.BUTTON_RIGHT, "Right"],
    83: [1, C.BUTTON_TURBO_A, "S"],
    65: [1, C.BUTTON_TURBO_B, "A"],
    103: [2, C.BUTTON_A, "Num-7"],
    105: [2, C.BUTTON_B, "Num-9"],
    99: [2, C.BUTTON_SELECT, "Num-3"],
    97: [2, C.BUTTON_START, "Num-1"],
    104: [2, C.BUTTON_UP, "Num-8"],
    98: [2, C.BUTTON_DOWN, "Num-2"],
    100: [2, C.BUTTON_LEFT, "Num-4"],
    102: [2, C.BUTTON_RIGHT, "Num-6"],
  };
}

function loadKeyMap() {
  try {
    const stored = JSON.parse(localStorage.getItem("keys"));
    if (stored && Object.keys(stored).length) return stored;
  } catch { /* fall through */ }
  return defaultKeys();
}

function saveKeyMap(keys) {
  localStorage.setItem("keys", JSON.stringify(keys));
  if (browser) browser.keyboard.setKeys(keys); // apply live
}

// Reserved by the app UI; refuse them so shortcuts keep working.
const RESERVED_KEYCODES = { 80: "P (pause)", 70: "F (fullscreen)", 116: "F5 (save state)", 119: "F8 (load state)" };

let bindingCapture = null; // { button, cell } while waiting for a key press

function keyLabelFromEvent(e) {
  if (e.key === " ") return "Space";
  if (e.key.length === 1) return e.key.toUpperCase();
  if (e.code === "ControlRight") return "Right Ctrl";
  if (e.code === "ControlLeft") return "Left Ctrl";
  if (e.code === "ShiftRight") return "Right Shift";
  if (e.code === "ShiftLeft") return "Left Shift";
  return e.key;
}

function renderBindingTable() {
  const C = jsnes.Controller;
  const keys = loadKeyMap();
  const table = document.getElementById("binding-table");
  table.innerHTML = "";
  for (const action of BINDABLE_ACTIONS) {
    const bound = Object.entries(keys)
      .filter(([, v]) => v[0] === 1 && v[1] === C[action.button])
      .map(([, v]) => v[2]);
    const row = document.createElement("tr");
    const keyCell = document.createElement("td");
    keyCell.className = "key";
    const btn = document.createElement("button");
    btn.className = "keybind";
    btn.textContent = bound.length ? bound.join(" / ") : "unbound";
    btn.title = "Click, then press the new key. Esc cancels.";
    btn.addEventListener("click", () => startBindingCapture(action, btn));
    keyCell.appendChild(btn);
    const labelCell = document.createElement("td");
    labelCell.textContent = action.label;
    row.append(keyCell, labelCell);
    table.appendChild(row);
  }
}

function startBindingCapture(action, btn) {
  cancelBindingCapture();
  bindingCapture = { action, btn, original: btn.textContent };
  btn.textContent = "press a key…";
  btn.classList.add("capturing");

  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener("keydown", onKey, true);
    const cap = bindingCapture;
    bindingCapture = null;
    btn.classList.remove("capturing");
    btn.blur();
    if (!cap || e.key === "Escape") {
      btn.textContent = cap ? cap.original : btn.textContent;
      return;
    }
    if (RESERVED_KEYCODES[e.keyCode]) {
      btn.textContent = cap.original;
      flashButton(btn, "reserved!");
      return;
    }
    const C = jsnes.Controller;
    const keys = loadKeyMap();
    // Remove existing player-1 bindings for this action, and any other
    // binding already using the chosen key.
    for (const code of Object.keys(keys)) {
      const [player, button] = keys[code];
      if ((player === 1 && button === C[cap.action.button]) || Number(code) === e.keyCode) {
        delete keys[code];
      }
    }
    keys[e.keyCode] = [1, C[cap.action.button], keyLabelFromEvent(e)];
    saveKeyMap(keys);
    renderBindingTable();
  };
  window.addEventListener("keydown", onKey, true);
}

function cancelBindingCapture() {
  if (bindingCapture) {
    bindingCapture.btn.textContent = bindingCapture.original;
    bindingCapture.btn.classList.remove("capturing");
    bindingCapture = null;
  }
}

// ---------------------------------------------------------------------------
// Gamepad mapping — stored in jsnes's own "gamepadConfig" localStorage format
// ({ playerGamepadId: [id, null], configs: { id: { buttons: [...] } } }), so
// its GamepadController drives the game directly. Note: jsnes gamepads do
// nothing until a config exists, so this UI is what enables pad support.
// ---------------------------------------------------------------------------

function loadGamepadConfig() {
  try {
    return JSON.parse(localStorage.getItem("gamepadConfig")) || null;
  } catch {
    return null;
  }
}

function saveGamepadConfig(cfg) {
  if (cfg) {
    localStorage.setItem("gamepadConfig", JSON.stringify(cfg));
  } else {
    localStorage.removeItem("gamepadConfig");
  }
  if (browser) {
    browser.gamepad.gamepadConfig = cfg || undefined;
    syncGamepadPlayer();
  }
}

function connectedPad() {
  if (!navigator.getGamepads) return null;
  for (const p of navigator.getGamepads()) if (p) return p;
  return null;
}

/*
 * jsnes disables keyboard input for a player whose id appears in
 * playerGamepadId — even if that pad is unplugged. Keep the runtime value in
 * sync with what's actually connected so the keyboard always works when no
 * pad is present. (The persisted config keeps the id.)
 */
function syncGamepadPlayer() {
  if (!browser || !browser.gamepad.gamepadConfig) return;
  const cfg = browser.gamepad.gamepadConfig;
  const pad = connectedPad();
  cfg.playerGamepadId = [pad && cfg.configs[pad.id] ? pad.id : null, null];
}

// Standard-mapping preset (https://w3c.github.io/gamepad/#remapping):
// south=A, west=B, east/north=turbo, back=Select, start=Start,
// d-pad buttons 12-15 plus left stick on axes 0/1.
function standardGamepadButtons() {
  const C = jsnes.Controller;
  return [
    { type: "button", code: 0, buttonId: C.BUTTON_A },
    { type: "button", code: 2, buttonId: C.BUTTON_B },
    { type: "button", code: 1, buttonId: C.BUTTON_TURBO_A },
    { type: "button", code: 3, buttonId: C.BUTTON_TURBO_B },
    { type: "button", code: 8, buttonId: C.BUTTON_SELECT },
    { type: "button", code: 9, buttonId: C.BUTTON_START },
    { type: "button", code: 12, buttonId: C.BUTTON_UP },
    { type: "button", code: 13, buttonId: C.BUTTON_DOWN },
    { type: "button", code: 14, buttonId: C.BUTTON_LEFT },
    { type: "button", code: 15, buttonId: C.BUTTON_RIGHT },
    { type: "axis", code: 0, value: -1, buttonId: C.BUTTON_LEFT },
    { type: "axis", code: 0, value: 1, buttonId: C.BUTTON_RIGHT },
    { type: "axis", code: 1, value: -1, buttonId: C.BUTTON_UP },
    { type: "axis", code: 1, value: 1, buttonId: C.BUTTON_DOWN },
  ];
}

function describePadBinding(b) {
  return b.type === "axis" ? `Axis${b.code}${b.value > 0 ? "+" : "−"}` : `B${b.code}`;
}

let padCapture = null; // { btn, original } while waiting for a pad press

function renderGamepadUI() {
  const box = document.getElementById("gamepad-ui");
  box.innerHTML = "";
  const pad = connectedPad();
  const note = document.createElement("p");
  note.className = "note";

  if (!pad) {
    note.textContent = "No gamepad detected — connect one and press any button on it.";
    box.append(note);
    return;
  }

  const name = document.createElement("p");
  name.className = "note";
  name.textContent = `Connected: ${pad.id}`;
  box.append(name);

  const cfg = loadGamepadConfig();
  const padCfg = cfg && cfg.configs && cfg.configs[pad.id];

  const table = document.createElement("table");
  const C = jsnes.Controller;
  for (const action of BINDABLE_ACTIONS) {
    const bound = padCfg
      ? padCfg.buttons.filter((b) => b.buttonId === C[action.button]).map(describePadBinding)
      : [];
    const row = document.createElement("tr");
    const keyCell = document.createElement("td");
    keyCell.className = "key";
    const btn = document.createElement("button");
    btn.className = "keybind";
    btn.textContent = bound.length ? bound.join(" / ") : "unbound";
    btn.title = "Click, then press a button or move a stick on the pad. Esc cancels.";
    btn.addEventListener("click", () => startPadCapture(action, btn));
    keyCell.appendChild(btn);
    const labelCell = document.createElement("td");
    labelCell.textContent = action.label;
    row.append(keyCell, labelCell);
    table.appendChild(row);
  }
  box.append(table);

  const autoBtn = document.createElement("button");
  autoBtn.textContent = "Auto-map standard layout";
  autoBtn.addEventListener("click", () => {
    saveGamepadConfig({
      playerGamepadId: [pad.id, null],
      configs: { ...(cfg ? cfg.configs : {}), [pad.id]: { buttons: standardGamepadButtons() } },
    });
    renderGamepadUI();
  });
  const clearBtn = document.createElement("button");
  clearBtn.className = "ghost";
  clearBtn.textContent = "Clear gamepad config";
  clearBtn.addEventListener("click", () => {
    saveGamepadConfig(null);
    renderGamepadUI();
  });
  box.append(autoBtn, clearBtn);

  if (!running) {
    note.textContent = "Start the game to capture pad presses (auto-map works anytime).";
    box.append(note);
  }
}

function startPadCapture(action, btn) {
  if (!browser) return;
  cancelPadCapture();
  padCapture = { btn, original: btn.textContent };
  btn.textContent = "press pad…";
  btn.classList.add("capturing");
  btn.blur();

  const onEsc = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelPadCapture();
    }
  };
  padCapture.onEsc = onEsc;
  window.addEventListener("keydown", onEsc, true);

  browser.gamepad.promptButton((info) => {
    window.removeEventListener("keydown", onEsc, true);
    btn.classList.remove("capturing");
    padCapture = null;

    const C = jsnes.Controller;
    const cfg = loadGamepadConfig() || { playerGamepadId: [info.gamepadId, null], configs: {} };
    const padCfg = cfg.configs[info.gamepadId] || { buttons: [] };
    const entry = { type: info.type, code: info.code, buttonId: C[action.button] };
    if (info.type === "axis") entry.value = info.value;
    // drop old bindings for this action, and anything on the same input
    padCfg.buttons = padCfg.buttons.filter(
      (b) =>
        b.buttonId !== entry.buttonId &&
        !(b.type === entry.type && b.code === entry.code && (b.value || 0) === (entry.value || 0))
    );
    padCfg.buttons.push(entry);
    cfg.configs[info.gamepadId] = padCfg;
    cfg.playerGamepadId = [info.gamepadId, null];
    saveGamepadConfig(cfg);
    renderGamepadUI();
  });
}

function cancelPadCapture() {
  if (!padCapture) return;
  if (browser) browser.gamepad.promptButton(null);
  if (padCapture.onEsc) window.removeEventListener("keydown", padCapture.onEsc, true);
  padCapture.btn.textContent = padCapture.original;
  padCapture.btn.classList.remove("capturing");
  padCapture = null;
}

window.addEventListener("gamepadconnected", () => {
  syncGamepadPlayer();
  renderGamepadUI();
});
window.addEventListener("gamepaddisconnected", () => {
  syncGamepadPlayer();
  renderGamepadUI();
});

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
  renderBindingTable();
  renderGamepadUI();
  document.getElementById("reset-keys").addEventListener("click", () => {
    saveKeyMap(defaultKeys());
    renderBindingTable();
  });
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
