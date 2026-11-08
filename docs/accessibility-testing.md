# Accessibility: manual test script

`npm run a11y` (axe-core) catches structural problems: missing labels, roles, contrast of text, `lang`. It cannot tell whether the experience *makes sense* with a keyboard or a screen reader. This script covers that. Allow about 40 minutes; run it before a release that changes the UI.

**Setup**

- Browser: Brave or Chrome (and once in Zen / Firefox).
- Screen reader: [NVDA](https://www.nvaccess.org/download/) (free), or Narrator (`Win` + `Ctrl` + `Enter`). Start it before the browser steps that need it.
- Give the extension a keyboard shortcut if the build you test has none: `brave://extensions/shortcuts` / `chrome://extensions/shortcuts` / Zen: `about:addons` > gear > Manage Extension Shortcuts. Releases from 1.2.0 on suggest **Alt + Shift + U** ("Open the usage popup").
- Use sample state where it helps: `npm run preview` serves every popup state at `http://localhost:8765/popup?scenario=busy` (also `free`, `connect`, `badkey`, `offline`, `legacy`, `payg`; add `&pinned=1` to hide the pin hint, `&settings=1` for the settings view). The preview is a normal web page, so keyboard and screen reader behave the same as in the popup.

Mark each step: ✅ as expected, ⚠️ works but awkward (write down why), ❌ broken.

## 1. Keyboard only (put the mouse away)

| # | Do | Expected |
| --- | --- | --- |
| 1.1 | Press the shortcut (or open the extensions menu with `Tab` from the address bar and activate the extension). | The popup opens; focus lands inside it, not on the page behind. |
| 1.2 | **Setup state** (`scenario=connect`): focus on open. | Focus is in the key field. |
| 1.3 | `Tab` through the setup card. | Order: "Create an API key" link, key field, Connect, then the header buttons and footer. A visible focus ring on every stop (blue, at least 3:1 against the background). Nothing is skipped, nothing is a keyboard trap. |
| 1.4 | Type a bogus key, press `Enter`. | The button says "Checking...", then a red message appears and is announced (see 2.2). Focus stays where it was. |
| 1.5 | **Usage state** (`scenario=busy&pinned=1`): `Tab` from the top. | Refresh, Settings, then the toggles "Month / 7 days / 30 days", the "Recent activity" disclosure, "Week / Month", then the footer link. Non-interactive cards are not stops. |
| 1.6 | On the model range toggles press `Space` / `Enter`. | The donut and list change; the pressed button is clearly different (not by color alone); focus does not jump. |
| 1.7 | On "Recent activity" press `Enter` / `Space`. | It opens and closes; `Tab` then enters the list only if it has focusable items (it should not). |
| 1.8 | Open Settings with the gear, then press `Tab` through it. | The header icon turns into "Close settings"; the form fields come in reading order; `Enter` on "Save Settings" confirms with a visible message. |
| 1.9 | Close Settings with the same header button. | Focus stays on that button. |
| 1.10 | Press `Esc`. | The browser closes the popup (nothing in the extension should block it). |
| 1.11 | **Options page, first run** (`options?scenario=fresh`): `Tab` through. | Only the account section is present: the link, the field, Connect. No hidden stops, no settings below it. |
| 1.12 | **Website**: `Tab` from the top. | The first stop is "Skip to content" (visible when focused); FAQ items open with `Enter` / `Space`; every link has a focus ring. |

## 2. Screen reader (NVDA or Narrator)

| # | Do | Expected announcement |
| --- | --- | --- |
| 2.1 | Open the popup in the usage state. | The title "Usage Tracker for Ollama Cloud" is found; navigating by headings or regions reads the cards in order: pricing banner, included usage, purchased credits, models, recent activity, activity. |
| 2.2 | Trigger an error (bogus key in the setup state; or `scenario=offline`). | The message is announced without moving focus ("Ollama rejected this key...", "Could not reach the Ollama API..."). |
| 2.3 | Included usage card. | Reads as text: "Included usage, 70.0% used", then "$7.50 of $25.00 left · Refills in 19d 5h." The colored bar is not read (decorative). |
| 2.4 | Models card. | Heading "Models", the three range buttons with their pressed state ("Month, toggle button, pressed"), the caption ("Nov 1–8, UTC · $0.26"), the legend as a list: "nemotron-3-ultra, 65 requests · 30%". The donut is one image with a label ("217 requests by model"), not a pile of arcs. |
| 2.5 | Activity card. | The heatmap grid is **not** read cell by cell. Instead one sentence: "58 requests in the last 7 days. Busiest: Sat, Nov 7, 15:00, 4 requests." Changing Week / Month changes the sentence. |
| 2.6 | Pin hint (`scenario=free`). | "Pin it to the toolbar..." is read as a normal block; the close button is announced as "Dismiss the pin hint, button". |
| 2.7 | Settings: every field. | Each field has a spoken label ("Warning (%)", "Critical (%)", "Enable notifications", "Refresh interval"). |
| 2.8 | Options page after a successful connect (needs a real key). | "You're all set..." is announced when it appears. |
| 2.9 | Website FAQ. | Each question is announced as a collapsed / expanded button ("Is this an official Ollama product?, collapsed"). The decorative chevron is not read. |

## 3. Zoom, reflow, text size

| # | Do | Expected |
| --- | --- | --- |
| 3.1 | Website at 200 % and 400 % browser zoom (`Ctrl` + `+`). | No horizontal scrolling at 400 % (the layout becomes one column); nothing overlaps or is cut off. |
| 3.2 | Options page at 200 %. | Readable, the key field and button stay usable. |
| 3.3 | Browser setting "Font size: Very large" (Brave: `brave://settings/appearance`). | Popup text grows; the popup stays usable (it scrolls inside, the header and footer stay). |
| 3.4 | Text spacing bookmarklet or extension ("Text Spacing Editor") on the website. | No clipped or overlapping text. |

## 4. Windows contrast themes (forced colors)

Settings > Accessibility > Contrast themes > "Night sky" or "Desert", then reload the pages.

| # | Expected |
| --- | --- |
| 4.1 | The popup, options page and website stay readable; borders of cards, buttons and the key field are visible; links are distinguishable. |
| 4.2 | The pressed state of the range toggles is still visible (it must not depend on a background color that the theme removes). |
| 4.3 | Focus rings are visible. |

## 5. Motion

| # | Do | Expected |
| --- | --- | --- |
| 5.1 | Turn on "Show animations in Windows" = off (or `prefers-reduced-motion`). Open the website FAQ. | Items open instantly, the chevron does not animate. |
| 5.2 | The popup with reduced motion. | No slide-in or transitions beyond a plain state change. |

## 6. Color vision

| # | Do | Expected |
| --- | --- | --- |
| 6.1 | Browser DevTools > Rendering > "Emulate vision deficiencies" (protanopia, deuteranopia, achromatopsia) on the popup. | Usage level is readable from the **number** and the text ("70.0% used"), not only from green / orange / red; the donut legend names every model; heatmap values are in tooltips and in the text summary. |

## Findings log

Copy the table rows that failed into an issue: browser, screen reader, step number, what you heard or saw, what you expected.
