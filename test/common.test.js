import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Accessory, Service, Characteristic, uuid } from '@homebridge/hap-nodejs';
import { sanitizeName, ensureService, setName } from '../src/homekit/common.js';

test('sanitizeName replaces disallowed characters with a space', () => {
  assert.equal(sanitizeName('XBOX Series X|S'), 'XBOX Series X S');
  assert.equal(sanitizeName('Samsung 85 TV - Lounge room'), 'Samsung 85 TV - Lounge room');
  assert.equal(sanitizeName("Ned's TV, 2nd floor."), "Ned's TV, 2nd floor.");
});

test('sanitizeName collapses repeated spaces and trims', () => {
  assert.equal(sanitizeName('  Hub  /  Room  '), 'Hub Room');
  assert.equal(sanitizeName('A***B'), 'A B');
});

test('sanitizeName falls back to Device when nothing is left', () => {
  assert.equal(sanitizeName('|||'), 'Device');
  assert.equal(sanitizeName(''), 'Device');
  assert.equal(sanitizeName(undefined), 'Device');
  assert.equal(sanitizeName(null), 'Device');
});

test('ensureService and setName sanitise the names they set', () => {
  const accessory = new Accessory('Test', uuid.generate('common'));
  const service = ensureService(accessory, Service.Switch, 'Fan|Light', 'a');
  assert.equal(service.displayName, 'Fan Light');
  setName(service, { Characteristic }, 'Fan|Light');
  assert.equal(service.getCharacteristic(Characteristic.Name).value, 'Fan Light');
});
