import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  getLocalInfo, buildMagicPacket, broadcastAddress, sendWake, sendKey, powerOnSequence,
} from '../src/local/samsungTv.js';

const okFetch = (device) => async () => ({ ok: true, status: 200, json: async () => ({ device }) });

test('getLocalInfo: on', async () => {
  const r = await getLocalInfo('10.0.0.5', {
    fetchImpl: okFetch({ name: 'TV', wifiMac: 'AA:BB', PowerState: 'on' }),
  });
  assert.deepEqual(r, { reachable: true, powerState: 'on', name: 'TV', wifiMac: 'AA:BB' });
});

test('getLocalInfo: requests the expected URL', async () => {
  let url;
  await getLocalInfo('10.0.0.5', {
    fetchImpl: async (u) => { url = u; return { ok: true, json: async () => ({ device: {} }) }; },
  });
  assert.equal(url, 'http://10.0.0.5:8001/api/v2/');
});

test('getLocalInfo: standby is lower-cased', async () => {
  const r = await getLocalInfo('x', { fetchImpl: okFetch({ PowerState: 'Standby' }) });
  assert.equal(r.powerState, 'standby');
});

test('getLocalInfo: empty PowerState gives null, reachable', async () => {
  const r = await getLocalInfo('x', { fetchImpl: okFetch({ PowerState: '' }) });
  assert.equal(r.reachable, true);
  assert.equal(r.powerState, null);
});

test('getLocalInfo: missing PowerState gives null, reachable', async () => {
  const r = await getLocalInfo('x', { fetchImpl: okFetch({ name: 'TV' }) });
  assert.equal(r.reachable, true);
  assert.equal(r.powerState, null);
});

const down = { reachable: false, powerState: null, name: null, wifiMac: null };

test('getLocalInfo: rejected fetch is unreachable', async () => {
  const r = await getLocalInfo('x', { fetchImpl: async () => { throw new Error('boom'); } });
  assert.deepEqual(r, down);
});

test('getLocalInfo: 500 is unreachable', async () => {
  const r = await getLocalInfo('x', { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.deepEqual(r, down);
});

test('getLocalInfo: aborts after timeout', async () => {
  const r = await getLocalInfo('x', {
    timeoutMs: 10,
    fetchImpl: (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
  });
  assert.deepEqual(r, down);
});

test('buildMagicPacket: layout', () => {
  const p = buildMagicPacket('02:00:5E:10:20:30');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  assert.equal(p.subarray(6, 12).toString('hex'), '02005e102030');
  assert.equal(p.subarray(96, 102).toString('hex'), '02005e102030');
});

test('buildMagicPacket: three formats are identical', () => {
  const a = buildMagicPacket('02:00:5E:10:20:30');
  assert.deepEqual(buildMagicPacket('02-00-5e-10-20-30'), a);
  assert.deepEqual(buildMagicPacket('02005E102030'), a);
});

test('buildMagicPacket: invalid throws', () => {
  assert.throws(() => buildMagicPacket('nope'), { message: 'Invalid MAC address' });
});

test('broadcastAddress', () => {
  assert.equal(broadcastAddress('192.168.1.42'), '192.168.1.255');
});

function fakeDgram({ sendError } = {}) {
  const state = { sends: [], broadcast: null, closed: false, created: [] };
  state.impl = {
    createSocket(type) {
      state.created.push(type);
      const s = new EventEmitter();
      s.bind = (cb) => { if (cb) setImmediate(cb); };
      s.setBroadcast = (v) => { state.broadcast = v; };
      s.send = (buf, port, addr, cb) => {
        state.sends.push({ buf, port, addr });
        setImmediate(() => cb(sendError));
      };
      s.close = () => { state.closed = true; };
      return s;
    },
  };
  return state;
}

test('sendWake: defaults send 12 packets, broadcast on, closed', async () => {
  const f = fakeDgram();
  await sendWake('02:00:5E:10:20:30', '192.168.1.42', { dgramImpl: f.impl });
  assert.deepEqual(f.created, ['udp4']);
  assert.equal(f.sends.length, 12);
  const pkt = buildMagicPacket('02:00:5E:10:20:30');
  for (const s of f.sends) assert.deepEqual(s.buf, pkt);
  assert.deepEqual([...new Set(f.sends.map((s) => s.port))].sort(), [7, 9]);
  assert.deepEqual([...new Set(f.sends.map((s) => s.addr))].sort(), ['192.168.1.255', '192.168.1.42']);
  assert.equal(f.broadcast, true);
  assert.equal(f.closed, true);
});

test('sendWake: rejects on send error and closes', async () => {
  const f = fakeDgram({ sendError: new Error('nope') });
  await assert.rejects(sendWake('02:00:5E:10:20:30', '192.168.1.42', { dgramImpl: f.impl }), /nope/);
  assert.equal(f.closed, true);
});

function fakeWs() {
  const made = [];
  class FakeWs extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.sent = [];
      this.closed = 0;
      made.push(this);
    }
    send(d) { this.sent.push(d); }
    close() { this.closed += 1; }
  }
  return { FakeWs, made };
}
const msg = (o) => Buffer.from(JSON.stringify(o));
const noSleep = async () => {};
const tick = () => new Promise((r) => setImmediate(r));
const b64 = (s) => Buffer.from(s).toString('base64');

function store(initial = {}) {
  const data = { ...initial };
  return { data, get: (ip) => data[ip], set: (ip, t) => { data[ip] = t; } };
}

test('sendKey: no stored token, base64 name, no token param, rejectUnauthorized false', async () => {
  const { FakeWs, made } = fakeWs();
  const p = sendKey('10.0.0.5', 'KEY_POWER', { tokenStore: store(), WebSocketImpl: FakeWs, sleep: noSleep });
  const ws = made[0];
  assert.equal(ws.url, `wss://10.0.0.5:8002/api/v2/channels/samsung.remote.control?name=${b64('Homebridge')}`);
  assert.equal(ws.url.includes('token='), false);
  assert.equal(ws.options.rejectUnauthorized, false);
  ws.emit('message', msg({ event: 'ms.channel.connect' }));
  await p;
});

test('sendKey: stored token is appended', async () => {
  const { FakeWs, made } = fakeWs();
  const p = sendKey('10.0.0.5', 'KEY_POWER', {
    tokenStore: store({ '10.0.0.5': 'tok1' }), name: 'Abc', WebSocketImpl: FakeWs, sleep: noSleep,
  });
  assert.equal(made[0].url, `wss://10.0.0.5:8002/api/v2/channels/samsung.remote.control?name=${b64('Abc')}&token=tok1`);
  made[0].emit('message', msg({ event: 'ms.channel.connect' }));
  await p;
});

test('sendKey: connect saves token and sends exact payload, then closes', async () => {
  const { FakeWs, made } = fakeWs();
  const ts = store();
  const p = sendKey('10.0.0.5', 'KEY_POWER', { tokenStore: ts, WebSocketImpl: FakeWs, sleep: noSleep });
  made[0].emit('message', msg({ event: 'ms.channel.connect', data: { token: 12345678 } }));
  await p;
  assert.equal(ts.data['10.0.0.5'], '12345678');
  assert.equal(made[0].sent.length, 1);
  assert.equal(
    made[0].sent[0],
    '{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_POWER","Option":"false","TypeOfRemote":"SendRemoteKey"}}',
  );
  assert.ok(made[0].closed >= 1);
});

test('sendKey: a token store that throws does not stop the key being sent', async () => {
  const { FakeWs, made } = fakeWs();
  const ts = { get: () => undefined, set: () => { throw new Error('disk full'); } };
  const p = sendKey('10.0.0.5', 'KEY_POWER', { tokenStore: ts, WebSocketImpl: FakeWs, sleep: noSleep });
  made[0].emit('message', msg({ event: 'ms.channel.connect', data: { token: 'abc' } }));
  await p;
  assert.equal(made[0].sent.length, 1);
});

test('sendKey: the saved token is URL encoded', async () => {
  const { FakeWs, made } = fakeWs();
  const p = sendKey('10.0.0.5', 'KEY_POWER', {
    tokenStore: store({ '10.0.0.5': 'a b&c=d' }), name: 'Abc', WebSocketImpl: FakeWs, sleep: noSleep,
  });
  assert.ok(made[0].url.endsWith('&token=a%20b%26c%3Dd'));
  made[0].emit('message', msg({ event: 'ms.channel.connect' }));
  await p;
});

test('sendKey: waits 300 ms after sending', async () => {
  const { FakeWs, made } = fakeWs();
  const waits = [];
  const p = sendKey('10.0.0.5', 'KEY_POWER', {
    tokenStore: store(), WebSocketImpl: FakeWs, sleep: async (ms) => { waits.push(ms); },
  });
  made[0].emit('message', msg({ event: 'ms.channel.connect' }));
  await p;
  assert.deepEqual(waits, [300]);
});

test('sendKey: unauthorized rejects and closes', async () => {
  const { FakeWs, made } = fakeWs();
  const p = sendKey('10.0.0.5', 'KEY_POWER', { tokenStore: store(), WebSocketImpl: FakeWs, sleep: noSleep });
  made[0].emit('message', msg({ event: 'ms.channel.unauthorized' }));
  await assert.rejects(p, { message: 'TV denied the connection' });
  assert.ok(made[0].closed >= 1);
  assert.equal(made[0].sent.length, 0);
});

test('sendKey: timeout rejects and closes', async () => {
  const { FakeWs, made } = fakeWs();
  await assert.rejects(
    sendKey('10.0.0.5', 'KEY_POWER', { tokenStore: store(), WebSocketImpl: FakeWs, timeoutMs: 20, sleep: noSleep }),
    { message: 'TV did not respond' },
  );
  assert.ok(made[0].closed >= 1);
});

test('sendKey: socket error rejects', async () => {
  const { FakeWs, made } = fakeWs();
  const p = sendKey('10.0.0.5', 'KEY_POWER', { tokenStore: store(), WebSocketImpl: FakeWs, sleep: noSleep });
  made[0].emit('error', new Error('ECONNREFUSED secret'));
  await assert.rejects(p, { message: 'TV did not respond' });
  assert.ok(made[0].closed >= 1);
  await tick();
});

test('sendKey: ignores unrelated and malformed messages until connect', async () => {
  const { FakeWs, made } = fakeWs();
  const p = sendKey('10.0.0.5', 'KEY_MUTE', { tokenStore: store(), WebSocketImpl: FakeWs, sleep: noSleep });
  made[0].emit('message', Buffer.from('garbage'));
  made[0].emit('message', msg({ event: 'other' }));
  assert.equal(made[0].sent.length, 0);
  made[0].emit('message', msg({ event: 'ms.channel.connect' }));
  await p;
  assert.equal(made[0].sent.length, 1);
});

const info = (reachable, powerState = null) => ({ reachable, powerState, name: null, wifiMac: null });

function scripted(infos, { wakeThrows = false, keyRejects = false } = {}) {
  const calls = [];
  let i = 0;
  const deps = {
    getLocalInfo: async () => {
      calls.push('info');
      const r = infos[Math.min(i, infos.length - 1)];
      i += 1;
      return r;
    },
    sendWake: async () => { calls.push('wake'); if (wakeThrows) throw new Error('x'); },
    sendKey: async (ip, key, opts) => {
      calls.push(`key:${key}`);
      assert.ok(opts.tokenStore);
      if (keyRejects) throw new Error('denied');
    },
  };
  return { deps, calls };
}
const run = (deps) => powerOnSequence({ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.5', tokenStore: store(), sleep: noSleep, deps });
const count = (calls, c) => calls.filter((x) => x === c).length;

test('powerOnSequence: already on', async () => {
  const { deps, calls } = scripted([info(true, 'on')]);
  assert.equal(await run(deps), 'on');
  assert.deepEqual(calls, ['info']);
});

test('powerOnSequence: unreachable, wake, reachable null, key, on', async () => {
  const { deps, calls } = scripted([info(false), info(false), info(true), info(true, 'on')]);
  assert.equal(await run(deps), 'on');
  assert.deepEqual(calls, ['info', 'wake', 'info', 'info', 'key:KEY_POWER', 'info']);
});

test('powerOnSequence: never reachable, 15 polls, no key', async () => {
  const { deps, calls } = scripted([info(false)]);
  assert.equal(await run(deps), 'unreachable');
  assert.equal(count(calls, 'info'), 16);
  assert.equal(calls.some((c) => c.startsWith('key')), false);
  assert.equal(count(calls, 'wake'), 1);
});

test('powerOnSequence: reachable in standby skips wake and sends key', async () => {
  const { deps, calls } = scripted([info(true, 'standby'), info(true, 'on')]);
  assert.equal(await run(deps), 'on');
  assert.equal(calls.includes('wake'), false);
  assert.ok(calls.includes('key:KEY_POWER'));
});

test('powerOnSequence: reachable after wake and already on skips key', async () => {
  const { deps, calls } = scripted([info(false), info(true, 'on')]);
  assert.equal(await run(deps), 'on');
  assert.equal(calls.some((c) => c.startsWith('key')), false);
});

test('powerOnSequence: key rejects returns standby without polling', async () => {
  const { deps, calls } = scripted([info(true, 'standby')], { keyRejects: true });
  assert.equal(await run(deps), 'standby');
  assert.equal(count(calls, 'info'), 1);
});

test('powerOnSequence: key accepted but never on returns standby after 8 polls', async () => {
  const { deps, calls } = scripted([info(true, 'standby')]);
  assert.equal(await run(deps), 'standby');
  assert.equal(count(calls, 'info'), 1 + 8);
});

test('powerOnSequence: throwing sendWake still returns a string', async () => {
  const { deps } = scripted([info(false), info(false), info(true, 'on')], { wakeThrows: true });
  const r = await run(deps);
  assert.equal(typeof r, 'string');
  assert.equal(r, 'on');
});

test('powerOnSequence: throwing getLocalInfo does not reject', async () => {
  const r = await run({ getLocalInfo: async () => { throw new Error('x'); }, sendWake: async () => {}, sendKey: async () => {} });
  assert.equal(typeof r, 'string');
});

test('powerOnSequence: sleeps 2000 ms between polls', async () => {
  const waits = [];
  const { deps } = scripted([info(false), info(true, 'on')]);
  await powerOnSequence({ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.5', tokenStore: store(), sleep: async (ms) => { waits.push(ms); }, deps });
  assert.deepEqual(waits, [2000]);
});
