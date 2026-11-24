import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/core/poller.js';

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, ms }); return id; },
    clearTimer: (h) => { timers.delete(h); },
    pending: () => [...timers.values()],
    async fire() {
      const [h, t] = [...timers.entries()][0];
      timers.delete(h);
      await t.fn();
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function setup({ health = 'ONLINE', status = { components: { a: 1 } } } = {}) {
  const calls = [];
  const snaps = [];
  const errors = [];
  const warns = [];
  const clock = { t: 0 };
  const state = { health, status };
  const client = {
    async getHealth(id) {
      calls.push(['health', id]);
      if (state.health instanceof Error) throw state.health;
      return state.health;
    },
    async getStatus(id) {
      calls.push(['status', id]);
      return state.status;
    },
  };
  const ft = fakeTimers();
  const poller = new Poller({
    client,
    onSnapshot: (id, snap) => snaps.push([id, snap]),
    onError: (id, err) => errors.push([id, err]),
    setTimer: ft.setTimer,
    clearTimer: ft.clearTimer,
    now: () => clock.t,
    log: { warn: (m) => warns.push(m) },
  });
  return { poller, calls, snaps, errors, warns, clock, state, ft };
}

test('online device calls health then status and delivers snapshot', async () => {
  const s = setup();
  s.poller.add('d1', 1000);
  await s.poller.pollNow('d1');
  assert.deepEqual(s.calls, [['health', 'd1'], ['status', 'd1']]);
  assert.deepEqual(s.snaps, [['d1', { status: { components: { a: 1 } }, online: true }]]);
});

test('offline device reuses last status and skips getStatus', async () => {
  const s = setup();
  s.poller.add('d1', 1000);
  await s.poller.pollNow('d1');
  s.calls.length = 0;
  s.state.health = 'OFFLINE';
  await s.poller.pollNow('d1');
  assert.deepEqual(s.calls, [['health', 'd1']]);
  assert.deepEqual(s.snaps[1], ['d1', { status: { components: { a: 1 } }, online: false }]);
});

test('first-ever offline poll delivers empty status', async () => {
  const s = setup({ health: 'OFFLINE' });
  s.poller.add('d1', 1000);
  await s.poller.pollNow('d1');
  assert.deepEqual(s.snaps, [['d1', { status: {}, online: false }]]);
});

test('next poll is scheduled after previous finished, intervalMs later', async () => {
  const s = setup();
  s.poller.add('d1', 1234);
  s.poller.start();
  assert.equal(s.ft.pending().length, 0);
  await tick();
  assert.equal(s.snaps.length, 1);
  assert.equal(s.ft.pending().length, 1);
  assert.equal(s.ft.pending()[0].ms, 1234);
  await s.ft.fire();
  await tick();
  assert.equal(s.snaps.length, 2);
  assert.equal(s.ft.pending().length, 1);
});

test('polls never overlap', async () => {
  const s = setup();
  let release;
  let healthCalls = 0;
  s.poller.client.getHealth = async () => {
    healthCalls += 1;
    await new Promise((r) => { release = r; });
    return 'ONLINE';
  };
  s.poller.add('d1', 1000);
  const p1 = s.poller.pollNow('d1');
  const p2 = s.poller.pollNow('d1');
  await tick();
  assert.equal(healthCalls, 1);
  release();
  await Promise.all([p1, p2]);
  assert.equal(healthCalls, 1);
  assert.equal(s.snaps.length, 1);
});

test('failed poll calls onError, not onSnapshot, and still schedules', async () => {
  const err = new Error('boom');
  const s = setup({ health: err });
  s.poller.add('d1', 500);
  s.poller.start();
  await tick();
  assert.equal(s.snaps.length, 0);
  assert.deepEqual(s.errors, [['d1', err]]);
  assert.equal(s.ft.pending().length, 1);
  assert.equal(s.ft.pending()[0].ms, 1000);
});

test('failed polls back off exponentially, cap at 5 minutes and reset on success', async () => {
  const s = setup({ health: new Error('boom') });
  s.poller.add('d1', 10000);
  s.poller.start();
  await tick();
  const seen = [s.ft.pending()[0].ms];
  for (let i = 0; i < 6; i += 1) {
    await s.ft.fire();
    await tick();
    seen.push(s.ft.pending()[0].ms);
  }
  assert.deepEqual(seen, [20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  s.state.health = 'ONLINE';
  await s.ft.fire();
  await tick();
  assert.equal(s.ft.pending()[0].ms, 10000);
  s.state.health = new Error('boom again');
  await s.ft.fire();
  await tick();
  assert.equal(s.ft.pending()[0].ms, 20000);
});

test('failure logging is limited to once per 60 seconds per device', async () => {
  const s = setup({ health: new Error('boom') });
  s.poller.add('d1', 500);
  await s.poller.pollNow('d1');
  s.clock.t = 30000;
  await s.poller.pollNow('d1');
  assert.equal(s.warns.length, 1);
  assert.equal(s.errors.length, 2);
  s.clock.t = 60001;
  await s.poller.pollNow('d1');
  assert.equal(s.warns.length, 2);
});

test('stop clears timers and no further polls run', async () => {
  const s = setup();
  s.poller.add('d1', 1000);
  s.poller.add('d2', 1000);
  s.poller.start();
  await tick();
  assert.equal(s.ft.pending().length, 2);
  s.poller.stop();
  assert.equal(s.ft.pending().length, 0);
  const n = s.calls.length;
  await tick();
  assert.equal(s.calls.length, n);
});

test('stop during an in-flight poll does not reschedule', async () => {
  const s = setup();
  let release;
  s.poller.client.getHealth = async () => {
    await new Promise((r) => { release = r; });
    return 'ONLINE';
  };
  s.poller.add('d1', 1000);
  s.poller.start();
  await tick();
  s.poller.stop();
  release();
  await tick();
  assert.equal(s.ft.pending().length, 0);
});

test('pollNow works without start and does not schedule', async () => {
  const s = setup();
  s.poller.add('d1', 1000);
  await s.poller.pollNow('d1');
  assert.equal(s.snaps.length, 1);
  assert.equal(s.ft.pending().length, 0);
});
