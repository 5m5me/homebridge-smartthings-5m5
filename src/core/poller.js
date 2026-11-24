const WARN_INTERVAL_MS = 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class Poller {
  constructor({
    client,
    onSnapshot,
    onError = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
    log,
  }) {
    this.client = client;
    this.onSnapshot = onSnapshot;
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.log = log;
    this.entries = new Map();
    this.running = false;
  }

  add(deviceId, intervalMs) {
    if (this.entries.has(deviceId)) return;
    this.entries.set(deviceId, {
      intervalMs,
      timer: null,
      inflight: null,
      lastStatus: undefined,
      lastWarnAt: null,
      failures: 0,
    });
    if (this.running) this.pollNow(deviceId);
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const deviceId of this.entries.keys()) this.pollNow(deviceId);
  }

  stop() {
    this.running = false;
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) this.clearTimer(entry.timer);
      entry.timer = null;
    }
  }

  pollNow(deviceId) {
    const entry = this.entries.get(deviceId);
    if (!entry) return Promise.resolve();
    if (entry.inflight) return entry.inflight;
    if (entry.timer !== null) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
    entry.inflight = this.#poll(deviceId, entry).finally(() => {
      entry.inflight = null;
      if (this.running) {
        entry.timer = this.setTimer(() => {
          entry.timer = null;
          this.pollNow(deviceId);
        }, this.#delay(entry));
      }
    });
    return entry.inflight;
  }

  #delay(entry) {
    if (entry.failures === 0) return entry.intervalMs;
    return Math.max(entry.intervalMs, Math.min(entry.intervalMs * 2 ** entry.failures, MAX_BACKOFF_MS));
  }

  async #poll(deviceId, entry) {
    try {
      const health = await this.client.getHealth(deviceId);
      const online = health === 'ONLINE';
      if (online) entry.lastStatus = await this.client.getStatus(deviceId);
      this.onSnapshot(deviceId, { status: entry.lastStatus ?? {}, online });
      entry.failures = 0;
    } catch (error) {
      entry.failures = Math.min(entry.failures + 1, 20);
      this.#warn(deviceId, entry, error);
      try {
        this.onError(deviceId, error);
      } catch {
        // A throwing error handler must not break the polling loop.
      }
    }
  }

  #warn(deviceId, entry, error) {
    const t = this.now();
    if (entry.lastWarnAt !== null && t - entry.lastWarnAt < WARN_INTERVAL_MS) return;
    entry.lastWarnAt = t;
    this.log?.warn?.(`Poll failed for device ${deviceId}: ${error?.message ?? error}`);
  }
}
