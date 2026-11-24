import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TvPowerOn } from '../src/local/tvPowerOn.js';
import { powerOnCommand } from '../src/devices/tv.js';

const device = { deviceId: 't1', label: 'TV' };
const cfg = { ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' };

function make({ tvConfig, seq, cloud = false, onSettled } = {}) {
  const sent = [];
  const calls = [];
  const client = { async sendCommands(id, commands) { sent.push({ id, commands }); } };
  const tokenStore = {};
  const logs = [];
  const powerOn = new TvPowerOn({
    client, device, tvConfig, tokenStore, cloudPowerOn: () => cloud, onSettled,
    log: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    powerOnSequence: seq ?? (async (args) => { calls.push(args); return 'on'; }),
  });
  return { powerOn, sent, calls, tokenStore, logs };
}

test('without ip and mac the request sends the cloud command and starts no sequence', async () => {
  const { powerOn, sent, calls } = make({ tvConfig: { ip: '10.0.0.5' } });
  assert.equal(powerOn.hasLocal, false);
  await powerOn.request();
  assert.deepEqual(sent, [{ id: 't1', commands: powerOnCommand() }]);
  assert.deepEqual(calls, []);
  assert.equal(powerOn.pending, null);
});

test('a cloud failure is thrown to the caller', async () => {
  const powerOn = new TvPowerOn({ client: { sendCommands: async () => { throw new Error('x'); } }, device });
  await assert.rejects(() => powerOn.request(), /x/);
});

test('with ip and mac the sequence runs once at a time and the request returns at once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let count = 0;
  const { powerOn, tokenStore } = make({ tvConfig: cfg, seq: async (args) => { count += 1; assert.equal(args.tokenStore, tokenStore); await gate; return 'on'; } });
  await powerOn.request();
  await powerOn.request();
  assert.equal(count, 1);
  assert.ok(powerOn.pending);
  release();
  await powerOn.pending;
  assert.equal(powerOn.pending, null);
  await powerOn.request();
  assert.equal(count, 2);
});

test('a result other than on sends the cloud command only when the TV supports it', async () => {
  const a = make({ tvConfig: cfg, seq: async () => 'standby', cloud: true });
  await a.powerOn.request();
  await a.powerOn.pending;
  assert.deepEqual(a.sent, [{ id: 't1', commands: powerOnCommand() }]);
  const b = make({ tvConfig: cfg, seq: async () => 'standby', cloud: false });
  await b.powerOn.request();
  await b.powerOn.pending;
  assert.deepEqual(b.sent, []);
  const c = make({ tvConfig: cfg, seq: async () => 'on', cloud: true });
  await c.powerOn.request();
  await c.powerOn.pending;
  assert.deepEqual(c.sent, []);
});

test('a failing sequence is logged and never rejects', async () => {
  const { powerOn, logs } = make({ tvConfig: cfg, seq: async () => { throw new Error('wake failed'); } });
  await powerOn.request();
  await assert.doesNotReject(powerOn.pending);
  assert.ok(logs.some(([level, m]) => level === 'warn' && m.includes('wake failed')));
});

test('onSettled is called after the sequence ends, after pending is cleared', async () => {
  let seen;
  const state = {};
  const { powerOn } = make({ tvConfig: cfg, onSettled: () => { seen = state.powerOn.pending; } });
  state.powerOn = powerOn;
  await powerOn.request();
  await powerOn.pending;
  await new Promise((r) => setImmediate(r));
  assert.equal(seen, null);
});
