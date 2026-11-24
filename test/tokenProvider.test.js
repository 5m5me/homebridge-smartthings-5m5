import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenProvider } from '../src/api/tokenProvider.js';

const OAUTH = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'cfg-refresh' };

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st5m5-'));
  return path.join(dir, 'tokens.json');
}

// Scripted fetch returning successive token responses.
function tokenFetch(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.status && r.status >= 400) return { ok: false, status: r.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  impl.calls = calls;
  return impl;
}

const tok = (n, expiresIn = 86400) => ({ access_token: `AT${n}`, refresh_token: `RT${n}`, expires_in: expiresIn });

test('PAT mode returns the token and never calls fetch', async () => {
  const f = tokenFetch([]);
  const tp = new TokenProvider({ accessToken: 'PAT', storagePath: tmpStorage(), fetchImpl: f });
  assert.equal(await tp.getToken(), 'PAT');
  assert.equal(f.calls.length, 0);
  tp.invalidate();
  assert.equal(await tp.getToken(), 'PAT');
  assert.equal(f.calls.length, 0);
});

test('no credentials throws', async () => {
  const tp = new TokenProvider({ storagePath: tmpStorage(), fetchImpl: tokenFetch([]) });
  await assert.rejects(tp.getToken(), { message: 'No SmartThings credentials configured' });
});

test('OAuth first call refreshes and writes all three fields', async () => {
  const storagePath = tmpStorage();
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000 });
  assert.equal(await tp.getToken(), 'AT1');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].init.body.includes('refresh_token=cfg-refresh'));
  const saved = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  assert.deepEqual(saved, { accessToken: 'AT1', refreshToken: 'RT1', expiresAt: 1_000_000 + 86400 * 1000 });
  assert.ok(!fs.existsSync(storagePath + '.tmp'));
});

test('second call within validity makes no request', async () => {
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath: tmpStorage(), fetchImpl: f, now: () => 1_000_000 });
  await tp.getToken();
  assert.equal(await tp.getToken(), 'AT1');
  assert.equal(f.calls.length, 1);
});

test('refreshes when expiresAt - now is under 5 minutes', async () => {
  let t = 1_000_000;
  const f = tokenFetch([tok(1, 3600), tok(2, 3600)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath: tmpStorage(), fetchImpl: f, now: () => t });
  assert.equal(await tp.getToken(), 'AT1');
  t += 3600 * 1000 - 5 * 60 * 1000 - 1; // just over 5 minutes of validity left
  assert.equal(await tp.getToken(), 'AT1');
  assert.equal(f.calls.length, 1);
  t += 2; // now under 5 minutes left
  assert.equal(await tp.getToken(), 'AT2');
  assert.equal(f.calls.length, 2);
});

test('the rotated refresh token is used next time', async () => {
  const f = tokenFetch([tok(1), tok(2)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath: tmpStorage(), fetchImpl: f, now: () => 1 });
  await tp.getToken();
  tp.invalidate();
  await tp.getToken();
  assert.ok(f.calls[0].init.body.includes('refresh_token=cfg-refresh'));
  assert.ok(f.calls[1].init.body.includes('refresh_token=RT1'));
});

test('a stored refresh token wins over config on a fresh instance', async () => {
  const storagePath = tmpStorage();
  fs.writeFileSync(storagePath, JSON.stringify({ accessToken: 'OLD', refreshToken: 'stored-refresh', expiresAt: 0 }));
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000 });
  assert.equal(await tp.getToken(), 'AT1');
  assert.ok(f.calls[0].init.body.includes('refresh_token=stored-refresh'));
  assert.ok(!f.calls[0].init.body.includes('cfg-refresh'));
});

test('a valid stored access token is used without a request', async () => {
  const storagePath = tmpStorage();
  fs.writeFileSync(storagePath, JSON.stringify({ accessToken: 'STORED', refreshToken: 'sr', expiresAt: 10_000_000 }));
  const f = tokenFetch([]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000 });
  assert.equal(await tp.getToken(), 'STORED');
  assert.equal(f.calls.length, 0);
});

test('two concurrent getToken calls make one request', async () => {
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath: tmpStorage(), fetchImpl: f, now: () => 1 });
  const [a, b] = await Promise.all([tp.getToken(), tp.getToken()]);
  assert.equal(a, 'AT1');
  assert.equal(b, 'AT1');
  assert.equal(f.calls.length, 1);
});

test('invalidate forces a refresh', async () => {
  const f = tokenFetch([tok(1), tok(2)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath: tmpStorage(), fetchImpl: f, now: () => 1 });
  assert.equal(await tp.getToken(), 'AT1');
  tp.invalidate();
  assert.equal(await tp.getToken(), 'AT2');
  assert.equal(f.calls.length, 2);
});

test('a failed refresh rejects and leaves the file unchanged', async () => {
  const storagePath = tmpStorage();
  const original = JSON.stringify({ accessToken: 'OLD', refreshToken: 'stored-refresh', expiresAt: 0 });
  fs.writeFileSync(storagePath, original);
  const f = tokenFetch([{ status: 400 }]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000 });
  await assert.rejects(tp.getToken(), { message: 'SmartThings token request failed: HTTP 400' });
  assert.equal(fs.readFileSync(storagePath, 'utf8'), original);
  assert.ok(!fs.existsSync(storagePath + '.tmp'));
});

test('an unwritable storage path still returns the new token and keeps it in memory', async () => {
  const storagePath = path.join(tmpStorage(), 'missing-dir', 'tokens.json');
  const warnings = [];
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({
    oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000, log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(await tp.getToken(), 'AT1');
  assert.equal(await tp.getToken(), 'AT1');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(warnings, ['Could not save SmartThings tokens to disk']);
  assert.ok(!fs.existsSync(storagePath + '.tmp'));
});

test('a failed save removes a leftover tmp file', async () => {
  const storagePath = tmpStorage();
  fs.mkdirSync(storagePath); // renaming a file over a directory fails
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1, log: { warn() {} } });
  assert.equal(await tp.getToken(), 'AT1');
  assert.ok(!fs.existsSync(storagePath + '.tmp'));
});

test('a refresh response without a refresh token keeps the previous one', async () => {
  const f = tokenFetch([tok(1), { access_token: 'AT2', expires_in: 3600 }, tok(3)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath: tmpStorage(), fetchImpl: f, now: () => 1 });
  await tp.getToken();
  tp.invalidate();
  assert.equal(await tp.getToken(), 'AT2');
  tp.invalidate();
  await tp.getToken();
  assert.ok(f.calls[1].init.body.includes('refresh_token=RT1'));
  assert.ok(f.calls[2].init.body.includes('refresh_token=RT1'));
});

test('missing or invalid expiresIn is treated as 3600 seconds', async () => {
  for (const bad of [undefined, 0, -5, 'abc', NaN]) {
    const storagePath = tmpStorage();
    const f = tokenFetch([{ access_token: 'AT1', refresh_token: 'RT1', expires_in: bad }]);
    const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000 });
    await tp.getToken();
    assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).expiresAt, 1_000_000 + 3600 * 1000, String(bad));
  }
});

test('invalidate before the first getToken uses the stored refresh token', async () => {
  const storagePath = tmpStorage();
  fs.writeFileSync(storagePath, JSON.stringify({ accessToken: 'OLD', refreshToken: 'stored-refresh', expiresAt: 99_000_000 }));
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000 });
  tp.invalidate();
  assert.equal(await tp.getToken(), 'AT1');
  assert.ok(f.calls[0].init.body.includes('refresh_token=stored-refresh'));
});

test('a corrupt stored file falls back to the config refresh token', async () => {
  const storagePath = tmpStorage();
  fs.writeFileSync(storagePath, '{not json');
  const f = tokenFetch([tok(1)]);
  const tp = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl: f, now: () => 1_000_000, log: { warn() {} } });
  assert.equal(await tp.getToken(), 'AT1');
  assert.ok(f.calls[0].init.body.includes('refresh_token=cfg-refresh'));
});

test('a non-string or empty refresh token in the response keeps the previous one', async () => {
  for (const bad of [undefined, '', null, 42]) {
    const storagePath = tmpStorage();
    const fetchImpl = tokenFetch([{ access_token: 'AT', refresh_token: bad, expires_in: 3600 }]);
    const provider = new TokenProvider({ oauth: OAUTH, storagePath, fetchImpl, now: () => 1_000_000 });
    await provider.getToken();
    assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).refreshToken, 'cfg-refresh');
  }
});
