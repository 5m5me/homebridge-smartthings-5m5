import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Accessory, Service, Characteristic, uuid, Categories, HapStatusError, HAPStatus } from '@homebridge/hap-nodejs';
import { SmartThings5m5Platform } from '../src/platform.js';
import { PLUGIN_NAME, PLATFORM_NAME } from '../src/settings.js';

// A fake api.matter: device types are plain strings, every call is recorded.
function fakeMatter(calls) {
  const deviceTypes = new Proxy({}, {
    get: (_, name) => {
      if (typeof name !== 'string') return undefined;
      if (name === 'Thermostat') return { with: (server) => ({ composed: 'Thermostat', server }) };
      return `type:${name}`;
    },
  });
  return {
    deviceTypes,
    deviceRequirements: { Thermostat: { ThermostatServer: { with: (...f) => `server:${f.join('+')}` } } },
    async registerPlatformAccessories(plugin, platform, accessories) { calls.push({ op: 'register', plugin, platform, accessories }); },
    async unregisterPlatformAccessories(plugin, platform, accessories) { calls.push({ op: 'unregister', plugin, platform, accessories }); },
    async updateAccessoryState(uuid, cluster, attributes) { calls.push({ op: 'update', uuid, cluster, attributes }); },
  };
}

const read = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const devices = read('devices.json').items;
const washerStatus = read('washer.status.json');
const tvStatus = read('tv-bedroom.status.json');
const statusByDevice = {
  '00000000-0000-0000-0000-000000000010': read('fridge.status.json'),
  '00000000-0000-0000-0000-000000000008': read('moisture.status.json'),
  '00000000-0000-0000-0000-000000000009': washerStatus,
};
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st5m5-'));
const BEDROOM = '00000000-0000-0000-0000-000000000004';
const WASHER = '00000000-0000-0000-0000-000000000009';

function setup({ config = {}, listDevices, cached = [], getLocalInfo, getStatus, matter: matterOpts, sendCommands, powerOnSequence, getHealth } = {}) {
  const events = {};
  const created = [];
  const registered = [];
  const published = [];
  const unregistered = [];
  const sentCommands = [];
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
    unregisterPlatformAccessories: (...a) => unregistered.push(a),
    publishExternalAccessories: (...a) => published.push(a),
    on: (event, cb) => { events[event] = cb; },
  };
  const matterCalls = [];
  if (matterOpts) {
    api.matter = fakeMatter(matterCalls);
    api.isMatterEnabled = () => matterOpts.enabled !== false;
    api.isHapEnabled = () => matterOpts.hap !== false;
  }
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
      sendCommands: sendCommands ?? (async (id, commands) => { sentCommands.push({ id, commands }); return {}; }),
      getStatus: getStatus ?? (matterOpts ? async (id) => statusByDevice[id] ?? tvStatus : async () => tvStatus),
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
    powerOnSequence,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; },
  };
  const platform = new SmartThings5m5Platform(log, { accessToken: 'test-token', ...config }, api, deps);
  for (const a of cached) platform.configureAccessory(a);
  for (const a of matterOpts?.cached ?? []) platform.configureMatterAccessory(a);
  return { platform, api, events, created, registered, published, unregistered, sentCommands, matterCalls, logs, pollerState, timers };
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

// ---- Matter connection ----

const matterRegistered = (ctx) => ctx.matterCalls.filter((c) => c.op === 'register').flatMap((c) => c.accessories);
const tileUuid = (deviceId, tileId) => uuid.generate(`smartthings-5m5:matter:${deviceId}:${tileId}`);
const FRIDGE = '00000000-0000-0000-0000-000000000010';
const MOISTURE = '00000000-0000-0000-0000-000000000008';

test('auto with Matter on publishes over Matter, registers no bridged accessories, still publishes the TVs', async () => {
  const stale = new Accessory('Washing machine', uuid.generate(`smartthings-5m5:${WASHER}`));
  const ctx = setup({ matter: {}, cached: [stale] });
  await launch(ctx);
  assert.ok(ctx.logs.info.some((l) => /published over Matter/.test(l)));
  assert.equal(ctx.logs.info.filter((l) => /^Devices are published over/.test(l)).length, 1);
  assert.equal(ctx.registered.length, 0);
  assert.equal(ctx.published.length, 3);
  // Cached bridged HAP accessories are removed, with one info line.
  assert.equal(ctx.unregistered.length, 1);
  assert.equal(ctx.unregistered[0][0], PLUGIN_NAME);
  assert.equal(ctx.unregistered[0][1], PLATFORM_NAME);
  assert.deepEqual(ctx.unregistered[0][2], [stale]);
  assert.equal(ctx.logs.info.filter((l) => /Removed 1 bridged HomeKit/.test(l)).length, 1);
  const accessories = matterRegistered(ctx);
  assert.ok(accessories.length > 0);
  assert.equal(new Set(accessories.map((a) => a.UUID)).size, accessories.length);
  assert.ok(accessories.every((a) => a.manufacturer === 'Samsung' && a.context.deviceId && a.context.tileId));
  const ofDevice = (id) => accessories.filter((a) => a.context.deviceId === id).map((a) => a.context.tileId);
  assert.deepEqual(ofDevice(FRIDGE), [
    'door-cooler', 'door-freezer', 'powercool', 'powerfreeze', 'vacation', 'temp-cooler', 'temp-freezer',
  ]);
  assert.deepEqual(ofDevice(WASHER), ['running', 'finished']);
  assert.deepEqual(ofDevice(BEDROOM), ['power']);
});

test('connection homekit with Matter available behaves exactly as before and removes cached Matter accessories', async () => {
  const oldMatter = { UUID: 'old', displayName: 'Old', context: { deviceId: 'x', tileId: 'power' } };
  const ctx = setup({ matter: { cached: [oldMatter] }, config: { connection: 'homekit' } });
  await launch(ctx);
  assert.ok(ctx.logs.info.some((l) => /published over HomeKit/.test(l)));
  assert.equal(ctx.registered.length, 7);
  assert.equal(ctx.published.length, 3);
  assert.equal(ctx.unregistered.length, 0);
  assert.equal(matterRegistered(ctx).length, 0);
  const removed = ctx.matterCalls.filter((c) => c.op === 'unregister');
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].accessories, [oldMatter]);
});

test('without Matter the platform stays on HomeKit and logs the connection once', async () => {
  const ctx = setup();
  await launch(ctx);
  assert.equal(ctx.logs.info.filter((l) => /published over HomeKit/.test(l)).length, 1);
  assert.equal(ctx.unregistered.length, 0);
});

test('connection matter without Matter on warns once and uses HomeKit', async () => {
  const ctx = setup({ config: { connection: 'matter' } });
  await launch(ctx);
  assert.equal(ctx.logs.warn.filter((l) => /Matter/.test(l)).length, 1);
  assert.equal(ctx.registered.length, 7);
});

test('a snapshot for the washer reaches the Matter tiles', async () => {
  const ctx = setup({ matter: {} });
  await launch(ctx);
  ctx.matterCalls.length = 0;
  const s = structuredClone(washerStatus);
  s.components.main.washerOperatingState.machineState.value = 'run';
  s.components.main.remoteControlStatus ??= { remoteControlEnabled: {} };
  s.components.main.remoteControlStatus.remoteControlEnabled.value = 'true';
  await ctx.pollerState.onSnapshot(WASHER, { status: s, online: true });
  const regs = ctx.matterCalls.filter((c) => c.op === 'register').flatMap((c) => c.accessories);
  assert.deepEqual(regs.map((a) => a.context.tileId), ['start']);
  const updates = ctx.matterCalls.filter((c) => c.op === 'update');
  const running = updates.find((u) => u.uuid === tileUuid(WASHER, 'running'));
  assert.deepEqual(running.attributes, { occupancy: { occupied: true } });
  const start = updates.find((u) => u.uuid === tileUuid(WASHER, 'start'));
  assert.deepEqual(start.attributes, { onOff: true });
});

test('the finished tile follows the finish tracker in Matter mode', async () => {
  const ctx = setup({ matter: {} });
  await launch(ctx);
  const run = structuredClone(washerStatus);
  run.components.main.washerOperatingState.machineState.value = 'run';
  await ctx.pollerState.onSnapshot(WASHER, { status: run, online: true });
  ctx.matterCalls.length = 0;
  await ctx.pollerState.onSnapshot(WASHER, { status: washerStatus, online: true });
  await ctx.pollerState.onSnapshot(WASHER, { status: washerStatus, online: true });
  const finished = ctx.matterCalls.filter((c) => c.op === 'update' && c.uuid === tileUuid(WASHER, 'finished'));
  assert.deepEqual(finished.map((c) => c.attributes), [{ stateValue: false }]);
});

test('leakAs and fridgeTemperature settings reach the tiles', async () => {
  const ctx = setup({ matter: {}, config: { leakAs: 'contact', fridgeTemperature: 'sensor' } });
  await launch(ctx);
  const by = (device, tile) => matterRegistered(ctx).find((a) => a.UUID === tileUuid(device, tile));
  assert.equal(by(MOISTURE, 'leak').deviceType, 'type:ContactSensor');
  assert.equal(by(FRIDGE, 'temp-freezer').deviceType, 'type:TemperatureSensor');
  const normal = setup({ matter: {} });
  await launch(normal);
  const n = (device, tile) => matterRegistered(normal).find((a) => a.UUID === tileUuid(device, tile));
  assert.equal(n(MOISTURE, 'leak').deviceType, 'type:LeakSensor');
  assert.equal(n(FRIDGE, 'temp-freezer').deviceType.composed, 'Thermostat');
});

test('stale remembered Matter accessories are removed, live ones kept', async () => {
  const gone = { UUID: 'gone', displayName: 'Gone', context: { deviceId: 'no-such-device', tileId: 'power' } };
  const ctx = setup({ matter: { cached: [gone] } });
  await launch(ctx);
  const removed = ctx.matterCalls.filter((c) => c.op === 'unregister').flatMap((c) => c.accessories);
  assert.deepEqual(removed.map((a) => a.UUID), ['gone']);
});

test('ignored devices have their remembered Matter tiles removed', async () => {
  const old = { UUID: 'old-moisture', displayName: 'Old', context: { deviceId: MOISTURE, tileId: 'leak' } };
  const ctx = setup({ matter: { cached: [old] }, config: { ignoreDevices: ['Moisture Sensor 01'] } });
  await launch(ctx);
  const removed = ctx.matterCalls.filter((c) => c.op === 'unregister').flatMap((c) => c.accessories);
  assert.deepEqual(removed.map((a) => a.UUID), ['old-moisture']);
});

test('a Matter command handler sends SmartThings commands through the client', async () => {
  const ctx = setup({ matter: {} });
  await launch(ctx);
  const powercool = matterRegistered(ctx).find((a) => a.UUID === tileUuid(FRIDGE, 'powercool'));
  await powercool.handlers.onOff.on();
  assert.deepEqual(ctx.sentCommands.map((c) => c.id), [FRIDGE]);
  assert.equal(ctx.sentCommands[0].commands[0].command, 'setRapidCooling');
});

test('TV power on over Matter runs the local sequence, shows on while it runs, and shares the guard', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const ctx = setup({
    matter: {},
    config: { tvs: [{ label: 'Samsung 65 TV - Bedroom', ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' }] },
    powerOnSequence: async (args) => { calls.push(args); await gate; return 'on'; },
    getLocalInfo: async () => ({ reachable: false, powerState: 'standby' }),
  });
  await launch(ctx);
  await ctx.pollerState.onSnapshot(BEDROOM, { status: tvStatus, online: false });
  const power = matterRegistered(ctx).find((a) => a.UUID === tileUuid(BEDROOM, 'power'));
  ctx.matterCalls.length = 0;
  await power.handlers.onOff.on();
  assert.equal(calls.length, 1);
  assert.equal(ctx.sentCommands.length, 0);
  const shown = ctx.matterCalls.filter((c) => c.op === 'update');
  assert.deepEqual(shown.map((c) => c.attributes), [{ onOff: true }]);
  // The HomeKit television shares the same guard.
  const tvAcc = ctx.published.map((p) => p[1][0]).find((a) => a.displayName === 'Samsung 65 TV - Bedroom');
  await tvAcc.getService(Service.Television).getCharacteristic(Characteristic.Active).handleSetRequest(1);
  assert.equal(calls.length, 1);
  release();
});

test('after a discovery retry the Matter tile and the HomeKit television still share one power on guard', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const ctx = setup({
    matter: {},
    config: { tvs: [{ label: 'Samsung 65 TV - Bedroom', ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' }] },
    powerOnSequence: async (args) => { calls.push(args); await gate; return 'on'; },
    getLocalInfo: async () => ({ reachable: false, powerState: 'standby' }),
  });
  // The first attempt fails after the TVs have been published over Matter.
  const original = ctx.api.publishExternalAccessories;
  let attempts = 0;
  ctx.api.publishExternalAccessories = (...a) => {
    attempts += 1;
    if (attempts === 1) throw new Error('publish failed');
    original(...a);
  };
  await launch(ctx);
  assert.equal(ctx.timers.length, 1);
  ctx.timers[0].fn();
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  const tvAcc = ctx.published.map((p) => p[1][0]).find((a) => a.displayName === 'Samsung 65 TV - Bedroom');
  assert.ok(tvAcc, 'the retry published the television');
  const power = matterRegistered(ctx).find((a) => a.UUID === tileUuid(BEDROOM, 'power'));
  await power.handlers.onOff.on();
  assert.equal(calls.length, 1);
  await tvAcc.getService(Service.Television).getCharacteristic(Characteristic.Active).handleSetRequest(1);
  assert.equal(calls.length, 1);
  release();
});

test('TV power on over Matter without ip and mac sends the cloud command', async () => {
  const ctx = setup({ matter: {} });
  await launch(ctx);
  await ctx.pollerState.onSnapshot(BEDROOM, { status: tvStatus, online: false });
  const power = matterRegistered(ctx).find((a) => a.UUID === tileUuid(BEDROOM, 'power'));
  await power.handlers.onOff.on();
  assert.deepEqual(ctx.sentCommands.map((c) => [c.id, c.commands[0].command]), [[BEDROOM, 'on']]);
});

test('the TVs are still the HomeKit external accessories in Matter mode', async () => {
  const ctx = setup({ matter: {} });
  await launch(ctx);
  assert.equal(ctx.published.length, 3);
  const bedroom = ctx.published.map((p) => p[1][0]).find((a) => a.displayName === 'Samsung 65 TV - Bedroom');
  assert.equal(bedroom.services.filter((s) => s.UUID === Service.InputSource.UUID).length, 3);
});

test('config schema has the connection settings and the version is 0.2.0', () => {
  const root = new URL('../', import.meta.url);
  const schema = JSON.parse(fs.readFileSync(new URL('config.schema.json', root), 'utf8'));
  const props = schema.schema.properties;
  assert.deepEqual(props.connection.enum, ['auto', 'homekit', 'matter']);
  assert.equal(props.connection.default, 'auto');
  // HomeKit names must start and end with a letter or number.
  assert.equal(props.name.default, 'SmartThings 5m5');
  assert.equal(props.leakAs.default, 'leak');
  assert.equal(props.fridgeTemperature.default, 'thermostat');
  assert.equal(JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version, '0.2.0');
});

test('Matter mode does not need a Matter capable cached accessory list', async () => {
  const ctx = setup({ matter: {}, config: { connection: 'matter' } });
  await launch(ctx);
  assert.equal(ctx.logs.warn.filter((l) => /switched on/.test(l)).length, 0);
});
