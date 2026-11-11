// Release sanity checks, run by CI on every push and before a release is built:
//
//   node scripts/check-release.mjs [v1.2.3]    (optional tag to compare the version with)
//
// Catches the things that otherwise only fail at store upload: versions out of sync, store
// text limits, files the manifest or pages point at that don't exist, permissions that crept
// in, and code patterns the stores reject.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'extension');
const read = (path) => readFileSync(path, 'utf8');

const manifest = JSON.parse(read(join(EXT, 'manifest.json')));
const pkg = JSON.parse(read(join(ROOT, 'package.json')));
const tag = process.argv[2];

// What the extension is allowed to ask for. Changing this list is a deliberate decision:
// it also changes the store listing's permission justifications and the privacy policy.
const EXPECTED_PERMISSIONS = ['alarms', 'notifications', 'storage'];
const EXPECTED_HOSTS = ['https://ollama.com/api/*'];

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

// versions
check(manifest.version === pkg.version, `package.json version ${pkg.version} != manifest.json version ${manifest.version}`);
if (tag) check(tag === `v${manifest.version}`, `tag ${tag} does not match manifest version v${manifest.version}`);
check(/^\d+\.\d+\.\d+$/.test(manifest.version), `manifest version "${manifest.version}" is not x.y.z`);

// store limits (Chrome Web Store: name 75, summary 132)
check(manifest.name.length <= 75, `name is ${manifest.name.length} chars (max 75)`);
check(manifest.description.length <= 132, `description is ${manifest.description.length} chars (max 132)`);
check(/unofficial|not affiliated/i.test(manifest.description), 'description must say the extension is unofficial');

// the store listing text must match the manifest summary
check(read(join(ROOT, 'store', 'listing.md')).includes(manifest.description), 'store/listing.md does not contain the manifest description verbatim');

// the browser versions the texts promise are the ones the manifest and the Firefox build require
{
  const chromeMin = manifest.minimum_chrome_version;
  const firefoxMin = read(join(ROOT, 'scripts', 'build.mjs')).match(/FIREFOX_MIN_VERSION = '(\d+)/)?.[1];
  check(Boolean(chromeMin) && Boolean(firefoxMin), 'minimum_chrome_version (manifest) or FIREFOX_MIN_VERSION (build.mjs) is missing');
  for (const file of ['README.md', join('store', 'listing.md'), join('landing', 'index.html')]) {
    const text = read(join(ROOT, file));
    const chromeMentions = [...text.matchAll(/Chrome, Edge and Brave \(?(?:version )?(\d+)(?:\+| or newer)/g)].map((m) => m[1]);
    const firefoxMentions = [...text.matchAll(/Firefox(?: or|\s+and) Zen \(?(?:version )?(\d+)(?:\+| or newer)/g)].map((m) => m[1]);
    for (const v of chromeMentions) check(v === chromeMin, `${file} says Chrome ${v}+ but the manifest needs ${chromeMin}`);
    for (const v of firefoxMentions) check(v === firefoxMin, `${file} says Firefox ${v}+ but the build requires ${firefoxMin}`);
  }
  check(/Chrome, Edge and Brave \(?\d+\+/.test(read(join(ROOT, 'README.md'))), 'README.md no longer states the minimum Chrome version (the check above would pass vacuously)');
}

// the changelog has a section for this version, and a tagged release is no longer "unreleased"
{
  const changelog = read(join(ROOT, 'CHANGELOG.md'));
  const heading = changelog.match(new RegExp(`^## \\[${manifest.version.replaceAll('.', '\\.')}\\] - (.+)$`, 'm'));
  check(Boolean(heading), `CHANGELOG.md has no "## [${manifest.version}] - date" section`);
  if (tag && heading) check(/^\d{4}-\d{2}-\d{2}$/.test(heading[1]), `CHANGELOG.md still says "${heading[1]}" for ${manifest.version}: set its date before tagging`);
}

// docs: a heading that appears twice in one file means a paragraph was added instead of replaced
for (const file of ['README.md', 'CHANGELOG.md', ...readdirSync(join(ROOT, 'docs')).map((f) => join('docs', f)), join('store', 'README.md'), join('store', 'listing.md')]) {
  if (!file.endsWith('.md')) continue;
  const seen = new Set();
  for (const [, title] of read(join(ROOT, file)).matchAll(/^#{2,3} (.+)$/gm)) {
    if (file === 'CHANGELOG.md' && /^(Changed|Added|Removed|Fixed)$/.test(title)) continue; // repeated per version on purpose
    check(!seen.has(title), `${file} has the heading "${title}" twice`);
    seen.add(title);
  }
}

// permissions
check(JSON.stringify([...(manifest.permissions || [])].sort()) === JSON.stringify(EXPECTED_PERMISSIONS),
  `permissions changed: ${JSON.stringify(manifest.permissions)} (expected ${JSON.stringify(EXPECTED_PERMISSIONS)})`);
check(JSON.stringify(manifest.host_permissions) === JSON.stringify(EXPECTED_HOSTS),
  `host permissions changed: ${JSON.stringify(manifest.host_permissions)}`);
check(!manifest.optional_permissions && !manifest.content_scripts && !manifest.externally_connectable && !manifest.web_accessible_resources,
  'unexpected manifest sections (optional permissions, content scripts, externally_connectable, web_accessible_resources)');

// referenced files exist
const referenced = [
  manifest.action?.default_popup, manifest.options_page, manifest.background?.service_worker,
  ...Object.values(manifest.icons || {})
];
for (const file of referenced) check(file && existsSync(join(EXT, file)), `manifest points at missing file: ${file}`);

for (const page of readdirSync(EXT).filter((f) => f.endsWith('.html'))) {
  const html = read(join(EXT, page));
  for (const [, src] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:)?\/\//.test(src)) check(false, `${page} loads a remote resource: ${src}`);
    else check(existsSync(join(EXT, src)), `${page} points at missing file: ${src}`);
  }
}

// classes that exist only so landing/carousel.js can find an element
const HOOK_CLASSES = new Set(['car-prev', 'car-next', 'lb-prev', 'lb-next', 'lb-close']);

// the website: every class its pages use must have a rule (a stylesheet edit once removed whole
// sections' styles without any test noticing)
{
  const css = read(join(ROOT, 'landing', 'style.css'));
  for (const page of readdirSync(join(ROOT, 'landing')).filter((f) => f.endsWith('.html'))) {
    const html = read(join(ROOT, 'landing', page));
    const used = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
    for (const name of used) check(HOOK_CLASSES.has(name) || css.includes(`.${name}`), `landing/${page} uses class "${name}" but landing/style.css has no rule for it`);
  }
}

// code patterns the stores reject, and things this extension promises never to do
function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
const FORBIDDEN = [
  [/\beval\s*\(|new Function\s*\(/, 'eval / new Function'],
  [/\.innerHTML\s*=|insertAdjacentHTML/, 'innerHTML (build DOM with createElement/textContent)'],
  [/chrome\.cookies|credentials:\s*['"]include['"]/, 'cookie access (requests must use credentials: "omit")'],
  [/https?:\/\/(?!ollama\.com|www\.w3\.org|github\.com\/olaf-wilkosz|docs\.ollama\.com)[\w.-]+/, 'a URL outside the allowed hosts']
];
for (const path of listFiles(EXT).filter((f) => /\.(js|html|css)$/.test(f))) {
  const text = read(path);
  for (const [pattern, what] of FORBIDDEN) {
    check(!pattern.test(text), `${path.slice(ROOT.length)} contains ${what}`);
  }
}

if (problems.length > 0) {
  console.error(`Release check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Release check passed: ${manifest.name} v${manifest.version} (${manifest.description.length}/132 chars in the description)`);
