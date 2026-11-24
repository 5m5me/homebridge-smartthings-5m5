import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Accessory, Service, Characteristic, uuid, HapStatusError, HAPStatus } from '@homebridge/hap-nodejs';
import { LaundryAccessory } from '../src/homekit/laundryAccessory.js';
import { FinishTracker, laundryCommand } from '../src/devices/laundry.js';

const hap = { Service, Characteristic, HapStatusError, HAPStatus };
const washer = JSON.parse(fs.readFileSync(new URL('./fixtures/washer.status.json', import.meta.url), 'utf8'));
const device = { deviceId: 'w1', label: 'Washing machine', deviceTypeName: 'Samsung OCF Washer' };

function make({ fail = false } = {}) {
  const accessory = new Accessory(device.label, uuid.generate('w1'));
  const sent = [];
  const client = {
    async sendCommands(id, commands) {
      if (fail) throw new Error('boom');
      sent.push({ id, commands });
    },
  };
  const log = { warn() {}, info() {} };
  const acc = new LaundryAccessory({ accessory, hap, device, client, log, kind: 'washer', finishTracker: new FinishTracker() });
  return { accessory, acc, sent };
}
const sw = (a) => a.getServiceById(Service.Switch, 'startpause');
const occ = (a) => a.getServiceById(Service.OccupancySensor, 'running').getCharacteristic(Characteristic.OccupancyDetected).value;
const contact = (a) => a.getServiceById(Service.ContactSensor, 'finished').getCharacteristic(Characteristic.ContactSensorState).value;

function snap(state, remote) {
  const s = structuredClone(washer);
  s.components.main.washerOperatingState.machineState.value = state;
  s.components.main.remoteControlStatus.remoteControlEnabled.value = remote;
  return { status: s, online: true };
}

test('recorded washer', () => {
  const { accessory, acc } = make();
  acc.update({ status: washer, online: true });
  assert.equal(occ(accessory), 0);
  assert.equal(contact(accessory), 0);
  assert.equal(sw(accessory), undefined);
  assert.equal(accessory.getServiceById(Service.OccupancySensor, 'running').getCharacteristic(Characteristic.Name).value, 'Washing machine Running');
});

test('switch added while remote enabled and removed after', () => {
  const { accessory, acc } = make();
  acc.update(snap('run', 'true'));
  assert.equal(occ(accessory), 1);
  assert.equal(sw(accessory).getCharacteristic(Characteristic.On).value, true);
  assert.equal(sw(accessory).getCharacteristic(Characteristic.Name).value, 'Washing machine Start');
  acc.update(snap('run', 'false'));
  assert.equal(sw(accessory), undefined);
});

test('switch sets send start and pause', async () => {
  const { accessory, acc, sent } = make();
  acc.update(snap('stop', 'true'));
  await sw(accessory).getCharacteristic(Characteristic.On).handleSetRequest(true);
  await sw(accessory).getCharacteristic(Characteristic.On).handleSetRequest(false);
  assert.deepEqual(sent, [
    { id: 'w1', commands: laundryCommand('washer', 'start') },
    { id: 'w1', commands: laundryCommand('washer', 'pause') },
  ]);
});

test('run then two stopped updates gives finished', () => {
  const { accessory, acc } = make();
  acc.update(snap('run', 'false'));
  acc.update(snap('stop', 'false'));
  assert.equal(contact(accessory), 0);
  acc.update(snap('stop', 'false'));
  assert.equal(contact(accessory), 1);
});

test('rejected sendCommands throws HapStatusError', async () => {
  const { accessory, acc } = make({ fail: true });
  acc.update(snap('stop', 'true'));
  await assert.rejects(
    () => sw(accessory).getCharacteristic(Characteristic.On).handleSetRequest(true),
    // hap-nodejs converts a thrown HapStatusError into its numeric status code.
    (e) => e === HAPStatus.SERVICE_COMMUNICATION_FAILURE,
  );
});
