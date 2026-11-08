# Store listing (English)

Texts to paste into the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons forms.
Character limits are checked by `npm run check` for the manifest fields.

## Name

Usage Tracker for Ollama Cloud

## Summary (max 132 characters; this is also the manifest `description`)

Unofficial usage tracker for Ollama Cloud: credits, models and activity at a glance. No telemetry. Not affiliated with Ollama.

## Category

Productivity (Chrome Web Store) / Developer Tools (Edge, Firefox)

## Detailed description

Keep an eye on your Ollama Cloud usage without opening a single web page.

Usage Tracker for Ollama Cloud puts your usage in the toolbar: a ring and a percentage that turn orange and then red as you approach your limit, and a popup with everything else.

WHAT YOU GET
• Live toolbar badge with your included usage in percent
• Included credits (what is left, when it refills) and purchased credits
• Models breakdown for the last 30 days: requests, share and cost per model
• Recent activity by hour, plus an activity heatmap (last week by hour, last 30 days by day)
• Alerts at a warning and a critical threshold you choose: one notification per cycle, no nagging
• Peak / off-peak pricing banner based on Ollama's published schedule
• Dark, accessible interface (text contrast meets WCAG AA)

HOW IT WORKS
The extension uses the official Ollama API with an API key from your own account. Setup takes a minute: create a key at ollama.com/settings/keys, paste it into the extension popup, done. Because it uses the documented API instead of reading web pages, it keeps working when ollama.com changes.

PRIVATE BY DESIGN
• The only server it contacts is ollama.com (read-only requests, no cookies)
• No analytics, no telemetry, no servers of ours
• Your API key is stored encrypted on your device and is never shown again
• Only three permissions: storage, alarms and notifications
• Free and open source (MIT): https://github.com/olaf-wilkosz/usage-tracker-for-ollama-cloud

GOOD TO KNOW
Ollama API keys can't be limited to read-only, so treat yours like a password; you can remove it from the extension in one click and revoke it at ollama.com/settings/keys.

This is an independent project. It is not affiliated with, endorsed by or sponsored by Ollama.

## Single purpose (Chrome Web Store)

Show the user's own Ollama Cloud usage and credits (read from the official Ollama API) in the browser toolbar and popup, and notify them when usage crosses thresholds they set.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `storage` | Stores the encrypted API key, the latest usage data, the activity history for the heatmap (up to 35 days) and the user's settings, locally in the browser. |
| `alarms` | Refreshes the usage data in the background on the interval the user chooses (1, 5 or 15 minutes). |
| `notifications` | Shows the usage alerts the user enables (warning / critical threshold) and the "Send test" notification. |
| Host `https://ollama.com/api/*` | Calls the official Ollama API (`/api/balance` and `/api/usage`) with the user's API key. No other host is contacted. |

No remote code is used: every script is bundled in the package, and no `eval`, remote scripts or dynamic code loading is present (`npm run check` enforces this).

## Data usage disclosures (Chrome Web Store privacy tab)

- Data handled: **authentication information** (the user's Ollama API key). Handled locally, sent only to ollama.com for the extension's single purpose.
- Not collected: personally identifiable information, health, financial and payment information, personal communications, location, web history, user activity, website content.
- Certify: data is not sold, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.
- Privacy policy URL: https://olaf-wilkosz.github.io/usage-tracker-for-ollama-cloud/privacy.html

## Firefox Add-ons notes

- Add-on id: `usage-tracker-for-ollama-cloud@olaf-wilkosz.github.io` (set by `scripts/build.mjs`).
- `data_collection_permissions.required` is `["authenticationInfo"]` (the API key goes to ollama.com). Re-check against Mozilla's current guidance at submission time.
- Source code submission: the repository as is; there is no minification or bundling, so `git archive` of the tag is the source.
- Reviewer notes: "The extension needs an Ollama API key to show data; a made-up key is rejected by Ollama, so please use your own key or review the code paths via the unit tests. No remote code, no bundler."

## Assets

| Asset | File | Size |
| --- | --- | --- |
| Icon | `extension/icons/icon128.png` | 128x128 |
| Screenshots | `store/screenshots/01-overview.png` ... `05-private.png` | 1280x800 |
| Small promo tile | `store/promo/small-440x280.png` | 440x280 |
| Marquee promo tile | `store/promo/marquee-1400x560.png` | 1400x560 |

Screenshots show sample data and are rendered from the real popup with `npm run render`.
