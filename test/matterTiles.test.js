import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matterTiles } from '../src/matter/matterTiles.js';
import { moistureState } from '../src/devices/moisture.js';
import { laundryState, laundryCommand } from '../src/devices/laundry.js';
import {
  fridgeState, setpointCommand, powerCoolCommand, powerFreezeCommand, vacationCommand,
} from '../src/devices/fridge.js';
import { tvState, powerOffCommand } from '../src/devices/tv.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const moistureStatus = read('moisture.status.json');
const washerStatus = read('washer.status.json');
const dryerStatus = read('dryer.status.json');
const fridgeStatus = read('fridge.status.json');
const tvStatus = read('tv-bedroom.status.json');

const byId = (tiles) => Object.fromEntries(tiles.map((t) => [t.id, t]));
const ids = (tiles) => tiles.map((t) => t.id);

function moisture({ wet = false, options = {}, status = moistureStatus } = {}) {
  const s = structuredClone(status);
  if (wet) s.components.main.waterSensor.water.value = 'wet';
  const state = moistureState({ status: s, online: true });
  return matterTiles('moisture', { deviceId: 'm1', label: 'Moisture Sensor 01' }, state, options);
}

test('moisture dry: leak sensor and temperature, nothing for battery or fault', () => {
  const tiles = moisture();
  assert.deepEqual(ids(tiles), ['leak', 'temp']);
  const t = byId(tiles);
  assert.equal(t.leak.name, 'Moisture Sensor 01');
  assert.equal(t.leak.type, 'LeakSensor');
  assert.deepEqual(t.leak.clusters, { booleanState: { stateValue: false } });
  assert.equal(t.temp.name, 'Moisture Sensor 01 Temperature');
  assert.equal(t.temp.type, 'TemperatureSensor');
  assert.deepEqual(t.temp.clusters, { temperatureMeasurement: { measuredValue: 2510 } });
  assert.equal(t.leak.command, undefined);
});

test('moisture wet: leak sensor is true', () => {
  assert.deepEqual(byId(moisture({ wet: true })).leak.clusters, { booleanState: { stateValue: true } });
});

test('moisture leakAs contact uses the contact convention, so a leak shows as open', () => {
  const dry = byId(moisture({ options: { leakAs: 'contact' } })).leak;
  assert.equal(dry.type, 'ContactSensor');
  assert.deepEqual(dry.clusters, { booleanState: { stateValue: true } });
  const wet = byId(moisture({ wet: true, options: { leakAs: 'contact' } })).leak;
  assert.deepEqual(wet.clusters, { booleanState: { stateValue: false } });
});

test('moisture without a temperature has no temperature tile', () => {
  const s = structuredClone(moistureStatus);
  delete s.components.main.temperatureMeasurement;
  assert.deepEqual(ids(moisture({ status: s })), ['leak']);
});

test('negative temperatures are hundredths of a degree', () => {
  const s = structuredClone(moistureStatus);
  s.components.main.temperatureMeasurement.temperature.value = -3.25;
  s.components.main.temperatureMeasurement.temperature.unit = 'C';
  assert.equal(byId(moisture({ status: s })).temp.clusters.temperatureMeasurement.measuredValue, -325);
});

function laundry(kind, status, { remote, running, finished = false } = {}) {
  const s = structuredClone(status);
  if (running !== undefined) s.components.main[`${kind}OperatingState`].machineState.value = running ? 'run' : 'stop';
  if (remote !== undefined) {
    s.components.main.remoteControlStatus ??= { remoteControlEnabled: {} };
    s.components.main.remoteControlStatus.remoteControlEnabled.value = remote ? 'true' : 'false';
  }
  const state = { ...laundryState(kind, { status: s, online: true }), finished };
  return { tiles: matterTiles(kind, { deviceId: 'w1', label: 'Washing machine' }, state, {}), state };
}

test('washer stopped with remote off: Running and Finished only', () => {
  const { tiles } = laundry('washer', washerStatus, { remote: false, running: false });
  assert.deepEqual(ids(tiles), ['running', 'finished']);
  const t = byId(tiles);
  assert.equal(t.running.name, 'Washing machine Running');
  assert.equal(t.running.type, 'MotionSensor');
  assert.deepEqual(t.running.clusters, { occupancySensing: { occupancy: { occupied: false } } });
  assert.equal(t.finished.name, 'Washing machine Finished');
  assert.equal(t.finished.type, 'ContactSensor');
  // Not finished means closed, which is true in the contact convention.
  assert.deepEqual(t.finished.clusters, { booleanState: { stateValue: true } });
});

test('washer running with remote on: three tiles and the Start tile is on', () => {
  const { tiles } = laundry('washer', washerStatus, { remote: true, running: true });
  assert.deepEqual(ids(tiles), ['running', 'finished', 'start']);
  const t = byId(tiles);
  assert.deepEqual(t.running.clusters, { occupancySensing: { occupancy: { occupied: true } } });
  assert.equal(t.start.name, 'Washing machine Start');
  assert.equal(t.start.type, 'OnOffOutlet');
  assert.deepEqual(t.start.clusters, { onOff: { onOff: true } });
});

test('washer finished shows open', () => {
  const { tiles } = laundry('washer', washerStatus, { remote: false, running: false, finished: true });
  assert.deepEqual(byId(tiles).finished.clusters, { booleanState: { stateValue: false } });
});

test('laundry Start commands match the existing builders and ignore no-ops', () => {
  const off = byId(laundry('washer', washerStatus, { remote: true, running: false }).tiles).start;
  assert.deepEqual(off.command('on'), laundryCommand('washer', 'start'));
  assert.equal(off.command('off'), null);
  const on = byId(laundry('washer', washerStatus, { remote: true, running: true }).tiles).start;
  assert.deepEqual(on.command('off'), laundryCommand('washer', 'pause'));
  assert.equal(on.command('on'), null);
  assert.equal(on.command('toggle'), null);
  assert.equal(on.command('somethingElse'), null);
});

test('dryer uses the dryer capability in its commands', () => {
  const { tiles } = laundry('dryer', dryerStatus, { remote: true, running: false });
  assert.deepEqual(byId(tiles).start.command('on'), laundryCommand('dryer', 'start'));
});

const fridgeDevice = { deviceId: 'f1', label: 'Family Hub' };
const fridge = (options = {}, mutate) => {
  const s = structuredClone(fridgeStatus);
  mutate?.(s);
  return matterTiles('fridge', fridgeDevice, fridgeState({ status: s, online: true }), options);
};

test('fridge tiles: ids, names and types', () => {
  const tiles = fridge();
  assert.deepEqual(ids(tiles), [
    'door-cooler', 'door-freezer', 'powercool', 'powerfreeze', 'vacation', 'temp-cooler', 'temp-freezer',
  ]);
  const t = byId(tiles);
  assert.equal(t['door-cooler'].name, 'Family Hub Fridge Door');
  assert.equal(t['door-freezer'].name, 'Family Hub Freezer Door');
  assert.equal(t['temp-cooler'].name, 'Family Hub Fridge');
  assert.equal(t['temp-freezer'].name, 'Family Hub Freezer');
  assert.equal(t['door-cooler'].type, 'ContactSensor');
  assert.equal(t['temp-cooler'].type, 'Thermostat');
  assert.equal(t.powercool.name, 'Family Hub Power Cool');
  assert.equal(t.powerfreeze.name, 'Family Hub Power Freeze');
  assert.equal(t.vacation.name, 'Family Hub Vacation Mode');
  for (const k of ['powercool', 'powerfreeze', 'vacation']) assert.equal(t[k].type, 'OnOffOutlet');
});

test('fridge doors: closed is true, open is false', () => {
  assert.deepEqual(byId(fridge())['door-cooler'].clusters, { booleanState: { stateValue: true } });
  const open = byId(fridge({}, (s) => { s.components.freezer.contactSensor.contact.value = 'open'; }));
  assert.deepEqual(open['door-freezer'].clusters, { booleanState: { stateValue: false } });
});

test('fridge thermostats: Matter units, limits and cooling only', () => {
  const t = byId(fridge());
  assert.deepEqual(t['temp-cooler'].clusters, {
    thermostat: {
      localTemperature: 500,
      occupiedCoolingSetpoint: 500,
      minCoolSetpointLimit: 100,
      maxCoolSetpointLimit: 700,
      absMinCoolSetpointLimit: 100,
      absMaxCoolSetpointLimit: 700,
      controlSequenceOfOperation: 0,
      systemMode: 3,
    },
  });
  const f = t['temp-freezer'].clusters.thermostat;
  assert.equal(f.localTemperature, -1900);
  assert.equal(f.occupiedCoolingSetpoint, -1900);
  assert.equal(f.minCoolSetpointLimit, -2300);
  assert.equal(f.maxCoolSetpointLimit, -1500);
  assert.equal(f.absMinCoolSetpointLimit, -2300);
  assert.equal(f.absMaxCoolSetpointLimit, -1500);
  assert.equal('occupiedHeatingSetpoint' in f, false);
});

test('fridgeTemperature sensor gives read-only temperature sensors with the same ids', () => {
  const tiles = fridge({ fridgeTemperature: 'sensor' });
  assert.deepEqual(ids(tiles), [
    'door-cooler', 'door-freezer', 'powercool', 'powerfreeze', 'vacation', 'temp-cooler', 'temp-freezer',
  ]);
  const t = byId(tiles);
  assert.equal(t['temp-freezer'].type, 'TemperatureSensor');
  assert.deepEqual(t['temp-freezer'].clusters, { temperatureMeasurement: { measuredValue: -1900 } });
  assert.equal(t['temp-freezer'].command, undefined);
  assert.equal(t['temp-freezer'].name, 'Family Hub Freezer');
});

test('a section without a range is a read-only temperature sensor', () => {
  const t = byId(fridge({}, (s) => { delete s.components.freezer.thermostatCoolingSetpoint.coolingSetpointRange; }));
  assert.equal(t['temp-freezer'].type, 'TemperatureSensor');
  assert.equal(t['temp-cooler'].type, 'Thermostat');
});

test('thermostat setpoint change to -18 sends the existing setpoint command', () => {
  const tile = byId(fridge())['temp-freezer'];
  assert.deepEqual(
    tile.command('occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: -1800, oldOccupiedCoolingSetpoint: -1900 }),
    setpointCommand('freezer', -18),
  );
});

test('thermostat setpoints are rounded to the step and clamped to the limits', () => {
  const tile = byId(fridge())['temp-freezer'];
  const change = (v) => tile.command('occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: v });
  assert.deepEqual(change(-1760), setpointCommand('freezer', -18));
  assert.deepEqual(change(-1740), setpointCommand('freezer', -17));
  assert.deepEqual(change(-3000), setpointCommand('freezer', -23));
  assert.deepEqual(change(0), setpointCommand('freezer', -15));
});

test('thermostat change that matches the current setpoint, or is not understood, returns null', () => {
  const tile = byId(fridge())['temp-freezer'];
  assert.equal(tile.command('occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: -1900 }), null);
  // Rounds to the current setpoint.
  assert.equal(tile.command('occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: -1920 }), null);
  assert.equal(tile.command('occupiedCoolingSetpointChange', {}), null);
  assert.equal(tile.command('occupiedCoolingSetpointChange'), null);
  assert.equal(tile.command('occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: 'x' }), null);
  assert.equal(tile.command('systemModeChange', { systemMode: 0 }), null);
});

test('fridge outlet commands use the existing builders and ignore no-ops', () => {
  const idle = byId(fridge());
  assert.deepEqual(idle.powercool.command('on'), powerCoolCommand(true));
  assert.deepEqual(idle.powerfreeze.command('on'), powerFreezeCommand(true));
  assert.deepEqual(idle.vacation.command('on'), vacationCommand(true));
  for (const k of ['powercool', 'powerfreeze', 'vacation']) assert.equal(idle[k].command('off'), null);
  const busy = byId(fridge({}, (s) => {
    s.components.main.refrigeration.rapidCooling.value = 'on';
    s.components.main.refrigeration.rapidFreezing.value = 'on';
    s.components.main['samsungce.fridgeVacationMode'].vacationMode.value = 'on';
  }));
  assert.deepEqual(busy.powercool.clusters, { onOff: { onOff: true } });
  assert.deepEqual(busy.powercool.command('off'), powerCoolCommand(false));
  assert.deepEqual(busy.powerfreeze.command('off'), powerFreezeCommand(false));
  assert.deepEqual(busy.vacation.command('off'), vacationCommand(false));
  for (const k of ['powercool', 'powerfreeze', 'vacation']) assert.equal(busy[k].command('on'), null);
});

function tv(on) {
  const state = tvState({ status: tvStatus, online: true }, on ? 'on' : 'standby');
  return matterTiles('tv', { deviceId: 't1', label: 'Samsung 65 TV - Bedroom' }, state, {});
}

test('tv is one outlet named after the device', () => {
  const tiles = tv(true);
  assert.deepEqual(ids(tiles), ['power']);
  assert.equal(tiles[0].name, 'Samsung 65 TV - Bedroom');
  assert.equal(tiles[0].type, 'OnOffOutlet');
  assert.deepEqual(tiles[0].clusters, { onOff: { onOff: true } });
  assert.deepEqual(tv(false)[0].clusters, { onOff: { onOff: false } });
});

test('tv on returns the marker, off returns the power off command, no-ops return null', () => {
  const off = tv(false)[0];
  assert.equal(off.command('on'), 'tv-power-on');
  assert.equal(off.command('off'), null);
  const on = tv(true)[0];
  assert.deepEqual(on.command('off'), powerOffCommand());
  assert.equal(on.command('on'), null);
});

test('names pass through sanitizeName', () => {
  const state = moistureState({ status: moistureStatus, online: true });
  const tiles = matterTiles('moisture', { deviceId: 'm1', label: 'Cellar|Sensor' }, state, {});
  assert.equal(tiles[0].name, 'Cellar Sensor');
  assert.equal(tiles[1].name, 'Cellar Sensor Temperature');
});

test('an unknown kind has no tiles', () => {
  assert.deepEqual(matterTiles('toaster', { deviceId: 'x' }, {}, {}), []);
});

test('tile modules do not import homebridge', () => {
  const src = fs.readFileSync(new URL('../src/matter/matterTiles.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'homebridge|hap-nodejs/);
});
