/**
 * Colors for the per-model usage breakdown (segmented bar + list swatches).
 *
 * KNOWN_MODEL_COLORS are colors actually observed on ollama.com/settings (verified via
 * getComputedStyle + the raw inline `style="background: #hex"` attribute on
 * [data-usage-segment] buttons and the "Models used this week" swatch dots, 2026-09-01,
 * free tier). Confirmed hardcoded server-side, not computed by any client-side JS (the page
 * ships no color-generating code) - so there is no formula to replicate, only these observed
 * values. The same model gets the same color in the session bar, the weekly bar, and the
 * weekly model list.
 *
 * `gpt-oss:20b` was not directly observed but is assumed to share `gpt-oss:120b`'s color,
 * since every other size/variant within an observed family (the three nemotron-3-* models)
 * shared one color regardless of size.
 *
 * Anything not in this table (a model Ollama adds later, or a paid-tier model never seen)
 * falls back to a locally-generated color - NOT verified against Ollama's real color, just a
 * stable, distinct-looking placeholder so the UI still reads sensibly.
 */
const KNOWN_MODEL_COLORS = {
  'nemotron-3-ultra': '#76b900',
  'nemotron-3-super': '#76b900',
  'nemotron-3-nano:30b': '#76b900',
  'gemma4:31b': '#22c55e',
  'gpt-oss:120b': '#525252',
  'gpt-oss:20b': '#525252', // inferred, not directly observed - see module doc above
  'web search': '#3b82f6'
};

const FALLBACK_PALETTE = ['#e0b400', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#14b8a6'];

/**
 * Get a display color for a model name: the real Ollama color if known, otherwise a
 * deterministic (hash-based) fallback so an unknown model still gets a stable color.
 * @param {string} model
 * @returns {string} CSS color
 */
export function modelColor(model) {
  if (KNOWN_MODEL_COLORS[model]) return KNOWN_MODEL_COLORS[model];

  let hash = 0;
  for (let i = 0; i < model.length; i++) {
    hash = (hash * 31 + model.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}
