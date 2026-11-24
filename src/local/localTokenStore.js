import fs from 'node:fs';

export class LocalTokenStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  get(ip) {
    const v = this._read()[ip];
    return typeof v === 'string' ? v : undefined;
  }

  set(ip, token) {
    const data = this._read();
    data[ip] = token;
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
