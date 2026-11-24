import { API_BASE } from '../settings.js';

export class SmartThingsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SmartThingsError';
    this.status = status;
  }
}

const MAX_429_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 5;
const MAX_RETRY_AFTER_S = 60;
const MAX_PAGES = 50;

export class SmartThingsClient {
  constructor({
    tokenProvider,
    fetchImpl = fetch,
    baseUrl = API_BASE,
    minIntervalMs = 120,
    timeoutMs = 15000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    log,
  } = {}) {
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.now = now;
    this.log = log;
    this.queue = Promise.resolve();
    this.lastStart = 0;
  }

  async listDevices() {
    const devices = [];
    let url = `${this.baseUrl}/devices`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = await this.request('GET', url);
      devices.push(...(body.items ?? []));
      const next = body._links?.next?.href;
      if (!next) break;
      if (typeof next !== 'string' || !next.startsWith(this.baseUrl)) {
        this.log?.warn?.('Ignoring unexpected SmartThings paging link');
        break;
      }
      url = next;
      if (page === MAX_PAGES - 1) this.log?.warn?.('SmartThings paging limit reached');
    }
    return devices;
  }

  async getStatus(deviceId) {
    return this.request('GET', `${this.baseUrl}/devices/${deviceId}/status`);
  }

  async getHealth(deviceId) {
    const body = await this.request('GET', `${this.baseUrl}/devices/${deviceId}/health`);
    return body?.state === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
  }

  async sendCommands(deviceId, commands) {
    return this.request('POST', `${this.baseUrl}/devices/${deviceId}/commands`, { commands });
  }

  // Serialize requests: each runs only after the previous one has finished.
  request(method, url, body) {
    const run = () => this.execute(method, url, body);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async waitTurn() {
    const wait = this.lastStart + this.minIntervalMs - this.now();
    if (this.lastStart && wait > 0) await this.sleep(wait);
    this.lastStart = this.now();
  }

  async execute(method, url, body) {
    const path = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url;
    const pathOnly = path.split('?')[0];
    let retried401 = false;
    let retries429 = 0;
    for (;;) {
      await this.waitTurn();
      const token = await this.tokenProvider.getToken();
      const headers = { Authorization: `Bearer ${token}` };
      const init = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      let res;
      try {
        res = await this.fetchImpl(url, init);
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new SmartThingsError(`SmartThings ${method} ${pathOnly} timed out`, 0);
        }
        throw error;
      }
      if (res.ok) return res.json();
      if (res.status === 401 && !retried401) {
        retried401 = true;
        this.tokenProvider.invalidate();
        continue;
      }
      // A repeated POST could repeat a command, so never retry one.
      if (res.status === 429 && method !== 'POST' && retries429 < MAX_429_RETRIES) {
        retries429++;
        const header = Number(res.headers?.get?.('Retry-After'));
        const seconds = Number.isFinite(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_S;
        await this.sleep(Math.min(seconds, MAX_RETRY_AFTER_S) * 1000);
        continue;
      }
      throw new SmartThingsError(`SmartThings ${method} ${pathOnly} failed: HTTP ${res.status}`, res.status);
    }
  }
}
