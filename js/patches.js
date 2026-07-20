/*
 * Optional gameplay enhancements, ported from Daxanadu by David St-Louis
 * (https://github.com/Daivuk/Daxanadu, MIT license) — a Faxanadu-specific
 * NES emulator that patches the ROM at load time. Offsets are into the raw
 * .nes file (iNES header included, so PRG offset + 16) and were verified
 * against Faxanadu (USA) (Rev 1) a.k.a. PRG1.
 *
 * Every edit lists the bytes it expects to find. If the loaded ROM doesn't
 * match (different revision or region), that patch is skipped and reported —
 * we never write blind.
 */
"use strict";

const ROM_PATCHES = [
  {
    id: "dialog_speed",
    label: "Dialog speed",
    hint: "How fast NPC text types out.",
    kind: "choice",
    choices: [
      { value: "normal", label: "Normal (original)", bytes: [0x03] },
      { value: "fast", label: "Fast", bytes: [0x01] },
      { value: "instant", label: "Instant", bytes: [0x00] },
    ],
    default: "normal",
    edits: [{ offset: 0x3f4af, expect: [0x03] }],
  },
  {
    id: "keep_gold",
    label: "Keep gold on death",
    hint: "The original zeroes your gold when you die.",
    kind: "toggle",
    edits: [
      { offset: 0x315da, expect: [0x8d, 0x92, 0x03], on: [0xea, 0xea, 0xea] },
      { offset: 0x315e0, expect: [0x8d, 0x93, 0x03], on: [0xea, 0xea, 0xea] },
      { offset: 0x315e5, expect: [0x8d, 0x94, 0x03], on: [0xea, 0xea, 0xea] },
    ],
  },
  {
    id: "keep_xp",
    label: "Keep experience on death",
    hint: "The original zeroes your XP when you die.",
    kind: "toggle",
    edits: [
      { offset: 0x315ce, expect: [0x8d, 0x90, 0x03], on: [0xea, 0xea, 0xea] },
      { offset: 0x315d4, expect: [0x8d, 0x91, 0x03], on: [0xea, 0xea, 0xea] },
    ],
  },
  {
    id: "coins_stay",
    label: "Coins never despawn",
    hint: "Dropped coins normally vanish after a moment.",
    kind: "toggle",
    edits: [{ offset: 0x38d16, expect: [0x9d, 0xcc, 0x02], on: [0xea, 0xea, 0xea] }],
  },
  {
    id: "equip_in_shops",
    label: "Equip items inside shops",
    hint: "Removes the check that blocks equipping indoors.",
    kind: "toggle",
    edits: [{ offset: 0x30b96, expect: [0xc9, 0x04, 0xf0, 0x5b], on: [0xea, 0xea, 0xea, 0xea] }],
  },
  {
    id: "item_rooms_stocked",
    label: "Item rooms always stocked",
    hint: "Hidden item rooms ignore the shared world counter.",
    kind: "toggle",
    edits: [{ offset: 0x3a53c, expect: [0xad, 0x3a, 0x04], on: [0xa9, 0x04, 0xea] }],
  },
  {
    id: "wingboots_max",
    label: "Wingboots always last 40s",
    hint: "Duration normally shrinks with your title rank (40/30/20/10s).",
    kind: "toggle",
    edits: [{ offset: 0x3c5a9, expect: [0x28, 0x1e, 0x14, 0x0a], on: [0x28, 0x28, 0x28, 0x28] }],
  },
  {
    id: "speed_max",
    label: "Full walking speed at any rank",
    hint: "Walking speed normally scales with your title rank.",
    kind: "toggle",
    edits: [{ offset: 0x3e2d4, expect: [0x02, 0x04, 0x06, 0x08], on: [0x08, 0x08, 0x08, 0x08] }],
  },
  {
    id: "pendant_fix",
    label: "Fix the Pendant bug",
    hint: "The Pendant's attack boost is famously applied in reverse; this flips the check.",
    kind: "toggle",
    edits: [{ offset: 0x38889, expect: [0xd0], on: [0xf0] }],
  },
  {
    id: "full_health",
    label: "Start with full health",
    hint: "New games and continues normally start you at low HP.",
    kind: "toggle",
    edits: [{ offset: 0x3debf, expect: [0x10], on: [0x50] }],
  },
];

// Overlay feature (no ROM edit): show area names, ported from Daxanadu's
// RoomWatcher. Reads level id ($0024) and screen id ($0063) from CPU RAM.
const AREA_NAMES_OPTION = {
  id: "area_names",
  label: "Show area names",
  hint: "Briefly displays the region name when you enter a new area (overlay, not part of the game).",
};

function areaNameFor(levelId, screenId) {
  switch (levelId) {
    case 0:
      return screenId > 0 ? "EOLIS" : "";
    case 1:
      if (screenId <= 7) return "TRUNK";
      if ((screenId >= 8 && screenId <= 12) || (screenId >= 22 && screenId <= 26)) return "TRUNK";
      if (screenId >= 13 && screenId <= 21) return "TOWER OF TRUNK";
      if (screenId === 62 || screenId === 63) return "JOKER SPRING";
      if (screenId >= 28 && screenId <= 40) return "SKY SPRING";
      return "TOWER OF FORTRESS";
    case 2:
      if (screenId >= 77 && screenId <= 79) return "TOWER OF RED POTION";
      if (screenId >= 48 && screenId <= 62) return "TOWER OF SUFFER";
      if (screenId >= 80 && screenId <= 82) return "USELESS TOWER";
      if (screenId >= 63 && screenId <= 76) return "TOWER OF MIST";
      return "MIST";
    case 3:
      return ["APOLUNE", "APOLUNE", "FOREPAW", "FOREPAW", "MASCON", "MASCON",
              "VICTIM", "VICTIM", "CONFLATE", "CONFLATE", "DAYBREAK", "DAYBREAK",
              "DARTMOOR", "DARTMOOR"][screenId] || "";
    case 4:
      return ""; // shops — keep the previous name
    case 5:
      return "BRANCHES";
    case 6:
      return screenId >= 16 ? "FRATERNAL CASTLE" : "DARTMOOR CASTLE";
    case 7:
      return "EVIL FORTRESS";
    default:
      return "";
  }
}

/*
 * Apply enabled patches to a copy of the pristine ROM bytes.
 * Returns { bytes, applied, skipped } — skipped entries mean the ROM
 * didn't contain the expected original bytes (wrong revision).
 */
function applyRomPatches(pristine, settings) {
  const bytes = new Uint8Array(pristine); // copy
  const applied = [];
  const skipped = [];

  for (const patch of ROM_PATCHES) {
    const value = settings[patch.id];
    let replacements = null;

    if (patch.kind === "toggle") {
      if (value !== true) continue;
      replacements = patch.edits.map((e) => e.on);
    } else if (patch.kind === "choice") {
      const choice = patch.choices.find((c) => c.value === value);
      if (!choice || value === patch.default) continue;
      replacements = [choice.bytes];
    }

    const verified = patch.edits.every((e, i) =>
      e.expect.every((b, j) => pristine[e.offset + j] === b) &&
      replacements[i].length === e.expect.length
    );
    if (!verified) {
      skipped.push(patch.id);
      continue;
    }
    patch.edits.forEach((e, i) => bytes.set(replacements[i], e.offset));
    applied.push(patch.id);
  }

  return { bytes, applied, skipped };
}

/* Check which patches are compatible with a given pristine ROM. */
function patchCompatibility(pristine) {
  const compat = {};
  for (const patch of ROM_PATCHES) {
    compat[patch.id] = patch.edits.every((e) =>
      e.expect.every((b, j) => pristine[e.offset + j] === b)
    );
  }
  return compat;
}
