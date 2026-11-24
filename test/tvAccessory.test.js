import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Accessory, Service, Characteristic, uuid, Categories, HapStatusError, HAPStatus } from '@homebridge/hap-nodejs';
import { TvAccessory } from '../src/homekit/tvAccessory.js';
import * as tv from '../src/devices/tv.js';

const hap = { Service, Characteristic, HapStatusError, HAPStatus };
const status = JSON.parse(fs.readFileSync(new URL('./fixtures/tv-bedroom.status.json', import.meta.url), 'utf8'));
const device = { deviceId: 't1', label: 'Samsung 65 TV - Bedroom', deviceTypeName: 'Samsung OCF TV' };
const online = { status, online: true };

function make({ tvConfig, seq } = {}) {
  const accessory = new Accessory(device.label, uuid.generate('t1'), Categories.TELEVISION);
  const sent = [];
  const client = { async sendCommands(id, commands) { sent.push({ id, commands }); } };
  const calls = [];
  const powerOnSequence = seq ?? (async (args) => { calls.push(args); return 'on'; });
  const tokenStore = {};
  const acc = new TvAccessory({
    accessory, hap, device, client, log: { info() {}, warn() {} }, tvConfig, tokenStore, deps: { powerOnSequence },
  });
  return { accessory, acc, sent, calls, tokenStore };
}
const televisionOf = (a) => a.getService(Service.Television);
const inputs = (a) => a.services.filter((s) => s.UUID === Service.InputSource.UUID);
const set = (service, C, v) => service.getCharacteristic(C).handleSetRequest(v);

test('inputs built from SmartThings list', () => {
  const { accessory, acc } = make();
  acc.update({ status, online: false });
  const ins = inputs(accessory);
  assert.deepEqual(ins.map((s) => s.getCharacteristic(Characteristic.ConfiguredName).value), ['TV', 'XBOX Series X S', 'Bedroom TV']);
  assert.deepEqual(ins.map((s) => s.getCharacteristic(Characteristic.Identifier).value), [1, 2, 3]);
  assert.equal(televisionOf(accessory).getCharacteristic(Characteristic.Active).value, 0);
});

test('active identifier follows current input; Active reflects on', () => {
  const { accessory, acc } = make();
  acc.update(online);
  assert.equal(televisionOf(accessory).getCharacteristic(Characteristic.ActiveIdentifier).value, 3);
});

test('configured app is a fourth input and launches', async () => {
  const { accessory, acc, sent } = make({ tvConfig: { apps: [{ name: 'Netflix', appId: '11101200001' }] } });
  acc.update({ status, online: false });
  assert.equal(inputs(accessory).length, 4);
  assert.equal(inputs(accessory)[3].getCharacteristic(Characteristic.Identifier).value, 4);
  await set(televisionOf(accessory), Characteristic.ActiveIdentifier, 4);
  assert.deepEqual(sent, [{ id: 't1', commands: tv.launchAppCommand('11101200001') }]);
});

test('selecting identifier 2 sends HDMI1', async () => {
  const { accessory, acc, sent } = make();
  acc.update(online);
  await set(televisionOf(accessory), Characteristic.ActiveIdentifier, 2);
  assert.deepEqual(sent, [{ id: 't1', commands: tv.inputCommand('HDMI1') }]);
});

test('Active 0 sends power off', async () => {
  const { accessory, acc, sent } = make();
  acc.update(online);
  await set(televisionOf(accessory), Characteristic.Active, 0);
  assert.deepEqual(sent, [{ id: 't1', commands: tv.powerOffCommand() }]);
});

test('Active 1 without tvConfig sends cloud power on', async () => {
  const { accessory, acc, sent } = make();
  acc.update({ status, online: false });
  await set(televisionOf(accessory), Characteristic.Active, 1);
  assert.deepEqual(sent, [{ id: 't1', commands: tv.powerOnCommand() }]);
});

test('Active 1 with ip and mac runs the sequence without waiting', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const { accessory, acc, sent, tokenStore } = make({
    tvConfig: { ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' },
    seq: async (args) => { calls.push(args); await gate; return 'on'; },
  });
  acc.update({ status, online: false });
  await set(televisionOf(accessory), Characteristic.Active, 1); // returns although the sequence is pending
  assert.deepEqual(calls, [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.5', tokenStore }]);
  assert.ok(acc.pendingPowerOn);
  release();
  await acc.pendingPowerOn;
  assert.deepEqual(sent, []);
});

test('standby result with cloudPowerOn also sends cloud power on', async () => {
  const { accessory, acc, sent } = make({
    tvConfig: { ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' },
    seq: async () => 'standby',
  });
  acc.update(online); // fixture supports power on by OCF
  assert.equal(acc.state.cloudPowerOn, true);
  await set(televisionOf(accessory), Characteristic.Active, 1);
  await acc.pendingPowerOn;
  assert.deepEqual(sent, [{ id: 't1', commands: tv.powerOnCommand() }]);
});

test('standby result without cloudPowerOn sends nothing; on result sends nothing', async () => {
  const s = structuredClone(status);
  s.components.main['samsungvd.supportsPowerOnByOcf'].supportsPowerOnByOcf.value = 'false';
  const a = make({ tvConfig: { ip: 'i', mac: 'm' }, seq: async () => 'standby' });
  a.acc.update({ status: s, online: true });
  await set(televisionOf(a.accessory), Characteristic.Active, 1);
  await a.acc.pendingPowerOn;
  assert.deepEqual(a.sent, []);
  const b = make({ tvConfig: { ip: 'i', mac: 'm' }, seq: async () => 'on' });
  b.acc.update(online);
  await set(televisionOf(b.accessory), Characteristic.Active, 1);
  await b.acc.pendingPowerOn;
  assert.deepEqual(b.sent, []);
});

test('remote keys map to key commands', async () => {
  const { accessory, acc, sent } = make();
  acc.update(online);
  const RK = Characteristic.RemoteKey;
  const map = {
    ARROW_UP: 'UP', ARROW_DOWN: 'DOWN', ARROW_LEFT: 'LEFT', ARROW_RIGHT: 'RIGHT',
    SELECT: 'OK', BACK: 'BACK', EXIT: 'EXIT', PLAY_PAUSE: 'PLAY', INFORMATION: 'MENU',
  };
  for (const [hk, key] of Object.entries(map)) {
    sent.length = 0;
    await set(televisionOf(accessory), RK, RK[hk]);
    assert.deepEqual(sent, [{ id: 't1', commands: tv.keyCommand(key) }], hk);
  }
  sent.length = 0;
  await set(televisionOf(accessory), RK, RK.REWIND);
  assert.deepEqual(sent, []);
});

test('volume selector and mute', async () => {
  const { accessory, acc, sent } = make();
  acc.update(online);
  const sp = accessory.getService(Service.TelevisionSpeaker);
  await set(sp, Characteristic.VolumeSelector, Characteristic.VolumeSelector.INCREMENT);
  await set(sp, Characteristic.VolumeSelector, Characteristic.VolumeSelector.DECREMENT);
  await set(sp, Characteristic.Mute, true);
  await set(sp, Characteristic.Mute, false);
  assert.deepEqual(sent.map((s) => s.commands), [
    tv.volumeUpCommand(), tv.volumeDownCommand(), tv.muteCommand(true), tv.muteCommand(false),
  ]);
});

test('local power overrides an offline snapshot', () => {
  const { accessory, acc } = make();
  acc.update({ status: {}, online: false }, 'on');
  assert.equal(televisionOf(accessory).getCharacteristic(Characteristic.Active).value, 1);
});

test('second update does not add inputs', () => {
  const { accessory, acc } = make();
  acc.update(online);
  acc.update(online);
  assert.equal(inputs(accessory).length, 3);
});

test('a second Active 1 while a power on is pending does not start another sequence', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let count = 0;
  const { accessory, acc } = make({
    tvConfig: { ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' },
    seq: async () => { count += 1; await gate; return 'on'; },
  });
  acc.update({ status, online: false });
  await set(televisionOf(accessory), Characteristic.Active, 1);
  await set(televisionOf(accessory), Characteristic.Active, 1);
  assert.equal(count, 1);
  release();
  await acc.pendingPowerOn;
  assert.equal(acc.pendingPowerOn, null);
  await set(televisionOf(accessory), Characteristic.Active, 1);
  assert.equal(count, 2);
});

test('Active stays 1 during a pending power on even if an update says off', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { accessory, acc } = make({
    tvConfig: { ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' },
    seq: async () => { await gate; return 'on'; },
  });
  acc.update({ status, online: false });
  await set(televisionOf(accessory), Characteristic.Active, 1);
  acc.update({ status, online: false });
  assert.equal(televisionOf(accessory).getCharacteristic(Characteristic.Active).value, 1);
  release();
  await acc.pendingPowerOn;
  acc.update({ status, online: false });
  assert.equal(televisionOf(accessory).getCharacteristic(Characteristic.Active).value, 0);
});

test('every Name and ConfiguredName on the TV accessory is sanitised', () => {
  const { accessory, acc } = make({ tvConfig: { apps: [{ name: 'Prime|Video', appId: '1' }] } });
  acc.update({ status, online: false });
  const bad = /[^A-Za-z0-9 '.,-]/;
  for (const s of accessory.services) {
    for (const C of [Characteristic.Name, Characteristic.ConfiguredName]) {
      if (s.testCharacteristic(C)) assert.ok(!bad.test(s.getCharacteristic(C).value), s.getCharacteristic(C).value);
    }
    assert.ok(!bad.test(s.displayName), s.displayName);
  }
});
