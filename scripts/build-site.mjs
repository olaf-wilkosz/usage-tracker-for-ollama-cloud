// Assembles the website (landing page + privacy policy) into dist/site: landing/ plus the
// images it shows, taken from store/ and extension/ so there is one copy of each.
//
//   node scripts/build-site.mjs      then open dist/site/index.html
//
// Run by the Pages workflow; the PNGs come from `node scripts/render-store.mjs`.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'dist', 'site');

const SLIDES = ['01-overview', '02-payg', '03-alerts', '04-models', '05-activity', '06-private'];

const IMAGES = [
  ...SLIDES.flatMap((name) => [
    [`store/screenshots/web/${name}.webp`, `img/${name}.webp`],
    [`store/screenshots/web/hi/${name}.webp`, `img/hi/${name}.webp`]
  ]),
  ['store/promo/popup-1x.webp', 'img/popup-1x.webp'],
  ['store/promo/popup.webp', 'img/popup.webp'],
  ['store/promo/og-1200x630.png', 'img/og.png'],
  ['extension/icons/icon128.png', 'img/icon128.png']
];

mkdirSync(OUT, { recursive: true });
// Empty the folder rather than deleting it: a preview server or shell may be sitting in it
for (const entry of readdirSync(OUT)) rmSync(join(OUT, entry), { recursive: true, force: true });
mkdirSync(join(OUT, 'img', 'hi'), { recursive: true });
cpSync(join(ROOT, 'landing'), OUT, { recursive: true });

for (const [from, to] of IMAGES) {
  if (!existsSync(join(ROOT, from))) throw new Error(`Missing ${from} - run "node scripts/render-store.mjs" first`);
  cpSync(join(ROOT, from), join(OUT, to));
}
console.log(`Site assembled in dist/site (${IMAGES.length} images)`);
