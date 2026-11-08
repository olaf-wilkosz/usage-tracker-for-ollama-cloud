// Accessibility audit: runs axe-core (WCAG 2.0/2.1/2.2 A + AA and best practices) against the
// popup in its main states, the options page and the website, in a headless Chromium-based
// browser. Exits non-zero when anything is found, so it can run in CI.
//
//   node scripts/a11y.mjs            (Edge, Chrome or Brave is picked automatically; BROWSER=path overrides)
//
// What it cannot judge: whether labels make sense, reading order with a real screen reader,
// keyboard flow. Those stay manual checks (see docs/architecture.md, "Accessibility").
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './preview-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8767;
const DEBUG_PORT = 9334;

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

const PAGES = [
  ['popup: usage', '/popup?scenario=busy'],
  ['popup: not pinned hint', '/popup?scenario=free'],
  ['popup: setup', '/popup?scenario=connect'],
  ['popup: rejected key', '/popup?scenario=badkey'],
  ['popup: offline (stale data)', '/popup?scenario=offline&pinned=1'],
  ['popup: legacy plan', '/popup?scenario=legacy&pinned=1'],
  ['popup: month heatmap', '/popup?scenario=busy&pinned=1&click=%23activityMonthBtn'],
  ['popup: settings', '/popup?scenario=busy&pinned=1&settings=1'],
  ['options: first run', '/options?scenario=fresh'],
  ['options: connected', '/options?scenario=connected'],
  ['website', '/files/landing/index.html'],
  ['privacy policy', '/files/landing/privacy.html']
];

const axeSource = readFileSync(join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = await startServer(PORT);
const profile = mkdtempSync(join(tmpdir(), 'ut-a11y-'));
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--lang=en-US', '--no-first-run', '--disable-gpu',
  // CI runners (Ubuntu with restricted user namespaces) cannot start Chrome's sandbox
  ...(process.env.CI ? ['--no-sandbox'] : []),
  'about:blank'
], { stdio: 'ignore' });

async function openTarget(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURI(url)}`, { method: 'PUT' });
      return await response.json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error('browser did not start');
}

async function audit(url) {
  const target = await openTarget(`http://localhost:${PORT}${url}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  let next = 0;
  const waiting = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  const call = (method, params = {}) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails.exception?.description));
    return response.result.result.value;
  };

  await call('Emulation.setDeviceMetricsOverride', { width: url.includes('/files/landing') ? 1280 : 360, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1800); // page script + the click/scroll helpers of the preview server
  await evaluate(axeSource);
  const result = JSON.parse(await evaluate(`axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    resultTypes: ['violations']
  }).then((r) => JSON.stringify(r.violations.map((v) => ({
    id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4), count: v.nodes.length
  }))))`));
  socket.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`).catch(() => {});
  return result;
}

let failures = 0;
try {
  for (const [name, url] of PAGES) {
    const violations = await audit(url);
    console.log(`${violations.length === 0 ? 'PASS' : 'FAIL'}  ${name}`);
    for (const v of violations) {
      failures++;
      console.log(`      [${v.impact}] ${v.id}: ${v.help} (${v.count}x)  e.g. ${v.nodes.join(' | ')}`);
    }
  }
} finally {
  proc.kill();
  server.close();
}
console.log(failures === 0 ? '\nNo automatic accessibility violations found.' : `\n${failures} violation type(s) found.`);
process.exit(failures === 0 ? 0 : 1);
