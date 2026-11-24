import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Accessory, Service, Characteristic, uuid, Categories, HapStatusError, HAPStatus } from '@homebridge/hap-nodejs';
import { SmartThings5m5Platform } from '../src/platform.js';
import { PLUGIN_NAME, PLATFORM_NAME } from '../src/settings.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const devices = read('devices.json').items;
const washerStatus = read('washer.status.json');
const tvStatus = read('tv-bedroom.status.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st5m5-'));
const BEDROOM = '00000000-0000-0000-0000-000000000004';
const WASHER = '00000000-0000-0000-0000-000000000009';

function setup({ config = {}, listDevices, cached = [], getLocalInfo, getStatus } = {}) {
  const events = {};
  const created = [];
  const registered = [];
  const published = [];
  class PlatformAccessory extends Accessory {
    constructor(name, id, category) {
      super(name, id, category);
      created.push(this);
    }
  }
  const api = {
    hap: { Service, Characteristic, HapStatusError, HAPStatus, Categories, uuid },
    user: { storagePath: () => tmpDir },
    platformAccessory: PlatformAccessory,
    registerPlatformAccessories: (...a) => registered.push(a),
    publishExternalAccessories: (...a) => published.push(a),
    on: (event, cb) => { events[event] = cb; },
  };
  const logs = { info: [], warn: [], error: [] };
  const log = {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
    debug() {},
  };
  const pollerState = { adds: [], started: false, onSnapshot: null };
  const timers = [];
  const deps = {
    createClient: () => ({
      listDevices: listDevices ?? (async () => devices),
      sendCommands: async () => ({}),
      getStatus: getStatus ?? (async () => tvStatus),
    }),
    createPoller: ({ onSnapshot }) => {
      pollerState.onSnapshot = onSnapshot;
      return {
        add: (id, ms) => pollerState.adds.push([id, ms]),
        start: () => { pollerState.started = true; },
        stop() {},
      };
    },
    getLocalInfo,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; },
  };
  const platform = new SmartThings5m5Platform(log, { accessToken: 'test-token', ...config }, api, deps);
  for (const a of cached) platform.configureAccessory(a);
  return { platform, api, events, created, registered, published, logs, pollerState, timers };
}

const launch = async (ctx) => {
  await ctx.events.didFinishLaunching();
};

test('discovery registers platform accessories and publishes TVs', async () => {
  const ctx = setup();
  await launch(ctx);
  assert.equal(ctx.registered.length, 7);
  assert.equal(ctx.published.length, 3);
  assert.equal(ctx.registered[0][0], PLUGIN_NAME);
  assert.equal(ctx.registered[0][1], PLATFORM_NAME);
  assert.ok(ctx.pollerState.started);
});

test('ignoreDevices skips a device', async () => {
  const ctx = setup({ config: { ignoreDevices: ['Moisture Sensor 01'] } });
  await launch(ctx);
  assert.equal(ctx.registered.length, 6);
});

test('unhandled devices are logged in one line', async () => {
  const ctx = setup();
  await launch(ctx);
  const lines = ctx.logs.info.filter((l) => l.includes('Unhandled'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Hub - Samsung 65 TV - Bedroom/);
  assert.match(lines[0], /Hub/);
  assert.match(lines[0], /iPhone/);
});

test('cached accessory with matching uuid is reused', async () => {
  const id = uuid.generate(`smartthings-5m5:${WASHER}`);
  const cached = new Accessory('Washing machine', id);
  const ctx = setup({ cached: [cached] });
  await launch(ctx);
  assert.equal(ctx.registered.length, 6);
  assert.ok(cached.getServiceById(Service.OccupancySensor, 'running'));
});

test('cached accessory without a device is kept and named in a warning', async () => {
  const stale = new Accessory('Old Thing', uuid.generate('smartthings-5m5:gone'));
  const ctx = setup({ cached: [stale] });
  await launch(ctx);
  assert.equal(ctx.logs.warn.filter((l) => l.includes('Old Thing')).length, 1);
  assert.equal(ctx.registered.length, 7);
});

test('poll intervals and overrides', async () => {
  const ctx = setup();
  await launch(ctx);
  assert.equal(ctx.pollerState.adds.length, 10);
  const ms = Object.fromEntries(ctx.pollerState.adds);
  assert.equal(ms['00000000-0000-0000-0000-000000000006'], 30000);
  assert.equal(ms[WASHER], 15000);
  assert.equal(ms['00000000-0000-0000-0000-000000000012'], 15000);
  assert.equal(ms['00000000-0000-0000-0000-000000000010'], 15000);
  assert.equal(ms[BEDROOM], 20000);

  const o = setup({ config: { pollSeconds: { sensors: 60, appliances: 5, tvs: 3 } } });
  await launch(o);
  const om = Object.fromEntries(o.pollerState.adds);
  assert.equal(om['00000000-0000-0000-0000-000000000006'], 60000);
  assert.equal(om[WASHER], 5000);
  assert.equal(om[BEDROOM], 5000);
});

test('snapshot reaches the washer accessory', async () => {
  const ctx = setup();
  await launch(ctx);
  const s = structuredClone(washerStatus);
  s.components.main.washerOperatingState.machineState.value = 'run';
  await ctx.pollerState.onSnapshot(WASHER, { status: s, online: true });
  const washer = ctx.created.find((a) => a.displayName === 'Washing machine');
  assert.equal(washer.getServiceById(Service.OccupancySensor, 'running').getCharacteristic(Characteristic.OccupancyDetected).value, 1);
});

test('TV with ip passes local power state', async () => {
  const calls = [];
  const ctx = setup({
    config: { tvs: [{ label: 'Samsung 65 TV - Bedroom', ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' }] },
    getLocalInfo: async (ip) => { calls.push(ip); return { reachable: true, powerState: 'on' }; },
  });
  await launch(ctx);
  await ctx.pollerState.onSnapshot(BEDROOM, { status: {}, online: false });
  assert.deepEqual(calls, ['10.0.0.5']);
  const tvAcc = ctx.created.find((a) => a.displayName === 'Samsung 65 TV - Bedroom');
  assert.equal(tvAcc.getService(Service.Television).getCharacteristic(Characteristic.Active).value, 1);
});

test('TV without configured ip does not call getLocalInfo', async () => {
  let called = 0;
  const ctx = setup({ getLocalInfo: async () => { called += 1; return {}; } });
  await launch(ctx);
  await ctx.pollerState.onSnapshot(BEDROOM, { status: {}, online: false });
  assert.equal(called, 0);
});

test('failing listDevices logs an error, does not throw, and schedules a retry', async () => {
  const ctx = setup({ listDevices: async () => { throw new Error('sign-in failed'); } });
  await launch(ctx);
  assert.equal(ctx.logs.error.length, 1);
  assert.equal(ctx.timers.length, 1);
  assert.equal(ctx.timers[0].ms, 60000);
  assert.equal(ctx.pollerState.started, false);
});

test('config schema and package metadata', () => {
  const root = new URL('../', import.meta.url);
  const schema = JSON.parse(fs.readFileSync(new URL('config.schema.json', root), 'utf8'));
  assert.equal(schema.pluginAlias, 'SmartThings5m5');
  assert.equal(schema.pluginType, 'platform');
  assert.equal(schema.singular, true);
  for (const key of ['name', 'accessToken', 'oauth', 'pollSeconds', 'finishedHoldMinutes', 'ignoreDevices', 'tvs']) {
    assert.ok(schema.schema.properties[key], key);
  }
  assert.equal(schema.schema.properties.finishedHoldMinutes.default, 30);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.name, 'homebridge-smartthings-5m5');
  assert.equal(pkg.main, 'src/index.js');
  assert.ok(fs.existsSync(new URL(pkg.main, root)));
});

test('every interval is clamped to at least 5 seconds', async () => {
  const ctx = setup({ config: { pollSeconds: { sensors: 1, appliances: 2, tvs: 0.5 } } });
  await launch(ctx);
  assert.ok(ctx.pollerState.adds.every(([, ms]) => ms >= 5000));
});

test('published TVs already have their input sources built from the last known status', async () => {
  const ctx = setup();
  await launch(ctx);
  const bedroom = ctx.published.map((p) => p[1][0]).find((a) => a.displayName === 'Samsung 65 TV - Bedroom');
  assert.equal(bedroom.services.filter((s) => s.UUID === Service.InputSource.UUID).length, 3);
});

test('a TV is still published when its last known status cannot be read', async () => {
  const ctx = setup({ getStatus: async () => { throw new Error('offline'); } });
  await launch(ctx);
  assert.equal(ctx.published.length, 3);
});

test('TVs are published only after every other device is registered', async () => {
  const order = [];
  const ctx = setup();
  const reg = ctx.api.registerPlatformAccessories;
  ctx.api.registerPlatformAccessories = (...a) => { order.push('register'); reg(...a); };
  const pub = ctx.api.publishExternalAccessories;
  ctx.api.publishExternalAccessories = (...a) => { order.push('publish'); pub(...a); };
  await launch(ctx);
  assert.equal(order.lastIndexOf('register') < order.indexOf('publish'), true);
});

test('a retry after a partial failure does not register the same UUID twice', async () => {
  let calls = 0;
  const ctx = setup();
  const original = ctx.api.registerPlatformAccessories;
  // Fail on the third registration the first time round.
  ctx.api.registerPlatformAccessories = (...a) => {
    calls += 1;
    if (calls === 3) throw new Error('register failed');
    original(...a);
  };
  await launch(ctx);
  assert.equal(ctx.timers.length, 1);
  ctx.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  const ids = ctx.registered.map((a) => a[2][0].UUID);
  assert.equal(new Set(ids).size, ids.length);
});

test('no credentials logs one error and does not retry', async () => {
  const ctx = setup({ config: { accessToken: undefined } });
  await launch(ctx);
  assert.equal(ctx.logs.error.length, 1);
  assert.equal(ctx.timers.length, 0);
  assert.equal(ctx.pollerState.started, false);
});

test('an incomplete oauth block with no access token counts as no credentials', async () => {
  const ctx = setup({ config: { accessToken: undefined, oauth: { clientId: 'a', clientSecret: 'b' } } });
  await launch(ctx);
  assert.equal(ctx.timers.length, 0);
});

test('device labels are sanitised for accessory and service names', async () => {
  const renamed = devices.map((d) => (d.label === 'Moisture Sensor 01' ? { ...d, label: 'Cellar|Sensor' } : d));
  const ctx = setup({ listDevices: async () => renamed });
  await launch(ctx);
  const acc = ctx.created.find((a) => a.displayName === 'Cellar Sensor');
  assert.ok(acc);
  const names = acc.services.flatMap((s) => (s.testCharacteristic(Characteristic.Name) ? [s.getCharacteristic(Characteristic.Name).value] : []));
  assert.ok(names.includes('Cellar Sensor') && names.includes('Cellar Sensor Temperature'));
  assert.ok(ctx.created.every((a) => !a.displayName.includes('|')));
});
