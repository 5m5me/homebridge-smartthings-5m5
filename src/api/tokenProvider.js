import fs from 'node:fs';
import { refreshTokens } from './oauth.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRES_IN_S = 3600;

export class TokenProvider {
  constructor({ accessToken, oauth, storagePath, fetchImpl = fetch, now = Date.now, log } = {}) {
    this.accessToken = accessToken;
    this.oauth = oauth;
    this.storagePath = storagePath;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.state = null; // { accessToken, refreshToken, expiresAt }
    this.loaded = false;
    this.pending = null;
  }

  async getToken() {
    if (this.oauth) return this.getOAuthToken();
    if (this.accessToken) return this.accessToken;
    throw new Error('No SmartThings credentials configured');
  }

  invalidate() {
    if (!this.oauth) return;
    this.load();
    if (this.state) this.state = { ...this.state, accessToken: undefined, expiresAt: 0 };
    else this.state = { refreshToken: this.oauth.refreshToken, accessToken: undefined, expiresAt: 0 };
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storagePath) return;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        this.state = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.log?.warn?.('Could not read stored SmartThings tokens; using configured credentials');
    }
  }

  isFresh() {
    const s = this.state;
    return Boolean(s && s.accessToken && s.expiresAt - this.now() >= REFRESH_MARGIN_MS);
  }

  async getOAuthToken() {
    this.load();
    if (this.isFresh()) return this.state.accessToken;
    if (!this.pending) {
      this.pending = this.refresh().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  async refresh() {
    const refreshToken = this.state?.refreshToken || this.oauth.refreshToken;
    const result = await refreshTokens({
      clientId: this.oauth.clientId,
      clientSecret: this.oauth.clientSecret,
      refreshToken,
      fetchImpl: this.fetchImpl,
    });
    const expiresIn = Number.isFinite(result.expiresIn) && result.expiresIn > 0 ? result.expiresIn : DEFAULT_EXPIRES_IN_S;
    const next = {
      accessToken: result.accessToken,
      refreshToken: typeof result.refreshToken === 'string' && result.refreshToken !== '' ? result.refreshToken : refreshToken,
      expiresAt: this.now() + expiresIn * 1000,
    };
    this.state = next;
    try {
      this.save(next);
    } catch {
      this.log?.warn?.('Could not save SmartThings tokens to disk');
      try {
        fs.rmSync(`${this.storagePath}.tmp`, { force: true });
      } catch {
        // ignore
      }
    }
    return next.accessToken;
  }

  save(state) {
    if (!this.storagePath) return;
    const tmp = `${this.storagePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.storagePath);
  }
}
