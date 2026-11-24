import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseConnection } from '../src/core/connection.js';

function run(setting, matterOn, hapOn) {
  const warnings = [];
  const result = chooseConnection(setting, matterOn, hapOn, (m) => warnings.push(m));
  return { result, warnings };
}

test('auto uses Matter when it is on, HomeKit otherwise, without warnings', () => {
  for (const setting of ['auto', undefined, null, 'nonsense', 42]) {
    for (const hapOn of [true, false]) {
      assert.deepEqual(run(setting, true, hapOn), { result: 'matter', warnings: [] });
      assert.deepEqual(run(setting, false, hapOn), { result: 'homekit', warnings: [] });
    }
  }
});

test('homekit is honoured when HAP is on, with or without Matter', () => {
  assert.deepEqual(run('homekit', true, true), { result: 'homekit', warnings: [] });
  assert.deepEqual(run('homekit', false, true), { result: 'homekit', warnings: [] });
});

test('homekit with HAP off and Matter on falls back to Matter with one warning', () => {
  const { result, warnings } = run('homekit', true, false);
  assert.equal(result, 'matter');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HomeKit/);
});

test('homekit with HAP off and Matter off stays on HomeKit without a warning', () => {
  assert.deepEqual(run('homekit', false, false), { result: 'homekit', warnings: [] });
});

test('matter is honoured when Matter is on', () => {
  assert.deepEqual(run('matter', true, true), { result: 'matter', warnings: [] });
  assert.deepEqual(run('matter', true, false), { result: 'matter', warnings: [] });
});

test('matter when Matter is off falls back to HomeKit with one warning', () => {
  for (const hapOn of [true, false]) {
    const { result, warnings } = run('matter', false, hapOn);
    assert.equal(result, 'homekit');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Matter/);
  }
});

test('no warning text contains an em dash', () => {
  for (const [s, m, h] of [['homekit', true, false], ['matter', false, true]]) {
    for (const w of run(s, m, h).warnings) assert.ok(!w.includes(String.fromCharCode(0x2014)));
  }
});
