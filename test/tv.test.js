import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  tvState, powerOffCommand, powerOnCommand, inputCommand, volumeUpCommand, volumeDownCommand,
  setVolumeCommand, muteCommand, keyCommand, launchAppCommand,
} from '../src/devices/tv.js';

const status = JSON.parse(fs.readFileSync(new URL('./fixtures/tv-bedroom.status.json', import.meta.url), 'utf8'));
const withSwitch = (v) => {
  const s = structuredClone(status);
  s.components.main.switch.switch.value = v;
  return s;
};

test('recorded online TV with no local power', () => {
  assert.deepEqual(tvState({ status, online: true }), {
    on: false,
    volume: 15,
    muted: true,
    inputs: [{ id: 'dtv', name: 'TV' }, { id: 'HDMI1', name: 'XBOX Series X|S' }, { id: 'HDMI2', name: 'Bedroom TV' }],
    currentInputId: 'HDMI2',
    cloudPowerOn: true,
  });
});

test('cloud switch on gives on', () => {
  assert.equal(tvState({ status: withSwitch('on'), online: true }).on, true);
  assert.equal(tvState({ status: withSwitch('on'), online: true }, null).on, true);
});

test('offline with last switch on gives off', () => {
  assert.equal(tvState({ status: withSwitch('on'), online: false }).on, false);
});

test('local power on wins even offline', () => {
  assert.equal(tvState({ status, online: false }, 'on').on, true);
});

test('local standby wins over cloud on', () => {
  assert.equal(tvState({ status: withSwitch('on'), online: true }, 'standby').on, false);
});

test('missing input map gives empty inputs and null current', () => {
  const r = tvState({ status: {}, online: false });
  assert.deepEqual(r.inputs, []);
  assert.equal(r.currentInputId, null);
  assert.equal(r.volume, null);
  assert.equal(r.muted, false);
  assert.equal(r.cloudPowerOn, false);
});

test('cloudPowerOn accepts boolean true', () => {
  const s = structuredClone(status);
  s.components.main['samsungvd.supportsPowerOnByOcf'].supportsPowerOnByOcf.value = true;
  assert.equal(tvState({ status: s, online: true }).cloudPowerOn, true);
  s.components.main['samsungvd.supportsPowerOnByOcf'].supportsPowerOnByOcf.value = 'false';
  assert.equal(tvState({ status: s, online: true }).cloudPowerOn, false);
});

test('commands', () => {
  const c = (capability, command, args) => [{ component: 'main', capability, command, arguments: args }];
  assert.deepEqual(powerOffCommand(), c('switch', 'off', []));
  assert.deepEqual(powerOnCommand(), c('switch', 'on', []));
  assert.deepEqual(inputCommand('HDMI1'), c('samsungvd.mediaInputSource', 'setInputSource', ['HDMI1']));
  assert.deepEqual(volumeUpCommand(), c('audioVolume', 'volumeUp', []));
  assert.deepEqual(volumeDownCommand(), c('audioVolume', 'volumeDown', []));
  assert.deepEqual(setVolumeCommand(20), c('audioVolume', 'setVolume', [20]));
  assert.deepEqual(muteCommand(true), c('audioMute', 'setMute', ['muted']));
  assert.deepEqual(muteCommand(false), c('audioMute', 'setMute', ['unmuted']));
  assert.deepEqual(keyCommand('HOME'), c('samsungvd.remoteControl', 'send', ['HOME', 'PRESS_AND_RELEASED']));
  assert.deepEqual(launchAppCommand('111299001912'), c('custom.launchapp', 'launchApp', ['111299001912']));
});
