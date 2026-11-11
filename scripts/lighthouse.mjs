// Lighthouse on the built website (dist/site), served locally, in a clean headless browser.
// A local run of the code under test: the result depends on the code, not on GitHub Pages or on
// the extensions installed in someone's browser. Exits non-zero when a score drops below its bar.
//
//   npm run site && npm run lighthouse     (Chrome is picked automatically; BROWSER=path overrides)
//
// Accessibility, best practices and SEO are deterministic, so they must stay at 100. Performance
// varies from run to run on shared machines: it is the median of three runs and needs 90.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './preview-server.mjs';
import { stopBrowser } from './stop-browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8768;
const DEBUG_PORT = 9335;
const RUNS = 3;
const PAGES = [['home', '/site/'], ['privacy policy', '/site/privacy.html']];
const BARS = { performance: 0.9, accessibility: 1, 'best-practices': 1, seo: 1 };

// Chrome first (Edge hands over to another process, which is awkward to follow)
const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];
const browser = CANDIDATES.find((path) => path && existsSync(path));
if (!browser) throw new Error('No Chromium-based browser found; set BROWSER=path');
if (!existsSync(join(ROOT, 'dist', 'site', 'index.html'))) throw new Error('dist/site is missing: run "npm run site" first');

const cli = join(ROOT, 'node_modules', 'lighthouse', 'cli', 'index.js');
/** Run a command without blocking the event loop; resolves with its exit status and the end of stderr. */
const run = (command, args, env) => new Promise((resolve) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.on('close', (status) => resolve({ status, stderr }));
});
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const server = await startServer(PORT);
const work = mkdtempSync(join(tmpdir(), 'ut-lh-'));
const profile = mkdtempSync(join(tmpdir(), 'ut-lh-profile-'));
let failed = false;

// The browser is started here (a throwaway profile, so no extensions) and Lighthouse only connects
// to it, so that it can be closed gracefully at the end: a browser that is killed leaves stale
// entries in the Windows shell (Alt+Tab).
const chrome = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
  ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'
], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok, () => false)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

try {
  for (const [name, path] of PAGES) {
    const scores = {};
    for (let attempt = 0; attempt < RUNS; attempt++) {
      const output = join(work, `${name.replace(/\W+/g, '-')}-${attempt}.json`);
      // async: the site is served by this very process, which must stay free to answer Chrome
      const result = await run(process.execPath, [
        cli, `http://127.0.0.1:${PORT}${path}`,
        '--output=json', `--output-path=${output}`, '--quiet',
        '--only-categories=performance,accessibility,best-practices,seo',
        `--port=${DEBUG_PORT}`
      ], { ...process.env });
      if (result.status !== 0 || !existsSync(output)) {
        console.log(`FAIL  ${name}: Lighthouse did not run\n${result.stderr?.slice(-600)}`);
        failed = true;
        break;
      }
      const { categories } = JSON.parse(readFileSync(output, 'utf8'));
      for (const [id, category] of Object.entries(categories)) (scores[id] ??= []).push(category.score);
    }
    if (Object.keys(scores).length === 0) continue;

    const line = [];
    for (const [id, bar] of Object.entries(BARS)) {
      const value = id === 'performance' ? median(scores[id]) : Math.min(...scores[id]);
      const ok = value >= bar;
      if (!ok) failed = true;
      line.push(`${id} ${Math.round(value * 100)}${ok ? '' : ` (needs ${Math.round(bar * 100)})`}`);
    }
    console.log(`${line.some((entry) => entry.includes('needs')) ? 'FAIL' : 'PASS'}  ${name}: ${line.join(' | ')}`);
  }
} finally {
  server.close?.();
  await stopBrowser(chrome, profile, DEBUG_PORT);
  rmSync(work, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
else console.log('\nLighthouse: all scores meet their bar.');
process.exit(process.exitCode ?? 0);
