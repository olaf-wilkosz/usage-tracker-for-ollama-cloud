/**
 * Peak / off-peak pricing window, per ollama.com/pricing: "Off-peak pricing apply outside
 * 12:00 and 18:00 UTC on weekdays and all day on weekends". Computed locally from the clock -
 * this is the published pricing schedule, not data read from the user's account.
 */

const PEAK_START_HOUR_UTC = 12;
const PEAK_END_HOUR_UTC = 18;
const MAX_LOOKAHEAD_HOURS = 24 * 8;

/**
 * @param {Date} date
 * @returns {boolean} true if `date` falls in the peak window (weekdays, 12:00-18:00 UTC)
 */
export function isPeakAt(date) {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return hour >= PEAK_START_HOUR_UTC && hour < PEAK_END_HOUR_UTC;
}

/**
 * Current pricing period and time until it flips.
 * @param {Date} [now]
 * @returns {{isPeak: boolean, secondsToChange: number}}
 */
export function getPeakStatus(now = new Date()) {
  const isPeak = isPeakAt(now);

  // Boundaries are whole UTC hours, so step hour by hour from the next full hour
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);

  for (let i = 0; i < MAX_LOOKAHEAD_HOURS; i++) {
    if (isPeakAt(next) !== isPeak) {
      return { isPeak, secondsToChange: Math.round((next - now) / 1000) };
    }
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return { isPeak, secondsToChange: MAX_LOOKAHEAD_HOURS * 3600 };
}
