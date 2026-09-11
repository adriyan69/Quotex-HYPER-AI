/**
 * AlertManager — decides WHETHER a signal is worth interrupting the user
 * for. Deliberately has no DOM/Notification/Audio dependency, so its
 * dedup/cooldown logic is plain, testable state machine code; the actual
 * notification/sound/animation triggering lives in app.js (UI thread only).
 *
 * Rules (Section 10 of the original spec: "Do NOT spam notifications. Add
 * a cooldown period."):
 *  - Only STRONG_BUY / BUY / SELL / STRONG_SELL are alert-worthy — WAIT and
 *    NO_TRADE never alert.
 *  - The signal strength must clear `minStrength` (default 70) — a weak
 *    BUY/SELL isn't a "high-quality setup."
 *  - A minimum cooldown (default 60s) applies between ANY two alerts,
 *    regardless of direction — a hard rate limit.
 *  - Once alerted for a given state, that same state won't alert again
 *    until the signal leaves the alert-worthy zone (WAIT/NO_TRADE, or the
 *    opposite direction) and re-enters it — so a signal sitting on
 *    "STRONG_BUY" for 10 straight ticks fires exactly one alert, not 10.
 */
export class AlertManager {
  constructor(options = {}) {
    this.minStrength = options.minStrength ?? 70;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.lastAlertAt = 0;
    this.lastAlertedState = null;
    this.inAlertZone = false;
  }

  /**
   * @param {{signalState: string, strength: number, timestamp: string}} payload
   * @returns {boolean} true if this payload should trigger an alert (and,
   *   if true, records that an alert was just fired — call this at most
   *   once per payload).
   */
  shouldAlert(payload) {
    const alertWorthy = ['STRONG_BUY', 'BUY', 'SELL', 'STRONG_SELL'].includes(payload.signalState);

    if (!alertWorthy) {
      this.inAlertZone = false;
      this.lastAlertedState = null;
      return false;
    }

    if (payload.strength < this.minStrength) {
      return false;
    }

    // Already alerted for this exact state since the last time we left the
    // alert-worthy zone — don't repeat every tick.
    if (this.inAlertZone && this.lastAlertedState === payload.signalState) {
      return false;
    }

    const now = Date.parse(payload.timestamp) || Date.now();
    if (now - this.lastAlertAt < this.cooldownMs) {
      return false;
    }

    this.lastAlertAt = now;
    this.lastAlertedState = payload.signalState;
    this.inAlertZone = true;
    return true;
  }
}
