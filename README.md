# Faxanadu — Web Preservation Player

A browser-based player for **Faxanadu** (NES, Hudson Soft / Nihon Falcom, 1987).
Pure static HTML/CSS/JS with a vendored copy of the MIT-licensed
[jsnes](https://github.com/bfirsh/jsnes) emulator — no build step, no CDN, no
server-side code. Once the page has loaded it works entirely offline, so it
will keep running for as long as browsers can open an HTML file.

## Legal status (read this before publishing)

Faxanadu is **not** in the public domain. It is a 1987 work whose rights are
held by Konami (successor to Hudson Soft) and Nihon Falcom; under US law it
remains copyrighted until roughly 2083. What *is* legal:

- **This player.** Emulators are lawful (*Sony v. Connectix*, 2000), and this
  repository contains no game data.
- **Playing your own dump.** Load a ROM dumped from a cartridge you own. The
  file is cached in your browser's IndexedDB and never leaves your device.

What is **not** legal: bundling or hosting the ROM with the published site.
The `.gitignore` blocks `*.nes` files to prevent accidental publication.

## Running it

Any static file server works:

```sh
python3 -m http.server 8080
# or: npx serve .
```

Open http://localhost:8080, then drag your `.nes` file onto the screen
(one time only — it's remembered by the browser).

## Hosting

There is no build step and no server-side code, so the site runs on
**any host that can serve files**:

- **GitHub Pages** — live at https://sunkencity999.github.io/faxanaduWeb/
  (Settings → Pages → deploy from `main`, root).
- **SiteGround / cPanel-style shared hosting** — upload the repository
  contents (everything except `node_modules/` and your ROM) to
  `public_html/` via Site Tools File Manager or FTP. Done.
- **Netlify / Cloudflare Pages / S3 / nginx** — point it at the folder.

Two requirements, both satisfied by default on modern hosts:

1. **HTTPS** — browsers require a secure context for the AudioWorklet
   sound pipeline (localhost is exempt). SiteGround issues free
   Let's Encrypt certificates; turn SSL on.
2. Correct MIME type for `.js` files (every mainstream host does this).

And one rule: **never upload a `.nes` file to the public site.** The
player is legal precisely because game data stays on each player's own
device.

**Local convenience:** put your ROM at `rom/faxanadu.nes` (gitignored) and the
player picks it up automatically when served locally.

## Features

- Pixel-perfect scaled 256×240 canvas, fullscreen mode
- Sound via AudioWorklet (jsnes 2.x)
- Keyboard controls (X = A, Z = B, Enter = Start, Right Ctrl = Select, arrows = D-pad)
  and automatic USB/Bluetooth gamepad support
- Three save-state slots stored in IndexedDB (F5 save / F8 load) — plus the
  game's own mantra password system
- Pause (P), reset, screenshot download, cartridge eject
- **Optional enhancements** ported from [Daxanadu](https://github.com/Daivuk/Daxanadu)
  by David St-Louis (MIT): keep gold/XP on death, dialog speed, the Pendant
  bug fix, full starting health, rank-independent wingboots/walk speed, and
  an area-name overlay. All **off by default** — the authentic game is the
  default experience. Every ROM patch verifies the original bytes at the
  patch site first (validated against USA Rev 1 / PRG1) and is skipped
  safely on other revisions.
- **HD graphics** — a from-scratch HD tile-replacement renderer
  (`js/hd-renderer.js`). It instruments jsnes's PPU per scanline (so
  mid-frame scroll splits like the status bar render correctly) and
  re-composites every frame at up to 4× on a separate canvas: tiles with
  replacements draw from the pack's PNG atlases, everything else falls back
  to pixel-perfect native rendering, so partial packs work. Compose cost is
  ~0.5 ms/frame. Loads packs in Mesen's
  [`hires.txt` format](https://www.mesen.ca/docs/hdpacks.html) (static
  CHR-RAM tile rules + palettes; conditions/backgrounds/audio not yet
  supported), and the pack persists in IndexedDB like the ROM.

## Making an HD pack

The player doubles as pack-authoring tooling — no external programs needed:

1. Enable **HD renderer** and **Record tiles while playing**, then play
   through the areas you want to cover (466 unique tiles show up in the
   first minute alone).
2. **Export template pack** — downloads `faxanadu-hd.png` (every recorded
   tile at 4×, pre-smoothed with Scale2x so the template is already nicer
   than raw pixels) and a matching `hires.txt`.
3. Paint over the PNG in any editor (keep tiles in their 32×32 cells,
   alpha = transparency), then **Load HD pack…** with both files.
4. Repeat: record more areas, export again, merge your art in.

Because the format is standard Mesen `hires.txt`, packs authored here also
work in desktop Mesen, and Mesen packs (their static-tile subset) load here.

## Updating the emulator

```sh
npm install jsnes@latest
cp node_modules/jsnes/dist/jsnes.min.js vendor/
```

`vendor/jsnes.min.js` is committed so the site works without npm.
