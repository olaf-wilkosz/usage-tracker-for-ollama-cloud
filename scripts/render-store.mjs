// Renders the store screenshots and promo tiles (store/slides, store/promo) to PNG with a
// headless Chromium-based browser (Edge, Chrome or Brave - whichever is installed, or set
// BROWSER=path). The popup inside the slides is the real popup.html with sample data, served
// by scripts/preview-server.mjs.
//
//   node scripts/render-store.mjs
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

// [page under the preview server (or a /path), output file (relative to the repo), width, height, scale]
const JOBS = [
  ['store/slides/01-overview.html', 'store/screenshots/01-overview.png', 1280, 800],
  ['store/slides/02-alerts.html', 'store/screenshots/02-alerts.png', 1280, 800],
  ['store/slides/03-models.html', 'store/screenshots/03-models.png', 1280, 800],
  ['store/slides/04-activity.html', 'store/screenshots/04-activity.png', 1280, 800],
  ['store/slides/05-private.html', 'store/screenshots/05-private.png', 1280, 800],
  ['store/promo/small-440x280.html', 'store/promo/small-440x280.png', 440, 280],
  ['store/promo/marquee-1400x560.html', 'store/promo/marquee-1400x560.png', 1400, 560],
  ['store/promo/og-1200x630.html', 'store/promo/og-1200x630.png', 1200, 630],
  // the bare popup (2x), for the website hero
  ['/popup?scenario=busy&pinned=1', 'store/promo/popup.png', 360, 574, 2]
];

const server = await startServer(PORT);
try {
  for (const [page, out, width, height, scale = 1] of JOBS) {
    const target = join(ROOT, out);
    mkdirSync(join(target, '..'), { recursive: true });
    await run(browser, [
      '--headless=new', '--lang=en-US', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`,
      '--virtual-time-budget=6000', `--window-size=${width},${height}`, `--screenshot=${target}`,
      page.startsWith('/') ? `http://localhost:${PORT}${page}` : `http://localhost:${PORT}/files/${page}`
    ], { timeout: 60000 });
    console.log(`${out} (${width}x${height})`);
  }
} finally {
  server.close();
}
