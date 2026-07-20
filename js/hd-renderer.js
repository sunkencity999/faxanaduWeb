/*
 * HD tile-replacement renderer.
 *
 * Instead of forking jsnes, we instrument its PPU from the outside:
 *
 *  - PPU.prototype.renderBgScanline is wrapped to record, per scanline,
 *    which tile (pattern address + palette attribute) was drawn at which
 *    screen position — replicating the same nametable/scroll-counter walk
 *    the original performs, without mutating PPU state. Because capture
 *    happens per scanline, mid-frame scroll splits (Faxanadu's status bar)
 *    are reproduced exactly.
 *  - Screen.setBuffer (called once per emulated frame) finalizes the
 *    captured frame; Screen.writeBuffer (called once per display frame)
 *    triggers composition.
 *
 * Composition draws the whole frame at <scale>x on a separate canvas:
 * backdrop color, behind-background sprites, background tiles (color 0
 * transparent), then front sprites — each tile drawn from the HD pack when
 * its CHR-bytes+palette key matches, otherwise rasterized from CHR data
 * (pixel-perfect native fallback), so a pack can grow tile by tile.
 */
"use strict";

// Standard NTSC NES palette (FCEUX/Nestopia-style), used for fallback tiles.
// Internal consistency is what matters: when HD mode is on, every tile goes
// through this renderer, so colors stay uniform across HD and fallback.
const NES_PALETTE = [
  0x666666, 0x002a88, 0x1412a7, 0x3b00a4, 0x5c007e, 0x6e0040, 0x6c0600, 0x561d00,
  0x333500, 0x0b4800, 0x005200, 0x004f08, 0x00404d, 0x000000, 0x000000, 0x000000,
  0xadadad, 0x155fd9, 0x4240ff, 0x7527fe, 0xa01acc, 0xb71e7b, 0xb53120, 0x994e00,
  0x6b6d00, 0x388700, 0x0c9300, 0x008f32, 0x007c8d, 0x000000, 0x000000, 0x000000,
  0xfffeff, 0x64b0ff, 0x9290ff, 0xc676ff, 0xf36aff, 0xfe6ecc, 0xfe8170, 0xea9e22,
  0xbcbe00, 0x88d800, 0x5ce430, 0x45e082, 0x48cdde, 0x4f4f4f, 0x000000, 0x000000,
  0xfffeff, 0xc0dfff, 0xd3d2ff, 0xe8c8ff, 0xfbc2ff, 0xfec4ea, 0xfeccc5, 0xf7d8a5,
  0xe4e594, 0xcfef96, 0xbdf4ab, 0xb3f3cc, 0xb5ebf2, 0xb8b8b8, 0x000000, 0x000000,
];

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase());

class HdRenderer {
  constructor() {
    this.pack = null;          // HdPack or null
    this.enabled = false;
    this.nes = null;
    this.canvas = null;
    this.ctx = null;
    this.scale = 1;

    // Per-frame capture. "building" fills during emulation; "ready" is the
    // last finalized frame, consumed by compose().
    this.building = new Map(); // intKey -> record
    this.ready = [];
    this.readySprites = [];
    this.readyPalette = new Uint8Array(32);
    this.readyBackdrop = 0;

    this.chrHexMemo = new Map(); // tileNum -> hex, cleared per frame
    this.fallbackCache = new Map(); // key -> canvas (LRU-ish, capped)
    this.onFrameCaptured = null; // hook for the pack builder

    this._installed = false;
    this._screenPatched = null;
  }

  // ---- lifecycle -----------------------------------------------------------

  attach(browser, screenEl) {
    this.nes = browser.nes;
    this._patchPPU(this.nes.ppu);
    this._patchFrameHooks(browser);
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.id = "hd-canvas";
      screenEl.appendChild(this.canvas);
    } else if (!screenEl.contains(this.canvas)) {
      screenEl.appendChild(this.canvas);
    }
    this._applyScale();
    this.syncSize();
  }

  detach() {
    this.nes = null;
    this._screenPatched = null;
    if (this.canvas) this.canvas.remove();
    this.canvas = null;
    this.ctx = null;
    this.building.clear();
    this.ready = [];
    this.readySprites = [];
  }

  setPack(pack) {
    this.pack = pack;
    this.fallbackCache.clear();
    this._applyScale();
  }

  setEnabled(on) {
    this.enabled = on;
    this._updateVisibility();
  }

  get active() {
    return this.enabled && !!this.nes && !!this.canvas;
  }

  _applyScale() {
    this.scale = this.pack ? this.pack.scale : 2;
    if (this.canvas) {
      this.canvas.width = 256 * this.scale;
      this.canvas.height = 240 * this.scale;
      this.ctx = this.canvas.getContext("2d");
      this.ctx.imageSmoothingEnabled = false;
      this.fallbackCache.clear();
    }
  }

  _updateVisibility() {
    if (!this.canvas) return;
    this.canvas.style.display = this.active ? "block" : "none";
    const native = this.canvas.parentElement &&
      this.canvas.parentElement.querySelector("canvas:not(#hd-canvas)");
    if (native) native.style.visibility = this.active ? "hidden" : "visible";
  }

  syncSize() {
    if (!this.canvas) return;
    const native = this.canvas.parentElement &&
      this.canvas.parentElement.querySelector("canvas:not(#hd-canvas)");
    if (native) {
      this.canvas.style.width = native.style.width;
      this.canvas.style.height = native.style.height;
    }
    this._updateVisibility();
  }

  // ---- PPU instrumentation --------------------------------------------------

  _patchPPU(ppu) {
    const proto = Object.getPrototypeOf(ppu);
    if (proto.__hdPatched) return;
    proto.__hdPatched = true;
    const self = HD; // singleton
    const origBg = proto.renderBgScanline;
    proto.renderBgScanline = function (bgbuffer, scan) {
      // Capture the real per-scanline pass (bgbuffer=true, later copied to
      // the display buffer). The bgbuffer=false call is a pre-render dummy.
      if (bgbuffer && self.active && this === (self.nes && self.nes.ppu)) {
        self._captureBgScanline(this, scan);
      }
      return origBg.call(this, bgbuffer, scan);
    };
  }

  /*
   * The Browser wires callbacks by reference at construction (NES calls
   * nes.ui.writeFrame once per emulated frame; the FrameTimer calls
   * onWriteFrame once per displayed frame), so we wrap those live
   * references — reassigning Screen's methods after the fact would be a
   * no-op.
   */
  _patchFrameHooks(browser) {
    if (this._screenPatched === browser) return;
    this._screenPatched = browser;
    const self = this;
    const origWriteFrame = browser.nes.ui.writeFrame;
    browser.nes.ui.writeFrame = function (buffer) {
      if (self.active) self._finalizeFrame();
      return origWriteFrame(buffer);
    };
    const origOnWrite = browser._frameTimer.onWriteFrame;
    browser._frameTimer.onWriteFrame = function () {
      if (self.active) self._compose();
      return origOnWrite();
    };
  }

  /*
   * Replicates renderBgScanline's counter walk read-only. Records one entry
   * per visible tile sliver, coalesced by (x, yTop, tile, attr) so a full
   * 8x8 tile drawn over 8 scanlines becomes a single record.
   */
  _captureBgScanline(ppu, scan) {
    if (scan >= 240 || scan - ppu.cntFV < 0 || ppu.f_bgVisibility !== 1) return;
    const baseTile = ppu.regS === 0 ? 0 : 256;
    const fineY = ppu.cntFV;
    const yTop = scan - fineY;
    const regFH = ppu.regFH;
    let cntHT = ppu.regHT;
    let cntH = ppu.regH;
    const cntVT = ppu.cntVT;
    const cntV = ppu.cntV;
    let curNt = ppu.ntable1[(cntV << 1) + cntH];
    const nameTable = ppu.nameTable;
    const building = this.building;

    for (let tile = 0; tile < 32; tile++) {
      const nt = nameTable[curNt];
      const tileIndex = nt.getTileIndex(cntHT, cntVT);
      const att = nt.getAttrib(cntHT, cntVT);
      const x = (tile << 3) - regFH;
      if (x > -8) {
        const tileNum = baseTile + tileIndex;
        // key: x(+8:9b) | yTop(+8:9b) | tileNum(9b) | attGroup(2b)
        const key = (((x + 8) << 20) | ((yTop + 8) << 11) | (tileNum << 2) | (att >> 2)) >>> 0;
        if (!building.has(key)) building.set(key, { x, y: yTop, tileNum, att });
      }
      if (++cntHT === 32) {
        cntHT = 0;
        cntH = (cntH + 1) % 2;
        curNt = ppu.ntable1[(cntV << 1) + cntH];
      }
    }
  }

  _finalizeFrame() {
    const ppu = this.nes.ppu;
    this.ready = Array.from(this.building.values());
    this.building.clear();
    this.chrHexMemo.clear();

    // Snapshot palette RAM ($3F00-$3F1F) and backdrop
    for (let i = 0; i < 32; i++) this.readyPalette[i] = ppu.vramMem[0x3f00 + i] & 0x3f;
    this.readyBackdrop = NES_PALETTE[this.readyPalette[0]];

    // Snapshot sprites from OAM
    const sprites = [];
    if (ppu.f_spVisibility === 1) {
      const oam = ppu.spriteMem;
      const tall = ppu.f_spriteSize === 1;
      for (let i = 63; i >= 0; i--) { // low index drawn last = on top
        const sy = oam[i * 4];
        if (sy >= 0xef) continue;
        const tileByte = oam[i * 4 + 1];
        const attr = oam[i * 4 + 2];
        const sx = oam[i * 4 + 3];
        const entry = {
          x: sx, y: sy + 1,
          pal: attr & 3,
          behind: (attr & 0x20) !== 0,
          hflip: (attr & 0x40) !== 0,
          vflip: (attr & 0x80) !== 0,
          tiles: [],
        };
        if (tall) {
          const base = (tileByte & 1) * 256;
          const top = base + (tileByte & 0xfe);
          entry.tiles = entry.vflip ? [top + 1, top] : [top, top + 1];
        } else {
          entry.tiles = [ppu.f_spPatternTable * 256 + tileByte];
        }
        sprites.push(entry);
      }
    }
    this.readySprites = sprites;

    if (this.onFrameCaptured) this.onFrameCaptured();
  }

  // ---- composition ----------------------------------------------------------

  _chrHex(tileNum) {
    let hex = this.chrHexMemo.get(tileNum);
    if (hex === undefined) {
      const v = this.nes.ppu.vramMem;
      const a = tileNum << 4;
      hex = "";
      for (let i = 0; i < 16; i++) hex += HEX[v[a + i]];
      this.chrHexMemo.set(tileNum, hex);
    }
    return hex;
  }

  _bgPaletteHex(att) {
    const p = this.readyPalette;
    return HEX[p[0]] + HEX[p[att + 1]] + HEX[p[att + 2]] + HEX[p[att + 3]];
  }

  _spPaletteHex(palGroup) {
    const p = this.readyPalette;
    const b = 16 + palGroup * 4;
    return "FF" + HEX[p[b + 1]] + HEX[p[b + 2]] + HEX[p[b + 3]];
  }

  /* Rasterize one native tile at scale into a cached canvas. */
  _fallbackTile(tileHex, paletteHex) {
    const key = tileHex + "_" + paletteHex;
    let c = this.fallbackCache.get(key);
    if (c) return c;
    const S = this.scale;
    c = document.createElement("canvas");
    c.width = 8 * S;
    c.height = 8 * S;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(8 * S, 8 * S);
    const d = img.data;
    // decode 16 bytes (2 planes) from hex
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(tileHex.substr(i * 2, 2), 16);
    const colors = [0, 0, 0, 0];
    for (let i = 1; i < 4; i++) {
      colors[i] = NES_PALETTE[parseInt(paletteHex.substr(i * 2, 2), 16) & 0x3f];
    }
    for (let py = 0; py < 8; py++) {
      const lo = bytes[py], hi = bytes[py + 8];
      for (let px = 0; px < 8; px++) {
        const bit = 7 - px;
        const col = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (col === 0) continue; // transparent
        const rgb = colors[col];
        for (let sy = 0; sy < S; sy++) {
          let o = (((py * S + sy) * 8 * S) + px * S) * 4;
          for (let sx = 0; sx < S; sx++) {
            d[o] = (rgb >> 16) & 0xff;
            d[o + 1] = (rgb >> 8) & 0xff;
            d[o + 2] = rgb & 0xff;
            d[o + 3] = 255;
            o += 4;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    if (this.fallbackCache.size > 4000) this.fallbackCache.clear();
    this.fallbackCache.set(key, c);
    return c;
  }

  _drawTile(tileHex, paletteHex, x, y, hflip, vflip) {
    const S = this.scale;
    const ctx = this.ctx;
    const rule = this.pack ? this.pack.lookup(tileHex, paletteHex) : null;
    const flip = hflip || vflip;
    if (flip) {
      ctx.save();
      ctx.translate(x * S + (hflip ? 8 * S : 0), y * S + (vflip ? 8 * S : 0));
      ctx.scale(hflip ? -1 : 1, vflip ? -1 : 1);
    }
    const dx = flip ? 0 : x * S;
    const dy = flip ? 0 : y * S;
    if (rule) {
      const img = this.pack.images[rule.img];
      if (rule.brightness !== 1) ctx.filter = `brightness(${rule.brightness})`;
      ctx.drawImage(img, rule.x, rule.y, 8 * S, 8 * S, dx, dy, 8 * S, 8 * S);
      if (rule.brightness !== 1) ctx.filter = "none";
    } else {
      ctx.drawImage(this._fallbackTile(tileHex, paletteHex), dx, dy);
    }
    if (flip) ctx.restore();
  }

  _drawSprites(behind) {
    for (const s of this.readySprites) {
      if (s.behind !== behind) continue;
      const palHex = this._spPaletteHex(s.pal);
      for (let i = 0; i < s.tiles.length; i++) {
        this._drawTile(this._chrHex(s.tiles[i]), palHex, s.x, s.y + i * 8, s.hflip, s.vflip);
      }
    }
  }

  _compose() {
    const ctx = this.ctx;
    if (!ctx) return;
    const S = this.scale;
    ctx.fillStyle = "#" + this.readyBackdrop.toString(16).padStart(6, "0");
    ctx.fillRect(0, 0, 256 * S, 240 * S);
    this._drawSprites(true); // behind-background sprites
    for (const r of this.ready) {
      this._drawTile(this._chrHex(r.tileNum), this._bgPaletteHex(r.att), r.x, r.y, false, false);
    }
    this._drawSprites(false); // foreground sprites
  }
}

const HD = new HdRenderer();
