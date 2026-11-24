import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HAPStorage, Accessory, Service, Characteristic, uuid, HapStatusError, HAPStatus } from '@homebridge/hap-nodejs';
import { MoistureAccessory } from '../src/homekit/moistureAccessory.js';

const hap = { Service, Characteristic, HapStatusError, HAPStatus };
const status = JSON.parse(fs.readFileSync(new URL('./fixtures/moisture.status.json', import.meta.url), 'utf8'));
const device = { deviceId: 'd1', label: 'Moisture Sensor 01', type: 'ZIGBEE' };

function make() {
  const accessory = new Accessory(device.label, uuid.generate(device.label));
  const acc = new MoistureAccessory({ accessory, hap, device, client: {}, log: console });
  return { accessory, acc };
}
const val = (accessory, S, C) => accessory.getService(S).getCharacteristic(C).value;

// hap-nodejs rounds to the 0.1 step with float arithmetic, so compare with a tolerance.
const assertTemp = (accessory, v) =>
  assert.ok(Math.abs(val(accessory, Service.TemperatureSensor, Characteristic.CurrentTemperature) - v) < 1e-9);

test('recorded status', () => {
  const { accessory, acc } = make();
  acc.update({ status, online: true });
  assert.equal(val(accessory, Service.LeakSensor, Characteristic.LeakDetected), 0);
  assertTemp(accessory, 25.1);
  assert.equal(val(accessory, Service.Battery, Characteristic.BatteryLevel), 15);
  assert.equal(val(accessory, Service.LeakSensor, Characteristic.StatusLowBattery), 1);
  assert.equal(val(accessory, Service.Battery, Characteristic.StatusLowBattery), 1);
  assert.equal(val(accessory, Service.LeakSensor, Characteristic.StatusFault), 0);
  const info = accessory.getService(Service.AccessoryInformation);
  assert.equal(info.getCharacteristic(Characteristic.Manufacturer).value, 'Samsung');
  assert.equal(info.getCharacteristic(Characteristic.Model).value, 'ZIGBEE');
  assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, 'd1');
});

test('wet gives LeakDetected 1', () => {
  const { accessory, acc } = make();
  const s = structuredClone(status);
  s.components.main.waterSensor.water.value = 'wet';
  acc.update({ status: s, online: true });
  assert.equal(val(accessory, Service.LeakSensor, Characteristic.LeakDetected), 1);
});

test('offline with empty status faults and keeps temperature', () => {
  const { accessory, acc } = make();
  acc.update({ status, online: true });
  acc.update({ status: {}, online: false });
  assert.equal(val(accessory, Service.LeakSensor, Characteristic.StatusFault), 1);
  assertTemp(accessory, 25.1);
});

test('creating the class twice does not duplicate services', () => {
  const { accessory } = make();
  const before = accessory.services.length;
  new MoistureAccessory({ accessory, hap, device, client: {}, log: console });
  assert.equal(accessory.services.length, before);
});
