/**
 * Colors for the per-model breakdown (donut, list swatches). Decorative: every model is also
 * named in text, so the color is never the only carrier of information.
 *
 * KNOWN_MODEL_COLORS are the colors ollama.com paints these models with on its own usage page
 * (observed on ollama.com/settings, 2026-09, free tier; hardcoded server-side, no formula),
 * so the popup looks familiar. The official API provides no colors, so any other model gets a
 * stable, distinct-looking color derived from its name - NOT Ollama's color for it.
 *
 * `gpt-oss:20b` was not directly observed but is assumed to share `gpt-oss:120b`'s color,
 * since every other size/variant within an observed family shared one color.
 */
const KNOWN_MODEL_COLORS = {
  'nemotron-3-ultra': '#76b900',
  'nemotron-3-super': '#76b900',
  'nemotron-3-nano:30b': '#76b900',
  'gemma4:31b': '#22c55e',
  'gpt-oss:120b': '#525252',
  'gpt-oss:20b': '#525252', // inferred, not directly observed - see module doc above
  'web_search': '#3b82f6'
};

const FALLBACK_PALETTE = ['#e0b400', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#14b8a6'];

/**
 * Get a display color for a model name: the color seen on ollama.com (table above), else a
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
