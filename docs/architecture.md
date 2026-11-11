# Architecture and decisions

## Data flow

```
alarm / popup refresh button / browser start
        |
        v
background.js (service worker; event page on Firefox)
  1. openSecret()      decrypt the API key (secret-store.js)
  2. fetchApiData()    GET /api/balance, /api/usage?range=24h, /api/usage?range=30d  (ollama-api.js)
  3. buildUsage()      -> { status, meters[], credits, models[], recentHours[] }
  4. storage.local     ollamaUsageData, ollamaActivity (hours + days), ollamaDiagnostics
  5. updateBadge()     toolbar ring(s), percentage badge, tooltip
  6. notifications     once per meter per cycle; escalation warning -> critical
        |
        v   storage.onChanged
popup.js renders what is stored; it never talks to Ollama itself
```

The popup and the options page only exchange messages with the worker (`GET_USAGE_DATA`, `SAVE_API_KEY`, ...). The API key exists in plain text only inside the worker, only while a request is being made.

### Request budget

The API allows 10 requests per minute per user, shared across keys and devices. A refresh makes three calls, but the 30-day series is reused for 10 minutes (it only moves a little within the day), so the steady state is two calls per refresh. A 429 stores `ollamaBackoffUntil` from `Retry-After` (capped at 10 minutes) and no request is made before then; the last good numbers stay on screen, marked stale.

Saving or removing the key bumps an epoch counter; a refresh that was reading with the old key notices and starts over, so its stale result can never overwrite the new state.

### Usage data model

`status` is one of `ok`, `no_key`, `auth_required` (401), `forbidden` (403), `rate_limited` (429), `network_error`, `api_error` (response did not match the documented schema). Transient failures (`network_error`, `rate_limited`, `api_error`) keep the previous numbers and set `stale: true`; `no_key` / `auth_required` / `forbidden` clear them.

`meters[]` is generic on purpose: standard plans produce one meter (`included`, from `allowance_usd` and `balance_usd`, resets at `period.until`); legacy plans produce `session` and `weekly`. An account without included credits (pay as you go) produces no meter, only `credits`.

### Models ranges

`modelsByRange` has three entries `{ from, to, models }`, all from the one 30-day response (daily buckets start at 00:00 UTC, so each range is exact): `month` = the buckets from the 1st of the current UTC month (what ollama.com's usage page shows: "Nov 1–8, UTC", verified on a real account: 95 requests, $0.26), `7d` = the last 8 buckets (what the API's own `range=7d` returns) and `30d` = the response totals. No extra request is needed. The popup defaults to the month.

### Pay as you go

Ollama dropped the Free plan with included usage in November 2026: an account without a plan has `included.allowance_usd = 0` (or no `included` block), so there is no meter and the purchased credits are the only number. For such accounts the toolbar shows the balance as the badge ("$18"), the popup says how long it lasts at the recent pace (last 7 UTC days plus today so far) and `trackCredits` / `notifyCredits` alert once when it gets worse. "Low" is relative to the pace, not a dollar amount, because a fixed dollar level means something different on a $10 top-up than on $300: low = the credits last `lowCreditsDays` (default 3, 0 = off) or less; "empty" = nothing left. The badge is orange when low, green otherwise, red when empty after there had been credits (`hadCredits`), and neutral gray for an account that never had any, because that is a state rather than an alarm. Nothing is announced at the first reading, and a level that was already reported is not repeated until the balance has been better again. With included credits (Pro, Max, Team) none of this applies: the pace says nothing about the purchased part, which is used second.

### Activity

`covered` lists the hour ranges the extension has actually read (merged on every refresh; a gap appears when the browser was closed for more than a day) and `daysFrom` the first day of the 30-day series. The heatmap hatches cells outside them: "not recorded yet" is different from "zero requests".


- `hours`: requests per local hour, taken from the 24h response (hourly buckets). The API gives no hourly detail beyond 24h, so the week heatmap fills as the browser keeps running.
- `days`: requests per day for 30 days from the 30d response (days start at 00:00 UTC), so the month view is complete from the first refresh. A day shows the larger of the daily total and the sum of its hours.
- Entries older than 35 days are pruned.

## API key storage

Ollama API keys have no scopes, so the key is as powerful as the account's ability to run models. Decisions:

- **Where**: `chrome.storage.local`, never `sync`, never `localStorage`, never in the page DOM after saving.
- **Sealed at rest**: AES-256-GCM. The AES key is generated with `extractable: false` and kept in the extension's own IndexedDB; only `secret-store.js` uses it. A copied `storage.local` file, a profile backup or a storage dump contains only ciphertext.
- **Not a defence against** malware that runs as the user with the whole profile: it could drive the extension's own code. No browser extension can protect against that, and the docs do not claim otherwise.
- **No PIN**: a PIN would stop background tracking after every browser restart until it is typed again, which defeats the purpose of a passive tracker. If demand appears, a PIN mode can be an opt-in (the key would live in `storage.session` after unlock).
- **Validated before saving**: the key is checked with `GET /api/balance`; a rejected key is never stored.
- **Never leaves the worker**: not echoed in responses, not logged, not part of diagnostics (which contain only API response bodies).
- **Removal**: "Remove key" deletes the sealed blob, the sealing key and derived data; "Clear All Local Data" wipes everything.

## Why the official API (and not the settings page)

Early versions read `ollama.com/settings` with the user's session cookies and parsed the HTML. That was replaced because:

1. Ollama's terms forbid automated access to the service without permission; the documented API is the sanctioned route.
2. HTML parsing broke whenever the page changed (it did, with the new billing).
3. It needed the `offscreen` permission (DOMParser) and broad host access with cookies.
4. The API documents the paid-plan shapes too, which a developer on a pay-as-you-go account could never test against the page.

Trade-offs accepted: the user must create an API key; per-request detail (the old "Recent requests" table) is gone in favour of hourly buckets; model colors are no longer read from the page (a small table of observed colors plus a hash fallback, decorative only).

## First run

On install without a working key the worker opens the toolbar popup itself (`chrome.action.openPopup({ windowId })`) on the "paste your key" screen - but only while a browser window has focus (`windows.getLastFocused().focused`). A popup opened in an unfocused window never gets the blur that closes it and stays on screen (seen in Brave). A standalone popup window was tried too and rejected: it is a second browser window the user has to close. Where the popup cannot be opened (Firefox without a click, no focused window, an older browser) the options page opens as a welcome tab: with no key it shows only the connect step; after connecting it shows a short confirmation and closes itself (`tabs.remove` of the current tab), or the user clicks "Open the settings instead". A reinstall that kept a working key opens nothing.

## One codebase, two browsers

`extension/` is the Chrome / Edge / Brave extension and loads unpacked there directly; its manifest is the clean Chrome one (a manifest carrying both `service_worker` and `scripts` was tried so Firefox could load the same folder, but Brave reports a warning for `background.scripts` in the Errors tab, which would greet every contributor). Firefox and Zen load `dist/firefox`: the same files with `background.scripts` (event page), the add-on id and the data-collection declaration (`npm run build`; `npm run dev:firefox` keeps the folder in sync while editing, in place, because a browser may have it loaded).

`extension/` is the source for Chrome, Edge, Brave and Firefox. `scripts/build.mjs` writes two thin manifests: Chrome keeps `background.service_worker`; Firefox gets `background.scripts` (event page, ES module), a gecko add-on id and `data_collection_permissions`. The code feature-detects the few differences (`notifications.getPermissionLevel` does not exist on Firefox).

## Accessibility

Text and badge colors are checked against WCAG AA (4.5:1) by a unit test (`test/ollama-api.test.js`, "accessibility"). `npm run a11y` runs axe-core (WCAG 2.0/2.1/2.2 A + AA and best practices) against every popup state, the options page and the website in a headless browser. The heatmap grid is `aria-hidden` and replaced by a text summary (total and busiest cell); toggles expose `aria-pressed`; native `<details>` provides the FAQ disclosure semantics. Screen-reader and keyboard flows still need an occasional manual pass. Ring and bar colors are graphics (3:1 needed, met). Heatmap cells and model swatches are decorative: values are always available as text or tooltips.

## Testing

- `node --test`: pure logic (API mapping, activity, settings, key sealing) and the service worker against stubbed `chrome.*` and a stubbed Ollama API, using real API responses as fixtures (`test/fixtures`).
- `npm run probe` (needs your API key in `OLLAMA_API_KEY`): prints what the API reports for your account and cross-checks it (buckets vs totals vs groups, one partial bucket, usage since the period began, with and without `web_search`), so numbers can be compared with ollama.com/settings without pasting raw JSON.
- `npm run smoke`: loads the unpacked extension into a real Chromium-based browser and drives the setup flow against the real Ollama API with a made-up key.
- Not covered automatically: Firefox, and paid-plan accounts (the API schemas are taken from the official documentation).
