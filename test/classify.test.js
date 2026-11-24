import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classify } from '../src/core/classify.js';

const devices = JSON.parse(fs.readFileSync(new URL('./fixtures/devices.json', import.meta.url), 'utf8')).items;

test('fixture has 14 devices', () => {
  assert.equal(devices.length, 14);
});

test('classifies every fixture device', () => {
  const counts = {};
  for (const d of devices) {
    const k = String(classify(d));
    counts[k] = (counts[k] ?? 0) + 1;
  }
  assert.deepEqual(counts, { tv: 3, washer: 1, dryer: 1, fridge: 1, moisture: 4, null: 4 });
});

test('classifies by deviceTypeName', () => {
  assert.equal(classify({ deviceTypeName: 'Samsung OCF TV' }), 'tv');
  assert.equal(classify({ deviceTypeName: 'Samsung OCF Washer' }), 'washer');
  assert.equal(classify({ deviceTypeName: 'Samsung OCF Dryer' }), 'dryer');
  assert.equal(classify({ deviceTypeName: 'Samsung OCF Refrigerator' }), 'fridge');
});

test('classifies moisture by waterSensor on main', () => {
  const d = { components: [{ id: 'main', capabilities: [{ id: 'waterSensor', version: 1 }] }] };
  assert.equal(classify(d), 'moisture');
});

test('returns null for unknown', () => {
  assert.equal(classify({}), null);
  assert.equal(classify({ components: [{ id: 'other', capabilities: [{ id: 'waterSensor' }] }] }), null);
});
