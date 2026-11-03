# Store submission

Everything needed to publish lives here and is produced by scripts, so a release is repeatable.

| What | Where |
| --- | --- |
| Texts, permission justifications, data disclosures | [listing.md](listing.md) |
| Screenshots (1280x800) | `screenshots/` |
| Promo tiles (440x280, 1400x560) | `promo/` |
| Sources of the images above (HTML) | `slides/`, `promo/*.html` |

Re-render the images after UI changes: `npm run render` (uses an installed Edge, Chrome or Brave).

## Checklist for a release

1. `npm test && npm run check` pass; `npm run smoke -- <path to Edge or Brave>` passes.
2. Version bumped in `extension/manifest.json` and `package.json`; `CHANGELOG.md` updated.
3. Tag pushed (`vX.Y.Z`): the release workflow attaches `-chrome.zip` and `-firefox.zip` to a GitHub Release.
4. **Chrome Web Store** (developer dashboard): upload the `-chrome.zip`; paste texts from `listing.md`; privacy tab: single purpose, permission justifications, data disclosures, privacy policy URL; add screenshots and promo tiles; submit for review.
5. **Edge Add-ons** (Partner Center): the same `-chrome.zip`.
6. **Firefox Add-ons** (AMO): upload the `-firefox.zip` (listed channel), attach the source (`git archive`), paste the reviewer notes.
7. After approval, put the store links in `landing/index.html` and `README.md` (the buttons currently point to GitHub Releases).

## Before the very first submission

- [ ] Replace the GitHub-issues contact with a support e-mail if you want one (privacy policy, store developer contact).
- [ ] Ask Ollama (optional, courtesy) whether they are fine with the name "Usage Tracker for Ollama Cloud"; the listing already says "unofficial / not affiliated".
- [ ] Test on a paid plan if you have access: the standard-plan and legacy shapes follow the official docs but were only verified against a Free account.
- [ ] Load the Firefox build once via `about:debugging` and run through the setup flow.
