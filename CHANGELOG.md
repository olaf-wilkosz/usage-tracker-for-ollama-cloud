# Changelog

## 1.2.0 (unreleased)

- **Data source:** the extension now uses the official Ollama API (`/api/balance`, `/api/usage`) with an API key from the user's own account, instead of reading `ollama.com/settings`. Setup page and in-popup setup prompt added.
- **Privacy:** API key encrypted at rest (AES-GCM, non-extractable key); host access narrowed to `https://ollama.com/api/*`; the `offscreen` permission is gone; requests carry no cookies.
- **Activity:** exact hourly activity for the last 24 h and daily totals for 30 days from the API (the month heatmap is complete from the first refresh); "Recent activity" lists the busiest recent hours.
- **Robustness:** last good numbers stay on screen (marked stale) when the API is briefly unreachable.
- **Accessibility:** text and badge colors meet WCAG AA.
- **Robustness:** a 429 is honoured (no requests until Retry-After has passed); the 30-day series is cached for 10 minutes (two calls per refresh instead of three); saving or removing the key during a refresh can no longer be overwritten by that refresh; the options page shows "Connected" only for a key Ollama accepts.
- **Models range:** 7 days (default, matches the usage page on ollama.com) or 30 days, derived from the same daily data, no extra request.
- **First run:** the setup step opens in the popup right after install where the browser allows it (otherwise a welcome tab that shows only the connect step, then confirms "You're all set" and what to do next).
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
