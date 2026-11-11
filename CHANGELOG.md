# Changelog

## 1.2.0 (unreleased)

- **Data source:** the extension now uses the official Ollama API (`/api/balance`, `/api/usage`) with an API key from the user's own account, instead of reading `ollama.com/settings`. Setup page and in-popup setup prompt added.
- **Privacy:** API key encrypted at rest (AES-GCM, non-extractable key); host access narrowed to `https://ollama.com/api/*`; the `offscreen` permission is gone; requests carry no cookies.
- **Activity:** exact hourly activity for the last 24 h and daily totals for 30 days from the API (the month heatmap is complete from the first refresh); "Recent activity" lists the busiest recent hours.
- **Robustness:** last good numbers stay on screen (marked stale) when the API is briefly unreachable.
- **Accessibility:** text and badge colors meet WCAG AA.
- **Robustness:** a 429 is honoured (no requests until Retry-After has passed); the 30-day series is cached for 10 minutes (two calls per refresh instead of three); saving or removing the key during a refresh can no longer be overwritten by that refresh; the options page shows "Connected" only for a key Ollama accepts.
- **Pay as you go** (Ollama ended the Free plan with included usage in November 2026): the credits balance is the toolbar badge ("$18": green; orange when the credits last the "Low credits" number of days or less at the recent pace, default 3, 0 = off; red once they ran out after having been there; neutral gray for an account that never had any), the popup says how many days they last, and one alert fires when they drop to low and one when they run out (never at the first reading). An account without an `included` block is no longer an error.
- **First run is the popup:** on install the toolbar popup itself opens on the "paste your key" screen (only while a browser window has focus, so it can never stay on screen as a stray window); where a browser cannot do that (Firefox needs a click) a welcome tab opens instead, shows only the connect step, confirms and closes itself - no page of options.
- **Number fields** have their own "-" and "+" buttons (same in every browser, kept out of the Tab order; the field keeps the arrow keys) instead of the native spin buttons.
- **Website:** screenshots in a carousel (full content width, arrows beside the picture, swipe, a fade in the enlarged view; on small touch screens no arrows and no enlarged view, just swipe and the dots) with an enlarged view that steps through them in sync with the carousel, closes with a cross, never scrolls and locks the page behind it; all images are WebP (about a tenth of the PNG size; the PNGs stay for the stores); the hero image is preloaded in the right size; browser FAQ written for the released product; privacy policy on the same page width as the home page.
- **First-run window** fills its window (same layout as the toolbar popup, no stray gap) and "Add credits" goes to the dashboard, where credits are bought.
- **Firefox / Zen:** `dist/firefox` has its own manifest (event page, add-on id); `npm run dev:firefox` keeps it in sync while you edit. `extension/manifest.json` stays a clean Chrome manifest (no warnings in Chrome, Edge, Brave). A reinstall with a working key no longer opens any setup.
- **Which copy is this?** The settings show the version and either the build (commit, time) or, for an unpacked folder, when the browser loaded it, so a stale copy in one browser is easy to spot.
- **Notifications:** a toast shown under the same id is cleared first (Windows can update such a toast silently instead of popping it up), "Send test" uses a fresh id on every click and explains where to look when nothing shows.
- **Key management in the popup:** Settings has the account group (connected or not, paste a new key to replace it, remove it); no more detour to the options page.
- **Recent activity** lists the last 24 hours by hour and the last 14 days by day (the API has no per-request detail).
- `npm run a11y` also presses Tab through every page: all controls reachable, focus indicator on each, no positive tabindex.
- **Models range:** the calendar month so far (UTC, default: it is exactly what the usage page on ollama.com shows, "Nov 1–8, UTC"), 7 days or 30 days, all derived from the same daily data with a date caption and total cost; no extra request.
- **Heatmap:** cells that were never recorded (before the extension started, or while the browser was closed for more than a day) are hatched instead of looking like zero requests.
- **Keyboard:** optional shortcut Alt+Shift+U opens the popup; manual keyboard / screen-reader test script in docs/accessibility-testing.md.
- **First run:** a welcome tab with only the connect step, then "You're all set" and what to do next. (Opening the popup on install was tried and dropped: opened without a click it can end up in a window that is not focused and stays on screen.)
- **Accessibility:** `lang` on all extension pages, pressed state on the range toggles, heatmap hidden from assistive technology and replaced by a text summary; `npm run a11y` (axe-core) added.
- **Setup in the popup:** create-a-key link, paste field and Connect button right in the popup; a dismissible hint to pin the extension to the toolbar (shown only while it is not pinned). The title bar now reads "Usage Tracker for Ollama Cloud"; the footer links to ollama.com/settings/usage.
- **Name:** renamed to "Usage Tracker for Ollama Cloud" and marked as unofficial.
- **Project:** `extension/`, `store/`, `landing/`, `docs/` layout; CI, release and Pages workflows; Firefox build; browser smoke test.
- Removed: HTML parsing, "Recent requests" per-request list, model colors read from the page.

## 1.1.0

- Adapted to Ollama's new billing (included usage and credits instead of session / weekly windows).
- Model donut, activity heatmap, peak / off-peak banner, usage alerts with thresholds, "Send test" notification, single-ring toolbar icon with percentage badge.
- Tests and MIT license.

## 1.0.0

- First version: session and weekly usage from the settings page.
