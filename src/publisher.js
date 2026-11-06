// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute (as the
// neighbour gladys-nasweb, same author, Apache-2.0).
//
// Keeps the LAST value of each feature with the wall time it was received,
// sends the pending ones every second within a per-minute budget and skips
// the unchanged ones (publishChangedStates). A value that waited longer
// than TIMINGS.live (budget, Gladys away), or that was received late, is
// sent with its date (`created_at`): never shown as new, never starting a
// scene as if it had just changed. Older than TIMINGS.maxAge: dropped.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = Date.now,
    clock,
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    /** Monotonic clock of the budget window. */
    this.clock = clock ?? now;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { value: { state } | { text }, at: wall ms of reception } */
    this.pending = new Map();
    /** send times (monotonic) of the last minute */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger?.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** A value received at `at` (wall ms); an older one never replaces a newer one. */
  push(featureId, value, at) {
    const current = this.pending.get(featureId);
    if (current && current.at > at) return;
    this.pending.set(featureId, { value, at });
  }

  clear() {
    this.pending.clear();
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const mono = this.clock();
    const now = this.now();
    this.window = this.window.filter((t) => mono - t < 60_000);
    let room = this.budget - this.window.length;
    if (room <= 0 || this.pending.size === 0) {
      return 0;
    }
    const batch = [];
    for (const [featureId, entry] of this.pending) {
      const age = now - entry.at;
      if (age > TIMINGS.maxAge) {
        this.pending.delete(featureId);
        continue;
      }
      if (room <= 0) break;
      this.pending.delete(featureId);
      const state = { device_feature_external_id: featureId, ...entry.value };
      if (age > TIMINGS.live) {
        state.created_at = new Date(entry.at).toISOString();
      }
      batch.push({ state, entry });
      room -= 1;
    }
    if (batch.length === 0) {
      return 0;
    }
    try {
      const result = await this.gladys.publishChangedStates(
        batch.map((b) => b.state),
        { heartbeat: TIMINGS.stateHeartbeat },
      );
      const count = Number.isInteger(result?.count) ? result.count : batch.length;
      for (let i = 0; i < count; i += 1) this.window.push(mono);
      return count;
    } catch (err) {
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const { state, entry } of batch) {
        const id = state.device_feature_external_id;
        if (!this.pending.has(id)) this.pending.set(id, entry);
      }
      throw err;
    }
  }
}
