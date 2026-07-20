/*
 * HD pack builder: play the game with recording on, and every unique
 * (tile bytes, palette) combination that appears on screen is collected.
 * Export produces a template pack — an atlas PNG (tiles upscaled 4x with
 * Scale2x applied twice, so the template is already smoother than raw
 * pixels) and the matching hires.txt. Paint over the PNG in any editor,
 * reload the pack, and your art shows up in-game. Tiles never seen while
 * recording aren't in the template; record more, export again, and merge.
 */
"use strict";

const BUILDER_SCALE = 4;
const ATLAS_TILES_PER_ROW = 16;

class HdPackBuilder {
  constructor() {
    this.recording = false;
    this.seen = new Map(); // "tileHex_palHex" -> {tileHex, palHex, sprite}
  }

  start() {
    this.recording = true;
    HD.onFrameCaptured = () => this._harvest();
  }

  stop() {
    this.recording = false;
    HD.onFrameCaptured = null;
  }

  reset() {
    this.seen.clear();
  }

  get count() {
    return this.seen.size;
  }

  _harvest() {
    for (const r of HD.ready) {
      const tileHex = HD._chrHex(r.tileNum);
      const palHex = HD._bgPaletteHex(r.att);
      const key = tileHex + "_" + palHex;
      if (!this.seen.has(key)) this.seen.set(key, { tileHex, palHex, sprite: false });
    }
    for (const s of HD.readySprites) {
      const palHex = HD._spPaletteHex(s.pal);
      for (const t of s.tiles) {
        const tileHex = HD._chrHex(t);
        const key = tileHex + "_" + palHex;
        if (!this.seen.has(key)) this.seen.set(key, { tileHex, palHex, sprite: true });
      }
    }
  }

  /* Decode a 32-hex CHR tile + palette into an 8x8 array of RGBA ints (0 = transparent). */
  _decode(tileHex, palHex) {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(tileHex.substr(i * 2, 2), 16);
    const colors = [0, 0, 0, 0]; // 0 stays transparent
    for (let i = 1; i < 4; i++) {
      const nes = parseInt(palHex.substr(i * 2, 2), 16);
      colors[i] = isNaN(nes) ? 0 : (0xff000000 | NES_PALETTE[nes & 0x3f]) >>> 0;
    }
    const out = new Uint32Array(64);
    for (let y = 0; y < 8; y++) {
      const lo = bytes[y], hi = bytes[y + 8];
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x;
        out[y * 8 + x] = colors[((lo >> bit) & 1) | (((hi >> bit) & 1) << 1)];
      }
    }
    return out;
  }

  /* One Scale2x pass: w×h Uint32Array -> 2w×2h. */
  _scale2x(src, w, h) {
    const dw = w * 2;
    const out = new Uint32Array(dw * h * 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const P = src[y * w + x];
        const A = y > 0 ? src[(y - 1) * w + x] : P;
        const B = x < w - 1 ? src[y * w + x + 1] : P;
        const C = x > 0 ? src[y * w + x - 1] : P;
        const D = y < h - 1 ? src[(y + 1) * w + x] : P;
        let e0 = P, e1 = P, e2 = P, e3 = P;
        if (C === A && C !== D && A !== B) e0 = A;
        if (A === B && A !== C && B !== D) e1 = B;
        if (D === C && D !== B && C !== A) e2 = C;
        if (B === D && B !== A && D !== C) e3 = D;
        const o = (y * 2) * dw + x * 2;
        out[o] = e0;
        out[o + 1] = e1;
        out[o + dw] = e2;
        out[o + dw + 1] = e3;
      }
    }
    return out;
  }

  /* Build the atlas canvas + hires.txt text. */
  build(imageName) {
    const entries = Array.from(this.seen.values());
    // stable order: sprites first (the art people care most about), then BG
    entries.sort((a, b) => (a.sprite === b.sprite ? 0 : a.sprite ? -1 : 1));

    const S = BUILDER_SCALE;
    const tilePx = 8 * S;
    const cols = ATLAS_TILES_PER_ROW;
    const rows = Math.max(1, Math.ceil(entries.length / cols));
    const canvas = document.createElement("canvas");
    canvas.width = cols * tilePx;
    canvas.height = rows * tilePx;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(canvas.width, canvas.height);
    const px = new Uint32Array(img.data.buffer);

    const lines = [
      "<ver>105",
      `<scale>${S}`,
      `<img>${imageName}`,
    ];

    entries.forEach((e, i) => {
      const x = (i % cols) * tilePx;
      const y = Math.floor(i / cols) * tilePx;
      // 8x8 -> 16x16 -> 32x32 (Scale2x twice = clean 4x template)
      const up = this._scale2x(this._scale2x(this._decode(e.tileHex, e.palHex), 8, 8), 16, 16);
      for (let ty = 0; ty < tilePx; ty++) {
        const src = ty * tilePx;
        const dst = (y + ty) * canvas.width + x;
        for (let tx = 0; tx < tilePx; tx++) px[dst + tx] = up[src + tx];
      }
      lines.push(`<tile>0,${e.tileHex},${e.palHex},${x},${y},1,N`);
    });

    ctx.putImageData(img, 0, 0);
    return { canvas, hiresText: lines.join("\n") + "\n", count: entries.length };
  }

  async export() {
    const imageName = "faxanadu-hd.png";
    const { canvas, hiresText, count } = this.build(imageName);
    const pngBlob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    download(pngBlob, imageName);
    download(new Blob([hiresText], { type: "text/plain" }), "hires.txt");
    return count;
  }
}

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const HD_BUILDER = new HdPackBuilder();
