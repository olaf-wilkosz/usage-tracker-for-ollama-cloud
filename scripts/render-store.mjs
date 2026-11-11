// Renders the store screenshots and promo tiles (store/slides, store/promo) to PNG with a
// headless Chromium-based browser (Edge, Chrome or Brave - whichever is installed, or set
// BROWSER=path). The popup inside the slides is the real popup.html with sample data, served
// by scripts/preview-server.mjs.
//
//   node scripts/render-store.mjs
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { startServer } from './preview-server.mjs';

const run = promisify(execFile); // async: the preview server lives in this process and must keep answering
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8766;

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const browser = CANDIDATES.find((path) => path && existsSync(path));
if (!browser) throw new Error('No Chromium-based browser found; set BROWSER=path');

// The store takes the PNGs (1280x800, 440x280, 1400x560). The website gets WebP copies, which are
// a fraction of the size: the slides at 1x and, for its enlarged view, at 2x, plus the bare popup.
//   [page under the preview server (or a /path), width, height, scale, png, webp]
// A job with no png is rendered into dist/render and only its WebP is kept.
const SLIDES = ['01-overview', '02-payg', '03-alerts', '04-models', '05-activity', '06-private'];
const JOBS = [
  ...SLIDES.flatMap((name) => [
    [`store/slides/${name}.html`, 1280, 800, 1, `store/screenshots/${name}.png`, `store/screenshots/web/${name}.webp`],
    [`store/slides/${name}.html`, 1280, 800, 2, null, `store/screenshots/web/hi/${name}.webp`]
  ]),
  ['store/promo/small-440x280.html', 440, 280, 1, 'store/promo/small-440x280.png', null],
  ['store/promo/marquee-1400x560.html', 1400, 560, 1, 'store/promo/marquee-1400x560.png', null],
  ['store/promo/og-1200x630.html', 1200, 630, 1, 'store/promo/og-1200x630.png', null],
  // the bare popup for the website hero, at 1x and 2x
  ['/popup?scenario=busy&pinned=1', 360, 574, 1, null, 'store/promo/popup-1x.webp'],
  ['/popup?scenario=busy&pinned=1', 360, 574, 2, null, 'store/promo/popup.webp']
];

const TMP = join(ROOT, 'dist', 'render');
mkdirSync(TMP, { recursive: true });

const server = await startServer(PORT);
try {
  let n = 0;
  for (const [page, width, height, scale, png, webp] of JOBS) {
    const target = png ? join(ROOT, png) : join(TMP, `${n++}.png`);
    mkdirSync(join(target, '..'), { recursive: true });
    await run(browser, [
      '--headless=new', '--lang=en-US', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`,
      '--virtual-time-budget=6000', `--window-size=${width},${height}`, `--screenshot=${target}`,
      page.startsWith('/') ? `http://localhost:${PORT}${page}` : `http://localhost:${PORT}/files/${page}`
    ], { timeout: 60000 });
    if (png) console.log(`${png} (${width}x${height})`);

    if (webp) {
      mkdirSync(join(ROOT, webp, '..'), { recursive: true });
      const info = await sharp(target).webp({ quality: 86, effort: 5, smartSubsample: true }).toFile(join(ROOT, webp));
      console.log(`${webp} (${info.width}x${info.height}, ${Math.round(info.size / 1024)} KB)`);
    }
  }
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
