/*
 * Mesen HD pack (hires.txt) support — subset.
 *
 * Supported: <ver>, <scale>, <img>, <tile> (CHR-RAM 32-hex form, palette
 * matching, default tiles, brightness). Unsupported and skipped with a
 * console warning: <condition>-prefixed rules, <background>, <bgm>, <sfx>,
 * and CHR-ROM integer tile indexes (Faxanadu is a CHR-RAM game).
 *
 * Format reference: https://www.mesen.ca/docs/hdpacks.html (v105)
 */
"use strict";

class HdPack {
  constructor() {
    this.scale = 1;
    this.version = 105;
    this.imageNames = [];
    this.images = []; // ImageBitmap per <img>, same order
    // exact match: "tileHex_paletteHex" -> rule; default: tileHex -> rule
    this.tiles = new Map();
    this.defaults = new Map();
    this.unsupported = 0;
  }

  static parse(text) {
    const pack = new HdPack();
    for (let rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:\[[^\]]*\])?<(\w+)>(.*)$/);
      if (!m) continue;
      const [, tag, body] = m;
      const conditional = line.startsWith("[");

      switch (tag) {
        case "ver":
          pack.version = parseInt(body, 10) || 105;
          break;
        case "scale":
          pack.scale = Math.max(1, Math.min(8, parseInt(body, 10) || 1));
          break;
        case "img":
          pack.imageNames.push(body.trim());
          break;
        case "tile": {
          if (conditional) { pack.unsupported++; continue; }
          const f = body.split(",").map((s) => s.trim());
          if (f.length < 5) continue;
          const [imgIndex, tileData, paletteData, x, y] = f;
          if (!/^[0-9a-fA-F]{32}$/.test(tileData)) {
            pack.unsupported++; // CHR-ROM index form — not used by Faxanadu
            continue;
          }
          const rule = {
            img: parseInt(imgIndex, 10) || 0,
            x: parseInt(x, 10) || 0,
            y: parseInt(y, 10) || 0,
            brightness: f[5] !== undefined ? parseFloat(f[5]) : 1,
          };
          const tileHex = tileData.toUpperCase();
          const isDefault = (f[6] || "N").toUpperCase() === "Y";
          if (isDefault) {
            pack.defaults.set(tileHex, rule);
          } else {
            pack.tiles.set(tileHex + "_" + paletteData.toUpperCase(), rule);
          }
          break;
        }
        case "background":
        case "condition":
        case "bgm":
        case "sfx":
        case "overscan":
        case "options":
          pack.unsupported++;
          break;
      }
    }
    if (pack.unsupported > 0) {
      console.warn(
        `HD pack: ${pack.unsupported} entries use unsupported features ` +
        `(conditions/backgrounds/audio/CHR-ROM) and were skipped.`
      );
    }
    return pack;
  }

  /* files: Map of lowercased filename -> Blob/ArrayBuffer for the PNGs. */
  async loadImages(files) {
    this.images = await Promise.all(
      this.imageNames.map(async (name) => {
        const data = files.get(name.toLowerCase());
        if (!data) throw new Error(`HD pack references missing image "${name}"`);
        const blob = data instanceof Blob ? data : new Blob([data], { type: "image/png" });
        return createImageBitmap(blob);
      })
    );
  }

  lookup(tileHex, paletteHex) {
    return this.tiles.get(tileHex + "_" + paletteHex) || this.defaults.get(tileHex) || null;
  }

  get ruleCount() {
    return this.tiles.size + this.defaults.size;
  }
}

// ---------------------------------------------------------------------------
// Persistence: keep the raw pack files in IndexedDB so it survives reloads.
// ---------------------------------------------------------------------------

async function idbPutHdPack(entry) {
  return idbPut("hdpack", "pack", entry);
}

async function idbGetHdPack() {
  return idbGet("hdpack", "pack").catch(() => null);
}

async function idbDeleteHdPack() {
  return idbDelete("hdpack", "pack").catch(() => {});
}

/*
 * Build an HdPack from user-supplied files (hires.txt + PNGs).
 * `fileList` is an array of File objects or {name, data:ArrayBuffer}.
 */
async function buildHdPackFromFiles(fileList) {
  let hiresText = null;
  const pngs = new Map();
  for (const f of fileList) {
    const name = (f.name || "").split("/").pop().toLowerCase();
    if (name === "hires.txt") {
      const data = f.data || (await f.arrayBuffer());
      hiresText = new TextDecoder().decode(data);
    } else if (name.endsWith(".png")) {
      pngs.set(name, f.data ? new Blob([f.data], { type: "image/png" }) : f);
    }
  }
  if (!hiresText) throw new Error("No hires.txt found in the selected files.");
  const pack = HdPack.parse(hiresText);
  await pack.loadImages(pngs);
  return pack;
}
