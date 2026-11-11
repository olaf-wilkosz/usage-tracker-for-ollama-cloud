# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The 1.2.0 date is set when it is tagged.

## [1.2.0] - unreleased

Ollama ended the Free plan with included usage in November 2026 and now bills in dollars, so this release changes where the numbers come from and adds what pay-as-you-go accounts need.

### Changed

- **Data source:** the extension uses the official Ollama API (`/api/balance`, `/api/usage`) with an API key from your own account instead of reading `ollama.com/settings`. Nothing is read from the page any more and requests carry no cookies.
- **Privacy:** the API key is encrypted at rest (AES-GCM, non-extractable key); host access is narrowed to `https://ollama.com/api/*`; the `offscreen` permission is gone.
- **Setup:** the key is pasted into the popup itself. On install the toolbar popup opens on that screen (only while a browser window has focus, so it can never stay behind as a stray window); where a browser cannot do that, such as Firefox, a welcome tab opens instead, shows only the connect step, confirms and closes itself. Reinstalling with a working key opens nothing.
- **Key management:** the popup's Settings has an account group: connected or not, paste a new key to replace it, remove it.
- **Models range:** the calendar month so far (UTC; exactly what the usage page on ollama.com shows), 7 days or 30 days, with a date caption and the total cost. All three come from the same daily data, so there is no extra request.
- **Recent activity** lists the last 24 hours by hour and the last 14 days by day (the API has no per-request detail).
- **Activity** is exact: hourly for the last 24 hours and daily for 30 days, so the month heatmap is complete from the first refresh. Cells that were never recorded (before the extension started, or while the browser was closed for more than a day) are hatched instead of looking like zero requests.
- **Number fields** have their own "-" and "+" buttons, the same in every browser and kept out of the Tab order (the field keeps the arrow keys), instead of the native spin buttons.
- **Notifications:** a toast shown under the same id is cleared first (Windows can update such a toast silently instead of popping it up); "Send test" uses a fresh id on every click and says where to look when nothing shows.
- **Accessibility:** text and badge colors meet WCAG AA; `lang` on all extension pages; pressed state on the range toggles; the heatmap is hidden from assistive technology and replaced by a text summary.

### Added

- **Pay as you go:** the credits balance is the toolbar badge ("$18"; green, orange when the credits last the "Low credits" number of days or less at the recent pace (default 3, 0 = off), red once they ran out after having been there, neutral gray for an account that never had any). The popup says how many days they last. One alert fires when they drop to low and one when they run out, never at the first reading.
- **Included usage plus purchased credits:** the purchased credits take over (runway, badge colors, alerts) as soon as the included part is spent; an account with included usage and nothing bought shows no credits block instead of "No credits left". "Add credits" opens the dashboard, where credits are bought.
- **Robustness:** the last good numbers stay on screen (marked stale) when the API is briefly unreachable; a 429 is honoured (no requests until Retry-After has passed); the 30-day series is cached for 10 minutes (two calls per refresh instead of three); saving or removing the key during a refresh can no longer be overwritten by that refresh.
- **Which copy is this?** The settings show the version and either the build (commit, time) or, for an unpacked folder, when the browser loaded it, so a stale copy in one browser is easy to spot.
- **Keyboard:** an optional shortcut, Alt+Shift+U, opens the popup. A manual keyboard and screen-reader test script is in `docs/accessibility-testing.md`.
- **Website:** a screenshot carousel with an enlarged view that steps through the pictures in sync with it (arrows beside the picture, swipe, a fade; on small touch screens no arrows and no enlarged view, just swipe and the dots); WebP images; a browser FAQ; the privacy policy on the same page width as the home page.
- **Project:** `extension/`, `store/`, `landing/`, `docs/` layout; CI, release and Pages workflows with pinned actions and Dependabot; a Firefox build (`dist/firefox`, `npm run dev:firefox` keeps it in sync while you edit); `npm run a11y` (axe-core plus a real Tab-key pass over every page); Lighthouse on the built website in CI (accessibility, best practices and SEO must be 100, performance a median of three runs of at least 90); a type check (`npm run typecheck`); a browser smoke test; LF line endings everywhere.

### Removed

- HTML parsing, the per-request "Recent requests" list and the model colors read from the page (a small table of observed colors plus a hash fallback remains, decorative only).

## [1.1.0] - 2026-11-03

- Adapted to Ollama's new billing (included usage and credits instead of session / weekly windows).
- Model donut, activity heatmap, peak / off-peak banner, usage alerts with thresholds, "Send test" notification, single-ring toolbar icon with percentage badge.
- Tests and MIT license.

## [1.0.0]

- First version: session and weekly usage from the settings page.

[1.2.0]: https://github.com/olaf-wilkosz/usage-tracker-for-ollama-cloud/compare/4b88fd1...v1.2.0
[1.1.0]: https://github.com/olaf-wilkosz/usage-tracker-for-ollama-cloud/commit/4b88fd1
