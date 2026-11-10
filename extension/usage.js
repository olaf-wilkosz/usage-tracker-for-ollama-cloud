/**
 * Shared helpers for the usage data model and its formatting. Used by the background worker
 * and the popup. See ollama-api.js for how the data is built from the Ollama API.
 *
 * Usage data shape (stored under "ollamaUsageData"):
 *   { status, meters: [{ id, label, usedPercent, detail, resetsAt, resetVerb }],
 *     credits: { amount, text, perDay?, runwayDays? } | null,
 *     modelsByRange: { month|7d|30d: { from, to, models: [{ model, requests, cost }] } },
 *     recentHours: [{ from, requests, cost, models: [{ model, requests }] }],
 *     recentDays: [{ date, requests, cost, models: [{ model, requests }] }],
 *     lastFetch, stale? }
 */

/**
 * Result with no data, for error / not-connected states.
 * @param {string} status
 */
export function emptyUsage(status) {
  return { status, meters: [], credits: null, modelsByRange: {}, recentHours: [], recentDays: [] };
}

/**
 * Seconds from now until an ISO timestamp (negative when it is in the past).
 * @param {string} isoString
 * @param {number} [now]
 * @returns {number|null}
 */
export function secondsUntil(isoString, now = Date.now()) {
  if (!isoString) return null;
  const ms = Date.parse(isoString);
  return isNaN(ms) ? null : Math.round((ms - now) / 1000);
}

/**
 * Format seconds into a short human-readable string like "3h 14m".
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatResetTime(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) {
    return 'unknown';
  }
  if (seconds < 0) return 'resetting...';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

/**
 * Icon / text color for a usage percentage.
 * @param {number|null} percent
 * @returns {string} CSS color
 */
export function getBadgeColor(percent) {
  if (percent === null) return '#666'; // gray for unknown
  if (percent >= 90) return '#d32f2f'; // red
  if (percent >= 70) return '#f57c00'; // orange/yellow
  return '#388e3c'; // green
}

/**
 * Text color for a usage percentage on the dark cards (WCAG AA, >= 4.5:1 on #232428). The
 * plain getBadgeColor shades are for graphics (rings, bars), which only need 3:1.
 * @param {number|null} percent
 * @returns {string} CSS color
 */
export function getTextColor(percent) {
  if (percent === null) return '#9b9ba3';
  if (percent >= 90) return '#ff6f61';
  if (percent >= 70) return '#ffa726';
  return '#66bb6a';
}

/**
 * Toolbar badge colors for a usage percentage: background plus a text color that reads on it
 * (>= 4.5:1; white on orange would not, so orange gets dark text).
 * @param {number|null} percent
 * @returns {{color: string, textColor: string}}
 */
export function getBadgeStyle(percent) {
  if (percent === null) return { color: '#5f6368', textColor: '#ffffff' };
  if (percent >= 90) return { color: '#c62828', textColor: '#ffffff' };
  if (percent >= 70) return { color: '#f57c00', textColor: '#1a1a1a' };
  return { color: '#2e7d32', textColor: '#ffffff' };
}

/**
 * Short dollar text for the toolbar badge (about four characters): "$0", "$5.4", "$125", "$2k".
 * @param {number} amount
 */
export function formatBadgeAmount(amount) {
  if (!(amount > 0)) return '$0';
  if (amount < 10) return `$${(Math.floor(amount * 10) / 10).toFixed(1)}`;
  if (amount < 1000) return `$${Math.floor(amount)}`;
  return `$${Math.min(99, Math.floor(amount / 1000))}k`;
}

/**
 * Badge colors for a credits balance. Green while the credits last; orange when they will
 * last `lowDays` or less at the recent pace; red when they ran out after having been there;
 * neutral gray for an account that never had any (that is a state, not an alarm).
 * @param {{amount: number, runwayDays?: number|null, lowDays: number, hadCredits: boolean}} state
 */
export function getCreditsBadgeStyle({ amount, runwayDays = null, lowDays, hadCredits }) {
  if (!(amount > 0)) return hadCredits ? { color: '#c62828', textColor: '#ffffff' } : { color: '#5f6368', textColor: '#ffffff' };
  if (lowDays > 0 && runwayDays !== null && runwayDays <= lowDays) return { color: '#f57c00', textColor: '#1a1a1a' };
  return { color: '#2e7d32', textColor: '#ffffff' };
}

/** "less than a day", "1 day", "12 days", "90+ days" for a number of days of credits left. */
export function formatRunway(days) {
  if (days < 1) return 'less than a day';
  if (days < 2) return '1 day';
  if (days >= 90) return '90+ days';
  return `${Math.round(days)} days`;
}

/**
 * Dollar amount for display: "$1.94", "$0" for nothing, "<$0.01" for a fraction of a cent.
 * @param {number|null|undefined} amount
 * @returns {string}
 */
export function formatUsd(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '';
  if (amount === 0) return '$0';
  if (amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}
