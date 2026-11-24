import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Accessory, Service, Characteristic, uuid, HapStatusError, HAPStatus } from '@homebridge/hap-nodejs';
import { FridgeAccessory } from '../src/homekit/fridgeAccessory.js';
import { setpointCommand, powerCoolCommand, powerFreezeCommand, vacationCommand } from '../src/devices/fridge.js';

const hap = { Service, Characteristic, HapStatusError, HAPStatus };
const status = JSON.parse(fs.readFileSync(new URL('./fixtures/fridge.status.json', import.meta.url), 'utf8'));
const device = { deviceId: 'f1', label: 'Family Hub', deviceTypeName: 'Samsung OCF Refrigerator' };

function make() {
  const accessory = new Accessory(device.label, uuid.generate('f1'));
  const sent = [];
  const client = { async sendCommands(id, commands) { sent.push({ id, commands }); } };
  const acc = new FridgeAccessory({ accessory, hap, device, client, log: { warn() {} } });
  acc.update({ status, online: true });
  return { accessory, acc, sent };
}
const door = (a, id) => a.getServiceById(Service.ContactSensor, `door-${id}`);
const temp = (a, id) => a.getServiceById(Service.Thermostat, `temp-${id}`);
const sw = (a, id) => a.getServiceById(Service.Switch, id);

test('door sensors and thermostats from recorded status', () => {
  const { accessory } = make();
  for (const id of ['cooler', 'freezer']) {
    assert.equal(door(accessory, id).getCharacteristic(Characteristic.ContactSensorState).value, 0);
  }
  assert.equal(door(accessory, 'cooler').getCharacteristic(Characteristic.Name).value, 'Fridge Door');
  assert.equal(temp(accessory, 'freezer').getCharacteristic(Characteristic.Name).value, 'Freezer');
  const t = (id, C) => temp(accessory, id).getCharacteristic(C);
  assert.equal(t('cooler', Characteristic.CurrentTemperature).value, 5);
  assert.equal(t('freezer', Characteristic.CurrentTemperature).value, -19);
  assert.equal(t('cooler', Characteristic.TargetTemperature).value, 5);
  assert.equal(t('freezer', Characteristic.TargetTemperature).value, -19);
  assert.deepEqual(
    [t('cooler', Characteristic.TargetTemperature).props.minValue, t('cooler', Characteristic.TargetTemperature).props.maxValue],
    [1, 7],
  );
  const fp = t('freezer', Characteristic.TargetTemperature).props;
  assert.deepEqual([fp.minValue, fp.maxValue, fp.minStep], [-23, -15, 1]);
  assert.equal(t('freezer', Characteristic.TargetHeatingCoolingState).value, Characteristic.TargetHeatingCoolingState.COOL);
  assert.deepEqual(t('freezer', Characteristic.TargetHeatingCoolingState).props.validValues, [2]);
  assert.equal(t('freezer', Characteristic.TemperatureDisplayUnits).value, 0);
});

test('no services for cvroom', () => {
  const { accessory } = make();
  assert.equal(door(accessory, 'cvroom'), undefined);
  assert.equal(temp(accessory, 'cvroom'), undefined);
});

test('setting freezer target sends setpoint command', async () => {
  const { accessory, sent } = make();
  await temp(accessory, 'freezer').getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(-18);
  assert.deepEqual(sent, [{ id: 'f1', commands: setpointCommand('freezer', -18) }]);
});

test('switches send their commands', async () => {
  const { accessory, sent } = make();
  const on = (id) => sw(accessory, id).getCharacteristic(Characteristic.On);
  await on('powercool').handleSetRequest(true);
  await on('powercool').handleSetRequest(false);
  await on('powerfreeze').handleSetRequest(true);
  await on('powerfreeze').handleSetRequest(false);
  await on('vacation').handleSetRequest(true);
  await on('vacation').handleSetRequest(false);
  assert.deepEqual(sent.map((s) => s.commands), [
    powerCoolCommand(true), powerCoolCommand(false),
    powerFreezeCommand(true), powerFreezeCommand(false),
    vacationCommand(true), vacationCommand(false),
  ]);
  assert.equal(sw(accessory, 'powercool').getCharacteristic(Characteristic.Name).value, 'Power Cool');
  assert.equal(sw(accessory, 'vacation').getCharacteristic(Characteristic.Name).value, 'Vacation Mode');
});

test('open cooler door reads 1', () => {
  const { accessory, acc } = make();
  const s = structuredClone(status);
  s.components.cooler.contactSensor.contact.value = 'open';
  acc.update({ status: s, online: true });
  assert.equal(door(accessory, 'cooler').getCharacteristic(Characteristic.ContactSensorState).value, 1);
  assert.equal(door(accessory, 'freezer').getCharacteristic(Characteristic.ContactSensorState).value, 0);
});
