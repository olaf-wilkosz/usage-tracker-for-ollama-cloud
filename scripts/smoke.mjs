// Smoke test in a real browser: loads extension/ unpacked into Edge or Brave (headless),
// checks that the service worker starts without errors, that the setup flow works against the
// real Ollama API (a made-up key must be refused) and that the key sealing works in a real
// IndexedDB. Needs no account and no API key. Branded Chrome (137+) ignores --load-extension,
// so use Edge, Brave or Chromium:
//
//   node scripts/smoke.mjs "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [chrome, extDir = fileURLToPath(new URL('../extension', import.meta.url))] = process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), 'ut-smoke-'));
const port = 9333;
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--disable-gpu', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; }
}

/** True when the service worker target belongs to this extension (browsers ship built-in ones with the same file name). */
async function isOurs(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener("open", r));
  const answer = await new Promise((resolve) => {
    socket.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m); });
    setTimeout(() => resolve({}), 3000);
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "chrome.runtime.getManifest().name", returnByValue: true } }));
  });
  socket.close();
  return answer.result?.result?.value === "Usage Tracker for Ollama Cloud";
}

let sw;
for (let i = 0; i < 40 && !sw; i++) {
  await sleep(500);
  for (const target of (await targets()).filter((t) => t.type === "service_worker")) {
    if (await isOurs(target)) { sw = target; break; }
  }
}
if (!sw) { console.log('FAIL: no service worker target found', JSON.stringify((await targets()).map((t) => [t.type, t.url])), 'chrome', (await (await fetch('http://127.0.0.1:' + port + '/json/version').catch(() => null))?.json())?.Browser); proc.kill(); process.exit(1); }
console.log('service worker:', sw.url);

const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const call = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result.exceptionDetails ? 'ERR ' + JSON.stringify(r.result.exceptionDetails.exception?.description) : r.result.result.value;
};
await call('Runtime.enable');
await sleep(2500);

console.log('badge text:', await evaluate('chrome.action.getBadgeText({})'));
console.log('title:', JSON.stringify(await evaluate('chrome.action.getTitle({})')));
console.log('stored usage status:', await evaluate('chrome.storage.local.get("ollamaUsageData").then(r => r.ollamaUsageData && r.ollamaUsageData.status)'));
console.log('manifest permissions:', JSON.stringify(await evaluate('chrome.runtime.getManifest().permissions')));

// --- extension pages run in a document, where dynamic import and the full UI are available ---
const extId = new URL(sw.url).host;
async function openPage(path) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/${path}`, { method: "PUT" })).json();
  const sock = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => sock.addEventListener("open", r));
  let n = 0; const wait = new Map();
  sock.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } if (m.method === "Runtime.exceptionThrown") logs.push("PAGE EXCEPTION " + m.params.exceptionDetails.exception?.description); });
  const send = (method, params = {}) => new Promise((res) => { const i = ++n; wait.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await sleep(1200);
  return { evaluate: async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? "ERR " + JSON.stringify(r.result.exceptionDetails.exception?.description) : r.result.result.value; }, close: () => sock.close() };
}

const options = await openPage("options.html");
console.log("options page title:", await options.evaluate("document.title"), "| version shown:", await options.evaluate("document.getElementById('version').textContent"));
console.log("seal round trip (real IndexedDB + WebCrypto):", await options.evaluate(`(async () => {
  const m = await import("./secret-store.js");
  const sealed = await m.sealSecret("abc.def-123456");
  const back = await m.openSecret(sealed);
  await m.destroySealingKey();
  return JSON.stringify({ ok: back === "abc.def-123456", leaked: JSON.stringify(sealed).includes("abc.def") });
})()`));
// the whole UI flow against the real API: a made-up key must be refused by Ollama itself
console.log("connect with a bogus key:", await options.evaluate(`(async () => {
  document.getElementById("apiKeyInput").value = "not-a-real-key-123456789";
  document.getElementById("saveKeyBtn").click();
  await new Promise((r) => setTimeout(r, 4000));
  const st = document.getElementById("keyStatus");
  return JSON.stringify({ status: st.textContent, hidden: st.hidden, stored: (await chrome.storage.local.get("ollamaApiKey")).ollamaApiKey ?? null });
})()`));
options.close();

const popup = await openPage("popup.html");
console.log("popup shows inline setup:", await popup.evaluate("JSON.stringify({ connect: !document.getElementById('connectBlock').hidden, title: document.getElementById('headerTitle').textContent, meters: document.getElementById('metersContainer').children.length, pinHintHiddenDuringSetup: document.getElementById('pinHint').hidden })"));
console.log("popup: bogus key:", await popup.evaluate(`(async () => {
  document.getElementById("apiKeyInput").value = "not-a-real-key-123456789";
  document.getElementById("connectBtn").click();
  await new Promise((r) => setTimeout(r, 4000));
  const st = document.getElementById("connectStatus");
  return JSON.stringify({ status: st.textContent, hidden: st.hidden, stillSetup: !document.getElementById("connectBlock").hidden });
})()`));
console.log("pin API available:", await popup.evaluate("chrome.action.getUserSettings().then((u) => JSON.stringify(u))"));
popup.close();
console.log('errors/warnings logged:', JSON.stringify(logs));

ws.close(); proc.kill();
await sleep(500);
