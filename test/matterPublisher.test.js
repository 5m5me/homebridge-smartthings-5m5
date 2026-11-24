import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MatterPublisher } from '../src/matter/matterPublisher.js';
import { moistureState } from '../src/devices/moisture.js';
import { laundryState, laundryCommand } from '../src/devices/laundry.js';
import { fridgeState, setpointCommand, powerCoolCommand } from '../src/devices/fridge.js';
import { tvState, powerOffCommand } from '../src/devices/tv.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const washerStatus = read('washer.status.json');
const fridgeStatus = read('fridge.status.json');
const moistureStatus = read('moisture.status.json');
const tvStatus = read('tv-bedroom.status.json');

const PLUGIN = 'homebridge-smartthings-5m5';
const PLATFORM = 'SmartThings5m5';

function fakeMatter({ failRegister = false, failUpdate = false, failCompose = false, failRegisterFor = null, failUnregisterFor = null } = {}) {
  const calls = [];
  const types = new Proxy({}, { get: (_, name) => (typeof name === 'string' ? `type:${name}` : undefined) });
  const deviceTypes = new Proxy({}, {
    get: (_, name) => {
      if (typeof name !== 'string') return undefined;
      if (name === 'Thermostat') {
        return { with: (server) => { if (failCompose) throw new Error('no compose'); return { composed: 'Thermostat', server }; } };
      }
      return types[name];
    },
  });
  return {
    calls,
    deviceTypes,
    deviceRequirements: { Thermostat: { ThermostatServer: { with: (...features) => `server:${features.join('+')}` } } },
    async registerPlatformAccessories(plugin, platform, accessories) {
      calls.push({ op: 'register', plugin, platform, accessories });
      if (failRegister) throw new Error('register boom');
      if (failRegisterFor?.(accessories)) throw new Error('tile boom');
    },
    async unregisterPlatformAccessories(plugin, platform, accessories) {
      calls.push({ op: 'unregister', plugin, platform, accessories });
      if (failUnregisterFor?.(accessories)) throw new Error('unregister boom');
    },
    async updateAccessoryState(uuid, cluster, attributes) {
      calls.push({ op: 'update', uuid, cluster, attributes });
      if (failUpdate) throw new Error('update boom');
    },
  };
}

function make({ matterOpts, sendCommands, setTimer } = {}) {
  const matter = fakeMatter(matterOpts);
  const cached = new Map();
  const sent = [];
  const client = { sendCommands: sendCommands ?? (async (id, commands) => { sent.push({ id, commands }); }) };
  const logs = { warn: [], debug: [] };
  const log = { info() {}, warn: (m) => logs.warn.push(m), error() {}, debug: (m) => logs.debug.push(m) };
  const publisher = new MatterPublisher({
    matter, uuidFor: (seed) => `uuid:${seed}`, cached, client, log, pluginName: PLUGIN, platformName: PLATFORM, ...(setTimer ? { setTimer } : {}),
  });
  return { matter, cached, sent, logs, publisher };
}
const ops = (matter, op) => matter.calls.filter((c) => c.op === op);
const registered = (matter) => ops(matter, 'register').flatMap((c) => c.accessories);

const washer = { deviceId: 'w1', label: 'Washing machine', deviceTypeName: 'Samsung OCF Washer' };
function washerState({ running = false, remote = false, finished = false } = {}) {
  const s = structuredClone(washerStatus);
  s.components.main.washerOperatingState.machineState.value = running ? 'run' : 'stop';
  s.components.main.remoteControlStatus ??= { remoteControlEnabled: {} };
  s.components.main.remoteControlStatus.remoteControlEnabled.value = remote ? 'true' : 'false';
  return { ...laundryState('washer', { status: s, online: true }), finished };
}

test('publish registers every tile with the right UUID, type, name, serial and context', async () => {
  const { matter, publisher } = make();
  const device = { deviceId: 'm1', label: 'Moisture Sensor 01', type: 'ZIGBEE' };
  await publisher.publish(device, 'moisture', () => moistureState({ status: moistureStatus, online: true }), {}, {});
  const calls = ops(matter, 'register');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.accessories.length === 1));
  assert.equal(calls[0].plugin, PLUGIN);
  assert.equal(calls[0].platform, PLATFORM);
  const [leak, temp] = calls.flatMap((c) => c.accessories);
  assert.equal(leak.UUID, 'uuid:smartthings-5m5:matter:m1:leak');
  assert.equal(leak.displayName, 'Moisture Sensor 01');
  assert.equal(leak.deviceType, 'type:LeakSensor');
  assert.equal(leak.serialNumber, 'm1-leak');
  assert.equal(leak.manufacturer, 'Samsung');
  assert.equal(leak.model, 'ZIGBEE');
  assert.deepEqual(leak.context, { deviceId: 'm1', tileId: 'leak' });
  assert.deepEqual(leak.clusters, { booleanState: { stateValue: false } });
  assert.equal(temp.UUID, 'uuid:smartthings-5m5:matter:m1:temp');
  assert.equal(temp.deviceType, 'type:TemperatureSensor');
  assert.equal(temp.displayName, 'Moisture Sensor 01 Temperature');
});

test('leakAs contact registers a ContactSensor', async () => {
  const { matter, publisher } = make();
  await publisher.publish({ deviceId: 'm1', label: 'S' }, 'moisture',
    () => moistureState({ status: moistureStatus, online: true }), { leakAs: 'contact' }, {});
  assert.equal(registered(matter)[0].deviceType, 'type:ContactSensor');
});

test('model prefers deviceTypeName and serial numbers stay distinct within 32 characters', async () => {
  const { matter, publisher } = make();
  const device = { deviceId: '00000000-0000-0000-0000-000000000010', label: 'Family Hub', deviceTypeName: 'Samsung OCF Refrigerator' };
  await publisher.publish(device, 'fridge', () => fridgeState({ status: fridgeStatus, online: true }), {}, {});
  const accessories = registered(matter);
  assert.ok(accessories.every((a) => a.model === 'Samsung OCF Refrigerator'));
  assert.ok(accessories.every((a) => a.serialNumber.length <= 32));
  assert.equal(new Set(accessories.map((a) => a.serialNumber)).size, accessories.length);
  assert.ok(accessories.find((a) => a.context.tileId === 'door-cooler').serialNumber.endsWith('-door-cooler'));
});

test('fridge thermostats are composed with the Cooling feature', async () => {
  const { matter, publisher } = make();
  await publisher.publish({ deviceId: 'f1', label: 'Family Hub' }, 'fridge',
    () => fridgeState({ status: fridgeStatus, online: true }), {}, {});
  const thermostat = registered(matter).find((a) => a.context.tileId === 'temp-freezer');
  assert.deepEqual(thermostat.deviceType, { composed: 'Thermostat', server: 'server:Cooling' });
  assert.equal(registered(matter).filter((a) => a.deviceType?.composed).length, 2);
});

test('when composing the thermostat fails, temperatures become sensors with one warning', async () => {
  const { matter, publisher, logs } = make({ matterOpts: { failCompose: true } });
  await publisher.publish({ deviceId: 'f1', label: 'Family Hub' }, 'fridge',
    () => fridgeState({ status: fridgeStatus, online: true }), {}, {});
  const temps = registered(matter).filter((a) => a.context.tileId.startsWith('temp-'));
  assert.deepEqual(temps.map((a) => a.deviceType), ['type:TemperatureSensor', 'type:TemperatureSensor']);
  assert.deepEqual(temps[1].clusters, { temperatureMeasurement: { measuredValue: -1900 } });
  assert.equal(logs.warn.filter((m) => /thermostat/i.test(m)).length, 1);
  assert.equal(temps[1].handlers.thermostat, undefined);
});

test('state is pushed after registering', async () => {
  const { matter, publisher } = make();
  await publisher.publish({ deviceId: 'm1', label: 'S' }, 'moisture',
    () => moistureState({ status: moistureStatus, online: true }), {}, {});
  const order = matter.calls.map((c) => c.op);
  assert.deepEqual(order, ['register', 'register', 'update', 'update']);
  assert.deepEqual(ops(matter, 'update').map((c) => [c.uuid, c.cluster, c.attributes]), [
    ['uuid:smartthings-5m5:matter:m1:leak', 'booleanState', { stateValue: false }],
    ['uuid:smartthings-5m5:matter:m1:temp', 'temperatureMeasurement', { measuredValue: 2510 }],
  ]);
});

test('an unchanged update pushes nothing; a changed update pushes only the changed cluster', async () => {
  const { matter, publisher } = make();
  const state = () => moistureState({ status: moistureStatus, online: true });
  const handle = await publisher.publish({ deviceId: 'm1', label: 'S' }, 'moisture', state, {}, {});
  matter.calls.length = 0;
  await handle.update(state());
  assert.deepEqual(matter.calls, []);
  const wet = structuredClone(moistureStatus);
  wet.components.main.waterSensor.water.value = 'wet';
  await handle.update(moistureState({ status: wet, online: true }));
  assert.deepEqual(matter.calls.map((c) => [c.op, c.uuid, c.cluster, c.attributes]), [
    ['update', 'uuid:smartthings-5m5:matter:m1:leak', 'booleanState', { stateValue: true }],
  ]);
});

test('the laundry Start tile is registered when remote control turns on and unregistered when it turns off', async () => {
  const { matter, publisher, cached } = make();
  const handle = await publisher.publish(washer, 'washer', () => washerState(), {}, {});
  assert.deepEqual(registered(matter).map((a) => a.context.tileId), ['running', 'finished']);
  matter.calls.length = 0;

  await handle.update(washerState({ remote: true }));
  assert.equal(ops(matter, 'register').length, 1);
  const start = ops(matter, 'register')[0].accessories;
  assert.deepEqual(start.map((a) => [a.context.tileId, a.displayName, a.deviceType]), [
    ['start', 'Washing machine Start', 'type:OnOffOutlet'],
  ]);
  assert.ok(cached.has(start[0].UUID));
  assert.deepEqual(ops(matter, 'update').map((c) => [c.cluster, c.attributes]), [['onOff', { onOff: false }]]);

  matter.calls.length = 0;
  await handle.update(washerState({ remote: false }));
  assert.equal(ops(matter, 'unregister').length, 1);
  assert.deepEqual(ops(matter, 'unregister')[0].accessories.map((a) => a.context.tileId), ['start']);
  assert.equal(cached.has(start[0].UUID), false);
  assert.equal(ops(matter, 'register').length, 0);
});

test('an on handler sends the commands for the device', async () => {
  const { matter, publisher, sent } = make();
  await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const startAcc = registered(matter).find((a) => a.context.tileId === 'start');
  await startAcc.handlers.onOff.on({}, {});
  assert.deepEqual(sent, [{ id: 'w1', commands: laundryCommand('washer', 'start') }]);
  // Off while not running changes nothing.
  const other = make();
  await other.publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const idle = registered(other.matter).find((a) => a.context.tileId === 'start');
  await idle.handlers.onOff.off({}, {});
  assert.equal(other.sent.length, 0);
});

test('handlers read the latest state, so an echo of our own update is ignored', async () => {
  const { matter, publisher, sent } = make();
  const handle = await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const startAcc = registered(matter).find((a) => a.context.tileId === 'start');
  await handle.update(washerState({ remote: true, running: true }));
  await startAcc.handlers.onOff.on({}, {});
  assert.deepEqual(sent, []);
  await startAcc.handlers.onOff.off({}, {});
  assert.deepEqual(sent, [{ id: 'w1', commands: laundryCommand('washer', 'pause') }]);
});

test('after a command the next update pushes the true state even if it equals the last value sent', async () => {
  const { matter, publisher } = make();
  const handle = await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const startAcc = registered(matter).find((a) => a.context.tileId === 'start');
  await startAcc.handlers.onOff.on();
  matter.calls.length = 0;
  // The washer did not start: the state is still off, but the controller thinks it is on.
  await handle.update(washerState({ remote: true }));
  assert.deepEqual(matter.calls.map((c) => [c.cluster, c.attributes]), [['onOff', { onOff: false }]]);
  matter.calls.length = 0;
  await handle.update(washerState({ remote: true }));
  assert.deepEqual(matter.calls, []);
});

test('a rejected sendCommands logs a warning, does not throw, and pushes the true state again', async () => {
  const { matter, publisher, logs } = make({ sendCommands: async () => { throw new Error('POST /devices/x/commands failed with 500'); } });
  await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const startAcc = registered(matter).find((a) => a.context.tileId === 'start');
  matter.calls.length = 0;
  await assert.doesNotReject(async () => startAcc.handlers.onOff.on({}, {}));
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /500/);
  assert.deepEqual(matter.calls.map((c) => [c.op, c.cluster, c.attributes]), [['update', 'onOff', { onOff: false }]]);
});

test('fridge handlers: outlet and thermostat setpoint', async () => {
  const { matter, publisher, sent } = make();
  await publisher.publish({ deviceId: 'f1', label: 'Family Hub' }, 'fridge',
    () => fridgeState({ status: fridgeStatus, online: true }), {}, {});
  const by = (id) => registered(matter).find((a) => a.context.tileId === id);
  await by('powercool').handlers.onOff.on();
  await by('temp-freezer').handlers.thermostat.occupiedCoolingSetpointChange({ occupiedCoolingSetpoint: -1800 });
  assert.deepEqual(sent, [
    { id: 'f1', commands: powerCoolCommand(true) },
    { id: 'f1', commands: setpointCommand('freezer', -18) },
  ]);
  // The setpoint just requested is the current one, so asking for it again is ignored.
  await by('temp-freezer').handlers.thermostat.occupiedCoolingSetpointChange({ occupiedCoolingSetpoint: -1800 });
  assert.equal(sent.length, 2);
});

test('a thermostat mode change snaps back to cooling', async () => {
  const { matter, publisher } = make();
  await publisher.publish({ deviceId: 'f1', label: 'Family Hub' }, 'fridge',
    () => fridgeState({ status: fridgeStatus, online: true }), {}, {});
  const freezer = registered(matter).find((a) => a.context.tileId === 'temp-freezer');
  matter.calls.length = 0;
  await freezer.handlers.thermostat.systemModeChange({ systemMode: 0, oldSystemMode: 3 });
  assert.equal(ops(matter, 'update')[0].attributes.systemMode, 3);
});

const tv = { deviceId: 't1', label: 'Samsung 65 TV - Bedroom', deviceTypeName: 'Samsung OCF TV' };
const tvOf = (on) => tvState({ status: tvStatus, online: true }, on ? 'on' : 'standby');

test('the TV on handler calls onTvPowerOn and sends nothing; off sends the power off command', async () => {
  const { matter, publisher, sent } = make();
  let powerOns = 0;
  const handle = await publisher.publish(tv, 'tv', () => tvOf(false), {}, { onTvPowerOn: async () => { powerOns += 1; } });
  const power = registered(matter)[0];
  await power.handlers.onOff.off(); // already off: nothing
  assert.deepEqual(sent, []);
  await power.handlers.onOff.on();
  assert.equal(powerOns, 1);
  assert.deepEqual(sent, []);
  await handle.update(tvOf(true));
  await power.handlers.onOff.off();
  assert.deepEqual(sent, [{ id: 't1', commands: powerOffCommand() }]);
});

test('a failing onTvPowerOn logs a warning, does not throw and pushes the true state', async () => {
  const { matter, publisher, logs } = make();
  await publisher.publish(tv, 'tv', () => tvOf(false), {}, { onTvPowerOn: async () => { throw new Error('nope'); } });
  const power = registered(matter)[0];
  matter.calls.length = 0;
  await assert.doesNotReject(async () => power.handlers.onOff.on());
  assert.equal(logs.warn.length, 1);
  assert.deepEqual(ops(matter, 'update').map((c) => c.attributes), [{ onOff: false }]);
});

test('removeStale unregisters only remembered accessories that are not live', async () => {
  const { matter, publisher, cached } = make();
  const liveDevice = { deviceId: 'w1', label: 'Washing machine' };
  await publisher.publish(liveDevice, 'washer', () => washerState(), {}, {});
  const remembered = (deviceId, tileId) => ({ UUID: `uuid:old:${deviceId}:${tileId}`, displayName: tileId, context: { deviceId, tileId } });
  const gone = remembered('gone', 'power');
  const oldStart = remembered('w1', 'start'); // a tile of a live device that is not wanted now
  cached.set(gone.UUID, gone);
  cached.set(oldStart.UUID, oldStart);
  matter.calls.length = 0;
  const count = await publisher.removeStale(['w1']);
  assert.equal(count, 2);
  const calls = ops(matter, 'unregister');
  assert.ok(calls.every((c) => c.accessories.length === 1));
  assert.deepEqual(calls.flatMap((c) => c.accessories).map((a) => a.UUID).sort(), [gone.UUID, oldStart.UUID].sort());
  assert.equal(cached.has(gone.UUID), false);
  // The live tiles are untouched.
  assert.ok(cached.has('uuid:smartthings-5m5:matter:w1:running'));
  assert.ok(cached.has('uuid:smartthings-5m5:matter:w1:finished'));
});

test('removeStale keeps remembered tiles of a live device that is still wanted', async () => {
  const { matter, publisher, cached } = make({ matterOpts: { failRegister: true } });
  await publisher.publish(washer, 'washer', () => washerState(), {}, {});
  const wantedButNotLive = { UUID: 'uuid:smartthings-5m5:matter:w1:running', displayName: 'r', context: { deviceId: 'w1', tileId: 'running' } };
  cached.set(wantedButNotLive.UUID, wantedButNotLive);
  matter.calls.length = 0;
  assert.equal(await publisher.removeStale(['w1']), 0);
  assert.deepEqual(ops(matter, 'unregister'), []);
});

test('removeAll unregisters every remembered accessory', async () => {
  const { matter, publisher, cached } = make();
  cached.set('a', { UUID: 'a', context: { deviceId: 'x' } });
  cached.set('b', { UUID: 'b', context: { deviceId: 'y' } });
  assert.equal(await publisher.removeAll(), 2);
  assert.deepEqual(ops(matter, 'unregister').map((c) => c.accessories.length), [1, 1]);
  assert.equal(cached.size, 0);
  assert.equal(await publisher.removeAll(), 0);
});

test('a registerPlatformAccessories rejection is caught, logged, and retried on the next update', async () => {
  const { matter, publisher, logs, cached } = make({ matterOpts: { failRegister: true } });
  const handle = await publisher.publish(washer, 'washer', () => washerState(), {}, {});
  assert.equal(logs.warn.length, 2);
  assert.match(logs.warn[0], /register boom/);
  assert.equal(ops(matter, 'update').length, 0);
  assert.equal(cached.size, 0);
  await handle.update(washerState());
  assert.equal(ops(matter, 'register').length, 4);
});

test('an updateAccessoryState rejection is only logged at debug level', async () => {
  const { publisher, logs } = make({ matterOpts: { failUpdate: true } });
  await assert.doesNotReject(() => publisher.publish(washer, 'washer', () => washerState(), {}, {}));
  assert.equal(logs.warn.length, 0);
  assert.ok(logs.debug.length > 0);
});

test('remove unregisters every tile of the device', async () => {
  const { matter, publisher, cached } = make();
  const handle = await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  matter.calls.length = 0;
  await handle.remove();
  assert.deepEqual(ops(matter, 'unregister').map((c) => c.accessories.length), [1, 1, 1]);
  assert.equal(cached.size, 0);
});

test('a tile whose type changes is unregistered and registered again', async () => {
  const { matter, publisher } = make();
  const state = (setpoint) => {
    const s = structuredClone(fridgeStatus);
    if (setpoint === null) delete s.components.freezer.thermostatCoolingSetpoint.coolingSetpointRange;
    return fridgeState({ status: s, online: true });
  };
  const handle = await publisher.publish({ deviceId: 'f1', label: 'Family Hub' }, 'fridge', () => state(1), {}, {});
  matter.calls.length = 0;
  await handle.update(state(null));
  assert.deepEqual(ops(matter, 'unregister')[0].accessories.map((a) => a.context.tileId), ['temp-freezer']);
  assert.equal(ops(matter, 'register')[0].accessories[0].deviceType, 'type:TemperatureSensor');
});

const fridgeDevice = { deviceId: 'f1', label: 'Family Hub' };
const fridgeNow = () => fridgeState({ status: fridgeStatus, online: true });

test('each tile is registered through its own call, and one failing tile does not stop the rest', async () => {
  let broken = true;
  const { matter, publisher, cached, logs } = make({
    matterOpts: { failRegisterFor: (accs) => broken && accs.some((a) => a.context.tileId === 'temp-cooler') },
  });
  const handle = await publisher.publish(fridgeDevice, 'fridge', fridgeNow, {}, {});
  const calls = ops(matter, 'register');
  assert.equal(calls.length, 7);
  assert.ok(calls.every((c) => c.accessories.length === 1));
  assert.equal(cached.size, 6);
  assert.equal(cached.has('uuid:smartthings-5m5:matter:f1:temp-cooler'), false);
  assert.equal(publisher.live.size, 6);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /Family Hub Fridge: tile boom|tile boom/);
  // State is pushed only for the tiles that are live.
  assert.equal(ops(matter, 'update').some((c) => c.uuid.endsWith('temp-cooler')), false);
  assert.ok(ops(matter, 'update').some((c) => c.uuid.endsWith('temp-freezer')));
  // The failed tile is tried again on a later update, and only that one.
  broken = false;
  matter.calls.length = 0;
  await handle.update(fridgeNow());
  assert.deepEqual(ops(matter, 'register').map((c) => c.accessories.map((a) => a.context.tileId)), [['temp-cooler']]);
  assert.equal(cached.size, 7);
  assert.equal(publisher.live.size, 7);
  assert.ok(ops(matter, 'update').some((c) => c.uuid.endsWith('temp-cooler')));
});

test('each tile is unregistered through its own call, and a failing one stays and is retried', async () => {
  let broken = true;
  const { matter, publisher, cached } = make({
    matterOpts: { failUnregisterFor: (accs) => broken && accs.some((a) => a.context.tileId === 'running') },
  });
  const handle = await publisher.publish(washer, 'washer', () => washerState(), {}, {});
  matter.calls.length = 0;
  await handle.remove();
  assert.deepEqual(ops(matter, 'unregister').map((c) => c.accessories.length), [1, 1]);
  assert.deepEqual([...cached.keys()], ['uuid:smartthings-5m5:matter:w1:running']);
  assert.equal(publisher.live.size, 1);
});

test('on then off inside one poll interval sends both commands', async () => {
  const { matter, publisher, sent } = make();
  await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const startAcc = registered(matter).find((a) => a.context.tileId === 'start');
  await startAcc.handlers.onOff.on();
  await startAcc.handlers.onOff.off();
  assert.deepEqual(sent, [
    { id: 'w1', commands: laundryCommand('washer', 'start') },
    { id: 'w1', commands: laundryCommand('washer', 'pause') },
  ]);
  // A command that failed does not change what the tile believes.
  const failing = make({ sendCommands: async () => { throw new Error('500'); } });
  await failing.publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const acc = registered(failing.matter).find((a) => a.context.tileId === 'start');
  await acc.handlers.onOff.on();
  await acc.handlers.onOff.off();
  assert.equal(failing.sent.length, 0);
});

test('an update replaces the optimistic value with the true state', async () => {
  const { matter, publisher, sent } = make();
  const handle = await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const startAcc = registered(matter).find((a) => a.context.tileId === 'start');
  await startAcc.handlers.onOff.on();
  await handle.update(washerState({ remote: true })); // still not running
  await startAcc.handlers.onOff.on();
  assert.equal(sent.length, 2);
});

test('a setpoint change is remembered until the next update', async () => {
  const { matter, publisher, sent } = make();
  const handle = await publisher.publish(fridgeDevice, 'fridge', fridgeNow, {}, {});
  const freezer = registered(matter).find((a) => a.context.tileId === 'temp-freezer');
  const change = (v) => freezer.handlers.thermostat.occupiedCoolingSetpointChange({ occupiedCoolingSetpoint: v });
  await change(-1800);
  await change(-1800); // the setpoint now in force: nothing
  assert.equal(sent.length, 1);
  await change(-1900); // back to the original value is a real change, not "no change"
  assert.deepEqual(sent, [
    { id: 'f1', commands: setpointCommand('freezer', -18) },
    { id: 'f1', commands: setpointCommand('freezer', -19) },
  ]);
  await handle.update(fridgeNow());
  await change(-1800);
  assert.equal(sent.length, 3);
});

function fakeTimer() {
  const timers = [];
  const setTimer = (fn, ms) => {
    const handle = { fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
    timers.push(handle);
    return handle;
  };
  return { timers, setTimer };
}

test('after a failed command the true state is pushed again after 1500 ms', async () => {
  const { timers, setTimer } = fakeTimer();
  const { matter, publisher } = make({ setTimer, sendCommands: async () => { throw new Error('500'); } });
  await publisher.publish(washer, 'washer', () => washerState({ remote: true }), {}, {});
  const startAcc = registered(matter).find((a) => a.context.tileId === 'start');
  matter.calls.length = 0;
  await startAcc.handlers.onOff.on();
  assert.equal(ops(matter, 'update').length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1500);
  assert.equal(timers[0].unrefed, true);
  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ops(matter, 'update').map((c) => c.attributes), [{ onOff: false }, { onOff: false }]);
});

test('a rejected thermostat mode change is pushed back now and after 1500 ms', async () => {
  const { timers, setTimer } = fakeTimer();
  const { matter, publisher } = make({ setTimer });
  await publisher.publish(fridgeDevice, 'fridge', fridgeNow, {}, {});
  const freezer = registered(matter).find((a) => a.context.tileId === 'temp-freezer');
  matter.calls.length = 0;
  await freezer.handlers.thermostat.systemModeChange({ systemMode: 0, oldSystemMode: 3 });
  assert.equal(ops(matter, 'update').length, 1);
  assert.deepEqual(timers.map((t) => t.ms), [1500]);
  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(ops(matter, 'update').length, 2);
  assert.equal(ops(matter, 'update')[1].attributes.systemMode, 3);
});

test('a timer that cannot be created does not break the handler', async () => {
  const { matter, publisher } = make({ setTimer: () => { throw new Error('no timers'); } });
  await publisher.publish(fridgeDevice, 'fridge', fridgeNow, {}, {});
  const freezer = registered(matter).find((a) => a.context.tileId === 'temp-freezer');
  await assert.doesNotReject(() => freezer.handlers.thermostat.systemModeChange({ systemMode: 0 }));
});

test('the publisher module does not import homebridge', () => {
  const src = fs.readFileSync(new URL('../src/matter/matterPublisher.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'homebridge|hap-nodejs/);
});
