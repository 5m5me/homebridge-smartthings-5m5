import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { moistureState } from '../src/devices/moisture.js';

const status = JSON.parse(fs.readFileSync(new URL('./fixtures/moisture.status.json', import.meta.url), 'utf8'));

test('online recorded status', () => {
  assert.deepEqual(moistureState({ status, online: true }), {
    leak: false, temperatureC: 25.1, batteryPercent: 15, lowBattery: true, fault: false,
  });
});

test('wet gives leak', () => {
  const s = structuredClone(status);
  s.components.main.waterSensor.water.value = 'wet';
  assert.equal(moistureState({ status: s, online: true }).leak, true);
});

test('offline with empty status', () => {
  assert.deepEqual(moistureState({ status: {}, online: false }), {
    leak: false, temperatureC: null, batteryPercent: null, lowBattery: false, fault: true,
  });
});

test('fahrenheit converts', () => {
  const s = structuredClone(status);
  s.components.main.temperatureMeasurement.temperature = { value: 77, unit: 'F' };
  assert.equal(moistureState({ status: s, online: true }).temperatureC, 25);
});

test('battery at 20 is not low', () => {
  const s = structuredClone(status);
  s.components.main.battery.battery.value = 20;
  const r = moistureState({ status: s, online: true });
  assert.equal(r.batteryPercent, 20);
  assert.equal(r.lowBattery, false);
});
