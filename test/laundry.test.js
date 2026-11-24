import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { laundryState, laundryCommand, FinishTracker } from '../src/devices/laundry.js';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const washer = load('washer.status.json');
const dryer = load('dryer.status.json');

function withState(base, cap, machineState, remote) {
  const s = structuredClone(base);
  s.components.main[cap].machineState.value = machineState;
  s.components.main.remoteControlStatus = { remoteControlEnabled: { value: remote } };
  return s;
}

test('recorded washer', () => {
  assert.deepEqual(laundryState('washer', { status: washer, online: true }), {
    machineState: 'stop', running: false, paused: false, remoteEnabled: false,
  });
});

test('running and remote enabled (string)', () => {
  const s = withState(washer, 'washerOperatingState', 'run', 'true');
  assert.deepEqual(laundryState('washer', { status: s, online: true }), {
    machineState: 'run', running: true, paused: false, remoteEnabled: true,
  });
});

test('boolean true counts as remote enabled', () => {
  const s = withState(washer, 'washerOperatingState', 'run', true);
  assert.equal(laundryState('washer', { status: s, online: true }).remoteEnabled, true);
});

test('pause gives paused', () => {
  const s = withState(washer, 'washerOperatingState', 'pause', 'true');
  const r = laundryState('washer', { status: s, online: true });
  assert.equal(r.paused, true);
  assert.equal(r.running, false);
});

test('offline gives all false but keeps machineState', () => {
  const s = withState(washer, 'washerOperatingState', 'run', 'true');
  assert.deepEqual(laundryState('washer', { status: s, online: false }), {
    machineState: 'run', running: false, paused: false, remoteEnabled: false,
  });
});

test('offline with empty status', () => {
  assert.deepEqual(laundryState('dryer', { status: {}, online: false }), {
    machineState: null, running: false, paused: false, remoteEnabled: false,
  });
});

test('dryer reads dryerOperatingState', () => {
  const s = withState(dryer, 'dryerOperatingState', 'run', 'true');
  const r = laundryState('dryer', { status: s, online: true });
  assert.equal(r.machineState, 'run');
  assert.equal(r.running, true);
  assert.equal(laundryState('dryer', { status: dryer, online: true }).machineState,
    dryer.components.main.dryerOperatingState.machineState.value);
});

test('commands', () => {
  for (const kind of ['washer', 'dryer']) {
    const capability = `${kind}OperatingState`;
    assert.deepEqual(laundryCommand(kind, 'start'), [
      { component: 'main', capability, command: 'setMachineState', arguments: ['run'] },
    ]);
    assert.deepEqual(laundryCommand(kind, 'pause'), [
      { component: 'main', capability, command: 'setMachineState', arguments: ['pause'] },
    ]);
  }
});

function tracker(holdMs = 1000) {
  const clock = { t: 0 };
  return { clock, tr: new FinishTracker({ holdMs, now: () => clock.t }) };
}

test('FinishTracker: never running stays false', () => {
  const { tr } = tracker();
  assert.equal(tr.update(false), false);
  assert.equal(tr.update(false), false);
  assert.equal(tr.update(false), false);
});

test('FinishTracker: true then one false is not finished', () => {
  const { tr } = tracker();
  assert.equal(tr.update(true), false);
  assert.equal(tr.update(false), false);
});

test('FinishTracker: true, false, false is finished', () => {
  const { tr } = tracker();
  tr.update(true);
  tr.update(false);
  assert.equal(tr.update(false), true);
});

test('FinishTracker: stays true before holdMs, false after', () => {
  const { tr, clock } = tracker(1000);
  tr.update(true);
  tr.update(false);
  clock.t = 100;
  assert.equal(tr.update(false), true);
  clock.t = 1099;
  assert.equal(tr.update(false), true);
  clock.t = 1100;
  assert.equal(tr.update(false), false);
  clock.t = 5000;
  assert.equal(tr.update(false), false);
});

test('FinishTracker: running again clears finished at once', () => {
  const { tr } = tracker();
  tr.update(true);
  tr.update(false);
  assert.equal(tr.update(false), true);
  assert.equal(tr.update(true), false);
});

test('FinishTracker: a second cycle can finish again', () => {
  const { tr, clock } = tracker(1000);
  tr.update(true);
  tr.update(false);
  assert.equal(tr.update(false), true);
  clock.t = 2000;
  assert.equal(tr.update(false), false);
  assert.equal(tr.update(true), false);
  assert.equal(tr.update(false), false);
  assert.equal(tr.update(false), true);
});

test('FinishTracker: default holdMs is 30 minutes', () => {
  const clock = { t: 0 };
  const tr = new FinishTracker({ now: () => clock.t });
  tr.update(true);
  tr.update(false);
  tr.update(false);
  clock.t = 30 * 60 * 1000 - 1;
  assert.equal(tr.update(false), true);
  clock.t = 30 * 60 * 1000;
  assert.equal(tr.update(false), false);
});
