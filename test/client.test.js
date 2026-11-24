import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SmartThingsClient, SmartThingsError } from '../src/api/client.js';
import { API_BASE } from '../src/settings.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/devices.json', import.meta.url), 'utf8'));

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function setup(script, opts = {}) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, at: calls.length });
    const r = script[Math.min(i++, script.length - 1)];
    return typeof r === 'function' ? r() : r;
  };
  const sleeps = [];
  const tokenProvider = {
    invalidations: 0,
    getToken: async () => 'TOKEN',
    invalidate() { this.invalidations++; },
  };
  const client = new SmartThingsClient({
    tokenProvider,
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    ...opts,
  });
  return { client, calls, sleeps, tokenProvider };
}

test('listDevices follows two pages', async () => {
  const half = Math.ceil(fixture.items.length / 2);
  const page1 = { items: fixture.items.slice(0, half), _links: { next: { href: `${API_BASE}/devices?page=2` } } };
  const page2 = { items: fixture.items.slice(half), _links: {} };
  const { client, calls } = setup([res(200, page1), res(200, page2)]);
  const devices = await client.listDevices();
  assert.equal(devices.length, fixture.items.length);
  assert.deepEqual(devices.map((d) => d.deviceId), fixture.items.map((d) => d.deviceId));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${API_BASE}/devices`);
  assert.equal(calls[1].url, `${API_BASE}/devices?page=2`);
});

test('listDevices stops when next is null', async () => {
  const { client, calls } = setup([res(200, { items: [{ deviceId: 'a' }], _links: { next: null } })]);
  assert.deepEqual(await client.listDevices(), [{ deviceId: 'a' }]);
  assert.equal(calls.length, 1);
});

test('getStatus hits the right URL with a Bearer token', async () => {
  const body = { components: { main: {} } };
  const { client, calls } = setup([res(200, body)]);
  assert.deepEqual(await client.getStatus('dev-1'), body);
  assert.equal(calls[0].url, `${API_BASE}/devices/dev-1/status`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN');
});

test('getHealth maps ONLINE, OFFLINE and unknown states', async () => {
  const { client, calls } = setup([
    res(200, { state: 'ONLINE' }),
    res(200, { state: 'OFFLINE' }),
    res(200, { state: 'WEIRD' }),
  ]);
  assert.equal(await client.getHealth('d'), 'ONLINE');
  assert.equal(await client.getHealth('d'), 'OFFLINE');
  assert.equal(await client.getHealth('d'), 'OFFLINE');
  assert.equal(calls[0].url, `${API_BASE}/devices/d/health`);
});

test('sendCommands posts the exact JSON body', async () => {
  const commands = [{ component: 'main', capability: 'switch', command: 'on', arguments: [] }];
  const { client, calls } = setup([res(200, { results: [{ status: 'ACCEPTED' }] })]);
  await client.sendCommands('d', commands);
  assert.equal(calls[0].url, `${API_BASE}/devices/d/commands`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN');
  assert.equal(calls[0].init.body, JSON.stringify({ commands }));
});

test('401 then 200 invalidates once and succeeds', async () => {
  const { client, calls, tokenProvider } = setup([res(401, {}), res(200, { ok: 1 })]);
  assert.deepEqual(await client.getStatus('d'), { ok: 1 });
  assert.equal(tokenProvider.invalidations, 1);
  assert.equal(calls.length, 2);
});

test('401 twice throws SmartThingsError with status 401', async () => {
  const { client, calls } = setup([res(401, {}), res(401, {})]);
  await assert.rejects(client.getStatus('d'), (err) => {
    assert.ok(err instanceof SmartThingsError);
    assert.equal(err.status, 401);
    assert.equal(err.message, 'SmartThings GET /devices/d/status failed: HTTP 401');
    return true;
  });
  assert.equal(calls.length, 2);
});

test('429 with Retry-After 2 sleeps 2000 then succeeds', async () => {
  const { client, sleeps } = setup([res(429, {}, { 'Retry-After': '2' }), res(200, { ok: 1 })]);
  assert.deepEqual(await client.getStatus('d'), { ok: 1 });
  assert.deepEqual(sleeps.filter((ms) => ms >= 1000), [2000]);
});

test('429 defaults to 5 seconds and caps at 60', async () => {
  const a = setup([res(429, {}), res(200, {})]);
  await a.client.getStatus('d');
  assert.deepEqual(a.sleeps.filter((ms) => ms >= 1000), [5000]);
  const b = setup([res(429, {}, { 'Retry-After': '500' }), res(200, {})]);
  await b.client.getStatus('d');
  assert.deepEqual(b.sleeps.filter((ms) => ms >= 1000), [60000]);
});

test('429 four times throws after three retries', async () => {
  const { client, calls } = setup([res(429, {}, { 'Retry-After': '1' })]);
  await assert.rejects(client.getStatus('d'), (err) => {
    assert.ok(err instanceof SmartThingsError);
    assert.equal(err.status, 429);
    return true;
  });
  assert.equal(calls.length, 4);
});

test('500 throws with the exact message format', async () => {
  const { client } = setup([res(500, {})]);
  await assert.rejects(
    client.sendCommands('d', []),
    (err) => err instanceof SmartThingsError
      && err.status === 500
      && err.message === 'SmartThings POST /devices/d/commands failed: HTTP 500',
  );
});

test('two calls started together run one after the other', async () => {
  const events = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const script = [
    async () => { events.push('start1'); await gate; events.push('end1'); return res(200, { n: 1 }); },
    async () => { events.push('start2'); events.push('end2'); return res(200, { n: 2 }); },
  ];
  const { client } = setup(script);
  const p1 = client.getStatus('a');
  const p2 = client.getStatus('b');
  await flush();
  assert.deepEqual(events, ['start1']);
  release();
  assert.deepEqual(await Promise.all([p1, p2]), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2']);
});

test('a second request waits out the remainder of minIntervalMs on a fake clock', async () => {
  let t = 1000;
  const { client, sleeps } = setup([res(200, {})], { minIntervalMs: 120, now: () => t });
  await client.getStatus('a');
  assert.deepEqual(sleeps, []);
  t += 50;
  await client.getStatus('b');
  assert.deepEqual(sleeps, [70]);
  t += 500; // interval already elapsed
  await client.getStatus('c');
  assert.deepEqual(sleeps, [70]);
});

test('listDevices ignores a paging link to another host and never sends the token there', async () => {
  const warnings = [];
  const page1 = { items: [{ deviceId: 'a' }], _links: { next: { href: 'https://evil.example.com/devices?page=2' } } };
  const { client, calls } = setup([res(200, page1)], { log: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(await client.listDevices(), [{ deviceId: 'a' }]);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => c.url.startsWith(API_BASE)));
  assert.deepEqual(warnings, ['Ignoring unexpected SmartThings paging link']);
});

test('listDevices stops after 50 pages', async () => {
  const page = { items: [{ deviceId: 'x' }], _links: { next: { href: `${API_BASE}/devices?page=n` } } };
  const { client, calls } = setup([res(200, page)]);
  const devices = await client.listDevices();
  assert.equal(calls.length, 50);
  assert.equal(devices.length, 50);
});

test('a POST that gets 429 throws at once with no sleep and no retry', async () => {
  const { client, calls, sleeps } = setup([res(429, {}, { 'Retry-After': '2' }), res(200, {})]);
  await assert.rejects(client.sendCommands('d', []), (err) => {
    assert.ok(err instanceof SmartThingsError);
    assert.equal(err.status, 429);
    assert.equal(err.message, 'SmartThings POST /devices/d/commands failed: HTTP 429');
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps.filter((ms) => ms >= 1000), []);
});

test('every request carries an abort signal', async () => {
  const { client, calls } = setup([res(200, {})]);
  await client.getStatus('d');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('a request that never answers times out with a SmartThingsError naming method and path', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const client = new SmartThingsClient({
    tokenProvider: { getToken: async () => 'SECRETTOKEN', invalidate() {} },
    fetchImpl,
    timeoutMs: 20,
    sleep: async () => {},
  });
  // AbortSignal.timeout timers are unref'd, so keep the event loop alive for the test.
  const keepAlive = setTimeout(() => {}, 5000);
  after(() => clearTimeout(keepAlive));
  await assert.rejects(client.getStatus('d1'), (err) => {
    assert.ok(err instanceof SmartThingsError);
    assert.equal(err.status, 0);
    assert.equal(err.message, 'SmartThings GET /devices/d1/status timed out');
    assert.ok(!err.message.includes('SECRETTOKEN'));
    return true;
  });
});

test('hitting the 50 page cap with a next link still present logs a warning', async () => {
  const warnings = [];
  const page = { items: [{ deviceId: 'x' }], _links: { next: { href: `${API_BASE}/devices?page=n` } } };
  const { client } = setup([res(200, page)], { log: { warn: (m) => warnings.push(m) } });
  await client.listDevices();
  assert.deepEqual(warnings, ['SmartThings paging limit reached']);
});
