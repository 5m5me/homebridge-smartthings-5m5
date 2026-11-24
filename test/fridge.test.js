import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  fridgeState, setpointCommand, powerCoolCommand, powerFreezeCommand, vacationCommand,
} from '../src/devices/fridge.js';

const status = JSON.parse(fs.readFileSync(new URL('./fixtures/fridge.status.json', import.meta.url), 'utf8'));

test('recorded fridge has cooler and freezer only', () => {
  const r = fridgeState({ status, online: true });
  assert.deepEqual(r.sections.map((s) => [s.id, s.name]), [['cooler', 'Fridge'], ['freezer', 'Freezer']]);
  assert.deepEqual(r.sections[0], {
    id: 'cooler', name: 'Fridge', doorOpen: false, temperatureC: 5, setpointC: 5, min: 1, max: 7, step: 1,
  });
  assert.deepEqual(r.sections[1], {
    id: 'freezer', name: 'Freezer', doorOpen: false, temperatureC: -19, setpointC: -19, min: -23, max: -15, step: 1,
  });
  assert.equal(r.powerCool, false);
  assert.equal(r.powerFreeze, false);
  assert.equal(r.vacation, false);
  assert.equal(r.fault, false);
});

test('open door', () => {
  const s = structuredClone(status);
  s.components.cooler.contactSensor.contact.value = 'open';
  const r = fridgeState({ status: s, online: true });
  assert.equal(r.sections[0].doorOpen, true);
  assert.equal(r.sections[1].doorOpen, false);
});

test('cvroom stays excluded when not disabled but null', () => {
  const s = structuredClone(status);
  const list = s.components.main['custom.disabledComponents'].disabledComponents.value;
  s.components.main['custom.disabledComponents'].disabledComponents.value = list.filter((x) => x !== 'cvroom');
  const r = fridgeState({ status: s, online: true });
  assert.deepEqual(r.sections.map((x) => x.id), ['cooler', 'freezer']);
});

test('cvroom included when disabled list lacks it and it has values', () => {
  const s = structuredClone(status);
  s.components.main['custom.disabledComponents'].disabledComponents.value = [];
  s.components.cvroom.temperatureMeasurement.temperature = { value: 3, unit: 'C' };
  const r = fridgeState({ status: s, online: true });
  assert.deepEqual(r.sections.map((x) => x.id), ['cooler', 'freezer', 'cvroom']);
  assert.equal(r.sections[2].name, 'Flex Zone');
  assert.equal(r.sections[2].min, null);
});

test('disabled component with values is excluded', () => {
  const s = structuredClone(status);
  s.components.main['custom.disabledComponents'].disabledComponents.value.push('freezer');
  const r = fridgeState({ status: s, online: true });
  assert.deepEqual(r.sections.map((x) => x.id), ['cooler']);
});

test('fahrenheit converts', () => {
  const s = structuredClone(status);
  s.components.cooler.temperatureMeasurement.temperature = { value: 41, unit: 'F' };
  assert.equal(fridgeState({ status: s, online: true }).sections[0].temperatureC, 5);
});

test('flags on', () => {
  const s = structuredClone(status);
  s.components.main.refrigeration.rapidCooling.value = 'on';
  s.components.main.refrigeration.rapidFreezing.value = 'on';
  s.components.main['samsungce.fridgeVacationMode'].vacationMode.value = 'on';
  const r = fridgeState({ status: s, online: true });
  assert.deepEqual([r.powerCool, r.powerFreeze, r.vacation], [true, true, true]);
});

test('offline keeps sections and sets fault', () => {
  const r = fridgeState({ status, online: false });
  assert.equal(r.fault, true);
  assert.equal(r.sections.length, 2);
});

test('empty status gives no sections', () => {
  const r = fridgeState({ status: {}, online: false });
  assert.deepEqual(r.sections, []);
});

test('commands', () => {
  assert.deepEqual(setpointCommand('freezer', -18), [
    { component: 'freezer', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [-18] },
  ]);
  assert.deepEqual(powerCoolCommand(true), [
    { component: 'main', capability: 'refrigeration', command: 'setRapidCooling', arguments: ['on'] },
  ]);
  assert.deepEqual(powerCoolCommand(false)[0].arguments, ['off']);
  assert.deepEqual(powerFreezeCommand(true), [
    { component: 'main', capability: 'refrigeration', command: 'setRapidFreezing', arguments: ['on'] },
  ]);
  assert.deepEqual(powerFreezeCommand(false)[0].arguments, ['off']);
  assert.deepEqual(vacationCommand(true), [
    { component: 'main', capability: 'samsungce.fridgeVacationMode', command: 'setVacationMode', arguments: ['on'] },
  ]);
  assert.deepEqual(vacationCommand(false)[0].arguments, ['off']);
});
