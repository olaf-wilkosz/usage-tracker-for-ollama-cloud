// Local preview of the popup and options page outside the browser, with a stubbed chrome.*
// API and sample data. Used to check the UI by eye and to render the store screenshots
// (scripts/render-store.mjs).
//
//   node scripts/preview-server.mjs            -> http://localhost:8765
//   /popup?scenario=free|busy|legacy|payg|connect|badkey|offline|empty[&settings=1]
//   /options?scenario=connected|fresh
//
// "free" is a real Free-account response (test/fixtures) moved to the present; the other
// scenarios are made-up sample numbers.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'extension');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const DAY = 86400e3;
const HOUR = 3600e3;

const { buildUsage, extractActivity } = await import(pathToFileURL(join(EXT, 'ollama-api.js')).href);
const { mergeActivity } = await import(pathToFileURL(join(EXT, 'activity.js')).href);

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Move every timestamp in a response by a whole number of days so the data looks current. */
function shiftTimes(value, delta) {
  if (typeof value === 'string' && ISO_RE.test(value)) {
    return new Date(Date.parse(value) + delta).toISOString().replace(/\.\d+Z$/, 'Z');
  }
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, delta));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftTimes(v, delta)]));
  return value;
}

/** Deterministic pseudo-random numbers, so screenshots are reproducible. */
function rng(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const metrics = (requests, usd) => ({ request_count: requests, usage_usd: usd, input_tokens: requests * 40000, cached_input_tokens: 0, output_tokens: requests * 600 });

/** Made-up but plausible week of usage: busy weekday daytimes, quiet nights and weekends. */
function busyRaw(now) {
  const rand = rng(11);
  const models = [['nemotron-3-ultra', 0.012], ['gpt-oss:120b', 0.006], ['gemma4:31b', 0.004], ['kimi-k3', 0.02], ['glm-5.3', 0.008], ['web_search', 0.01]];
  const weights = [30, 22, 18, 12, 9, 9];
  const pick = () => { let r = rand() * 100; for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return models[i]; } return models[0]; };

  const topOfHour = Math.floor(now / HOUR) * HOUR;
  const hourly = [];
  for (let i = 24; i >= 0; i--) {
    const from = new Date(topOfHour - i * HOUR);
    const local = new Date(from);
    const busy = local.getHours() >= 9 && local.getHours() <= 22 && local.getDay() % 6 !== 0 ? 1 : 0.1;
    const count = rand() < busy * 0.8 ? Math.round(rand() * 7 * busy + 1) : 0;
    const groups = {};
    for (let n = 0; n < count; n++) { const [name, price] = pick(); groups[name] ??= [0, 0]; groups[name][0]++; groups[name][1] += price; }
    hourly.push({ from, until: new Date(+from + HOUR), count, groups });
  }
  const bucket = (b) => ({
    from: b.from.toISOString().replace('.000Z', 'Z'), until: b.until.toISOString().replace('.000Z', 'Z'),
    ...metrics(b.count, Object.values(b.groups).reduce((s, g) => s + g[1], 0)),
    groups: Object.entries(b.groups).map(([model, [n, usd]]) => ({ model, ...metrics(n, usd) }))
  });
  const day = { range: '24h', scope: 'self', granularity: 'hour', group_by: 'model', buckets: hourly.map(bucket) };

  const startOfDay = Math.floor(now / DAY) * DAY;
  const daily = [];
  const totals = {};
  for (let i = 30; i >= 0; i--) {
    const from = new Date(startOfDay - i * DAY);
    const weekend = [0, 6].includes(from.getUTCDay());
    const count = rand() < (weekend ? 0.45 : 0.9) ? Math.round(rand() * (weekend ? 20 : 70) + 3) : 0;
    const groups = {};
    for (let n = 0; n < count; n++) { const [name, price] = pick(); groups[name] ??= [0, 0]; groups[name][0]++; groups[name][1] += price; totals[name] ??= [0, 0]; totals[name][0]++; totals[name][1] += price; }
    daily.push(bucket({ from, until: new Date(+from + DAY), count, groups }));
  }
  const month = {
    range: '30d', scope: 'self', granularity: 'day', group_by: 'model', buckets: daily,
    totals: { ...metrics(0, 0), groups: Object.entries(totals).map(([model, [n, usd]]) => ({ model, ...metrics(n, usd) })) }
  };

  const balance = { included: { balance_usd: 7.5, allowance_usd: 25, period: {
    from: new Date(now - 11 * DAY).toISOString(), until: new Date(now + 19 * DAY + 5 * HOUR).toISOString() } }, purchased: { balance_usd: 4.2 } };
  return { balance, day, month };
}

/** What the extension would have stored for a scenario: usage data + activity. */
function scenario(name, now = Date.now()) {
  const lastFetch = new Date(now - 2 * 60e3).toISOString();
  const finish = (raw) => {
    const usage = { ...buildUsage(raw), lastFetch };
    const activity = mergeActivity(undefined, extractActivity(raw), new Date(now));
    return { data: usage, activity };
  };

  switch (name) {
    case 'free': {
      const delta = Math.floor((now - Date.parse('2026-11-03T14:39:55Z')) / DAY) * DAY;
      const raw = shiftTimes({ balance: fixture('balance-free.json'), day: fixture('usage-24h-by-model.json'), month: fixture('usage-30d-by-model.json') }, delta);
      raw.balance.included.period.until = new Date(now + 19 * HOUR).toISOString();
      return finish(raw);
    }
    case 'busy': return finish(busyRaw(now));
    case 'legacy': {
      const raw = busyRaw(now);
      raw.balance = { included: {
        session: { remaining_percent: 43, resets_at: new Date(now + 3 * HOUR + 12 * 60e3).toISOString() },
        weekly: { remaining_percent: 9, resets_at: new Date(now + 3 * DAY + 4 * HOUR).toISOString() } }, purchased: { balance_usd: 0 } };
      return finish(raw);
    }
    case 'payg': {
      const raw = busyRaw(now);
      raw.balance = { included: { balance_usd: 0, allowance_usd: 0, period: { from: '', until: '' } }, purchased: { balance_usd: 12.5 } };
      return finish(raw);
    }
    case 'offline': {
      const { data, activity } = finish(busyRaw(now));
      return { data: { ...data, status: 'network_error', stale: true, lastFetch: new Date(now - 26 * 60e3).toISOString() }, activity };
    }
    case 'connect': return { data: { status: 'no_key', meters: [], credits: null, models: [], recentHours: [] }, activity: null };
    case 'badkey': return { data: { status: 'auth_required', meters: [], credits: null, models: [], recentHours: [] }, activity: null };
    default: return { data: null, activity: null };
  }
}

function stub({ data, activity, hasKey }) {
  return `<script>
(() => {
  const data = ${JSON.stringify(data)};
  const activity = ${JSON.stringify(activity)};
  const settings = { refreshIntervalMinutes: 5, notifyWarning: 80, notifyCritical: 95, notifyEnabled: true, showPeakBanner: true };
  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: '1.2.0' }),
      openOptionsPage: () => console.log('openOptionsPage'),
      sendMessage(msg, cb) {
        const replies = {
          GET_USAGE_DATA: { data }, GET_SETTINGS: { settings }, GET_KEY_STATE: { hasKey: ${hasKey} },
          SAVE_API_KEY: msg.key === 'bad' ? { success: false, error: 'Ollama rejected this key. Check that you copied all of it.' } : { success: true }
        };
        setTimeout(() => cb && cb(replies[msg.type] || { success: true }), 0);
      }
    },
    storage: { local: { get: async () => ({ ollamaActivity: activity, ollamaDiagnostics: { text: '{}' } }) }, onChanged: { addListener() {} } }
  };
})();
</script>`;
}

export function startServer(port = 8765) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

    if (url.pathname === '/popup' || url.pathname === '/options') {
      const name = url.searchParams.get('scenario') || (url.pathname === '/popup' ? 'free' : 'connected');
      const isOptions = url.pathname === '/options';
      const state = scenario(isOptions ? 'free' : name);
      const hasKey = isOptions ? name === 'connected' : !['connect', 'empty'].includes(name);
      let html = readFileSync(join(EXT, isOptions ? 'options.html' : 'popup.html'), 'utf8');
      html = html.replace('<head>', () => `<head><base href="/ext/">${stub({ ...state, hasKey })}`);
      if (!isOptions && url.searchParams.get('settings')) {
        html = html.replace('</body>', () => '<script type="module">setTimeout(() => document.getElementById("settingsBtn").click(), 300)</script></body>');
      }
      return send(200, 'text/html', html);
    }

    if (url.pathname.startsWith('/ext/')) {
      const file = normalize(join(EXT, url.pathname.slice(5)));
      if (file.startsWith(EXT) && existsSync(file)) return send(200, MIME[extname(file)] || 'application/octet-stream', readFileSync(file));
    }
    if (url.pathname.startsWith('/files/')) { // store slides and landing page assets
      const file = normalize(join(ROOT, url.pathname.slice(7)));
      const allowed = ['store', 'landing'].some((dir) => file.startsWith(join(ROOT, dir)));
      if (allowed && existsSync(file)) return send(200, MIME[extname(file)] || 'application/octet-stream', readFileSync(file));
    }
    send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8765;
  await startServer(port);
  console.log(`Preview: http://localhost:${port}/popup?scenario=free`);
}
