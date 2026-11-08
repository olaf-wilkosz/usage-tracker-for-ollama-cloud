// Prints what the Ollama API reports for YOUR account and checks it for consistency, so the
// numbers can be compared with ollama.com/settings and edge cases (period reset, UTC day
// boundaries, pseudo-models such as web_search) can be looked at without pasting raw JSON.
//
//   PowerShell:  $env:OLLAMA_API_KEY = "<key>"; npm run probe
//   bash:        OLLAMA_API_KEY=<key> npm run probe
//   offline:     npm run probe -- --fixtures        (uses test/fixtures, no key needed)
//
// The key is read from the environment only and is never printed. Output contains usage
// numbers and model names, so it is safe to paste into an issue.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const useFixtures = process.argv.includes('--fixtures');
const key = process.env.OLLAMA_API_KEY;

async function get(path, fixture) {
  if (useFixtures) return JSON.parse(readFileSync(`${ROOT}test/fixtures/${fixture}`, 'utf8'));
  const response = await fetch(`https://ollama.com/api${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

if (!useFixtures && !key) {
  console.error('Set OLLAMA_API_KEY first (see the comment at the top of this file).');
  process.exit(1);
}

const usd = (n) => `$${(n ?? 0).toFixed(4)}`;
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
const sum = (list, pick) => list.reduce((a, x) => a + (pick(x) || 0), 0);
const warnings = [];

let balance, day, week, month;
try {
  [balance, day, week, month] = await Promise.all([
    get('/balance', 'balance-free.json'),
    get('/usage?range=24h&group_by=model', 'usage-24h-by-model.json'),
    get('/usage?range=7d&group_by=model', 'usage-24h-by-model.json'),
    get('/usage?range=30d&group_by=model', 'usage-30d-by-model.json')
  ]);
} catch (error) {
  console.error(`Request failed: ${error.message}`);
  process.exit(1);
}

console.log(`Now: ${new Date().toISOString()}  (local ${new Date().toString().slice(0, 33)})\n`);

// ---- balance ----
console.log('== /api/balance');
const inc = balance.included;
if (typeof inc?.allowance_usd === 'number') {
  const used = inc.allowance_usd - inc.balance_usd;
  console.log(`included: ${usd(inc.balance_usd)} left of ${usd(inc.allowance_usd)}  -> ${((used / inc.allowance_usd) * 100).toFixed(2)}% used`);
  console.log(`period:   ${inc.period?.from}  ->  ${inc.period?.until}`);
  if (inc.balance_usd > inc.allowance_usd) warnings.push('included balance is larger than the allowance');
} else {
  console.log('included (legacy windows):', JSON.stringify(inc));
}
console.log(`purchased: ${usd(balance.purchased?.balance_usd)}\n`);

// ---- ranges ----
function describe(name, data) {
  const buckets = data.buckets ?? [];
  const totals = data.totals ?? {};
  console.log(`== /api/usage?range=${name}  granularity=${data.granularity}  buckets=${buckets.length}  ${data.from} -> ${data.until}`);
  console.log(`totals: ${totals.request_count} requests, ${usd(totals.usage_usd)}, ${totals.input_tokens} in / ${totals.output_tokens} out tokens`);
  const groups = totals.groups ?? [];
  for (const g of groups) console.log(`  ${pad(g.model, 24)} ${num(g.request_count, 5)} req  ${num(usd(g.usage_usd), 9)}`);
  if (totals.remainder) console.log(`  ${pad('(remainder)', 24)} ${num(totals.remainder.request_count, 5)} req  ${num(usd(totals.remainder.usage_usd), 9)}`);

  const bucketRequests = sum(buckets, (b) => b.request_count);
  if (bucketRequests !== totals.request_count) warnings.push(`${name}: bucket requests (${bucketRequests}) != totals (${totals.request_count})`);
  const groupRequests = sum(groups, (g) => g.request_count) + (totals.remainder?.request_count || 0);
  if (groups.length && groupRequests !== totals.request_count) warnings.push(`${name}: group requests (${groupRequests}) != totals (${totals.request_count})`);
  const partial = buckets.filter((b) => b.partial);
  if (partial.length !== 1 || partial[0] !== buckets.at(-1)) warnings.push(`${name}: expected exactly one partial bucket, the last (found ${partial.length})`);
  console.log('');
  return { buckets, totals };
}

describe('24h', day);
describe('7d', week);
const m = describe('30d', month);

// ---- daily table ----
console.log('== daily requests, last 14 days (UTC days)');
for (const b of m.buckets.slice(-14)) {
  const models = (b.groups ?? []).map((g) => `${g.model} ${g.request_count}`).join(', ');
  console.log(`${b.from.slice(0, 10)}  ${num(b.request_count, 4)} req  ${num(usd(b.usage_usd), 9)}${b.partial ? '  (today, partial)' : ''}   ${models}`);
}

// ---- since the current billing period began ----
if (inc?.period?.from) {
  const from = Date.parse(inc.period.from);
  const dayStart = Math.floor(from / 86400e3) * 86400e3;
  const inPeriod = m.buckets.filter((b) => Date.parse(b.from) >= dayStart);
  const byModel = {};
  for (const b of inPeriod) for (const g of b.groups ?? []) {
    byModel[g.model] ??= { requests: 0, usd: 0 };
    byModel[g.model].requests += g.request_count;
    byModel[g.model].usd += g.usage_usd;
  }
  console.log(`\n== since the period began (${new Date(dayStart).toISOString().slice(0, 10)} 00:00 UTC, whole days; the period itself began ${inc.period.from})`);
  console.log(`requests: ${sum(inPeriod, (b) => b.request_count)}, cost ${usd(sum(inPeriod, (b) => b.usage_usd))}`);
  for (const [model, v] of Object.entries(byModel)) console.log(`  ${pad(model, 24)} ${num(v.requests, 5)} req  ${num(usd(v.usd), 9)}`);
  const withoutSearch = sum(inPeriod, (b) => b.request_count) - (byModel.web_search?.requests || 0);
  console.log(`requests without web_search: ${withoutSearch}`);
  const allowanceUsed = inc.allowance_usd - inc.balance_usd;
  console.log(`allowance used: ${usd(allowanceUsed)}  vs  cost in period: ${usd(sum(inPeriod, (b) => b.usage_usd))}`);
}

console.log(warnings.length ? `\nWARNINGS:\n- ${warnings.join('\n- ')}` : '\nConsistency checks: all passed (buckets = totals = groups, one partial bucket).');
