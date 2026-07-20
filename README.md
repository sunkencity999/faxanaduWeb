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

## Updating the emulator

```sh
npm install jsnes@latest
cp node_modules/jsnes/dist/jsnes.min.js vendor/
```

`vendor/jsnes.min.js` is committed so the site works without npm.
