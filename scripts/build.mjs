// Builds the store packages from extension/ (one source, two thin manifests):
//
//   node scripts/build.mjs            -> dist/chrome, dist/firefox and both zips
//   node scripts/build.mjs chrome     -> only the Chrome / Edge / Brave package
//   node scripts/build.mjs firefox    -> only the Firefox package
//   node scripts/build.mjs firefox --watch   -> dist/firefox kept up to date while you edit
//                                               extension/ (no zip); reload the add-on after a change
//
// extension/ is the Chrome / Edge / Brave extension and loads there directly. Firefox (and Zen)
// need an event page instead of a service worker plus an add-on id, so they load dist/firefox:
// the same files with a different manifest.json.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'extension');
const DIST = join(ROOT, 'dist');

const GECKO_ID = 'usage-tracker-for-ollama-cloud@olaf-wilkosz.github.io';
const FIREFOX_MIN_VERSION = '140.0'; // first release that understands data_collection_permissions

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
const slug = 'usage-tracker-for-ollama-cloud';
const GENERATED = new Set(['manifest.json', 'build-info.js']);

/** Per-browser manifest. */
function manifestFor(target) {
  if (target === 'chrome') return manifest;

  const { minimum_chrome_version: _chromeOnly, ...rest } = manifest;
  return {
    ...rest,
    background: { scripts: [manifest.background.service_worker], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        // The API key is sent to ollama.com (the service the extension exists for), nowhere else
        data_collection_permissions: { required: ['authenticationInfo'] }
      }
    }
  };
}

/** Commit and time of this build; "+local" marks uncommitted changes. */
function buildInfo() {
  const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const commit = git('rev-parse', '--short', 'HEAD').stdout?.trim() || 'unknown';
  const dirty = Boolean(git('status', '--porcelain').stdout?.trim());
  return { commit: dirty ? `${commit}+local` : commit, builtAt: new Date().toISOString() };
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Bring dist/<target> in line with extension/ in place: the folder itself is never deleted
 * (a browser may have it loaded as a temporary add-on, and Windows would refuse).
 */
function syncFolder(target) {
  const out = join(DIST, target);
  mkdirSync(out, { recursive: true });
  cpSync(SRC, out, { recursive: true, force: true });
  for (const file of listFiles(out)) {
    const name = relative(out, file).replaceAll('\\', '/');
    if (!GENERATED.has(name) && !existsSync(join(SRC, name))) rmSync(file, { force: true });
  }
  writeFileSync(join(out, 'build-info.js'), `export const BUILD = ${JSON.stringify(buildInfo())};\n`);
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifestFor(target), null, 2)}\n`);
  return out;
}

function build(target) {
  const out = syncFolder(target);

  // Zip with the manifest at the archive root, files in a stable order
  const files = Object.fromEntries(
    listFiles(out).sort().map((path) => [relative(out, path).replaceAll('\\', '/'), readFileSync(path)])
  );
  const zipPath = join(DIST, `${slug}-${manifest.version}-${target}.zip`);
  try {
    writeFileSync(zipPath, zipSync(files, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') }));
  } catch (error) {
    // Windows keeps a zip locked while a browser has it loaded as a temporary add-on
    throw new Error(`Could not write ${relative(ROOT, zipPath)} (${error.code}): is a browser using that file? Remove it there and run the build again. The unpacked folder dist/${target} is up to date.`);
  }
  console.log(`${target}: ${relative(ROOT, zipPath)} (${Object.keys(files).length} files, ${(statSync(zipPath).size / 1024).toFixed(1)} KB)`);
}

const args = process.argv.slice(2);
const wanted = args.find((arg) => !arg.startsWith('--'));

if (args.includes('--watch')) {
  const target = wanted ?? 'firefox';
  syncFolder(target);
  console.log(`dist/${target} is in sync with extension/ and stays so while you edit.`);
  console.log(`Load dist/${target}/manifest.json once (Firefox / Zen: about:debugging > This Firefox > Load Temporary Add-on), then press Reload there after a change. Ctrl+C stops.`);
  let timer = null;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      syncFolder(target);
      console.log(`${new Date().toLocaleTimeString()}  dist/${target} updated - reload the add-on`);
    }, 250);
  });
} else {
  const targets = wanted ? [wanted] : ['chrome', 'firefox'];
  for (const target of targets) {
    if (!['chrome', 'firefox'].includes(target)) throw new Error(`Unknown target "${target}" (chrome | firefox)`);
    build(target);
  }
}
