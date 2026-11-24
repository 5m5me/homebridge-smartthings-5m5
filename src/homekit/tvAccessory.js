import {
  tvState, powerOffCommand, powerOnCommand, inputCommand, volumeUpCommand, volumeDownCommand,
  muteCommand, keyCommand, launchAppCommand,
} from '../devices/tv.js';
import { powerOnSequence as defaultPowerOnSequence } from '../local/samsungTv.js';
import { ensureService, setInfo, setName, sanitizeName, sendOrThrow } from './common.js';

const KEY_MAP = {
  ARROW_UP: 'UP',
  ARROW_DOWN: 'DOWN',
  ARROW_LEFT: 'LEFT',
  ARROW_RIGHT: 'RIGHT',
  SELECT: 'OK',
  BACK: 'BACK',
  EXIT: 'EXIT',
  PLAY_PAUSE: 'PLAY',
  INFORMATION: 'MENU',
};

export class TvAccessory {
  constructor({ accessory, hap, device, client, log, tvConfig, tokenStore, deps = {} }) {
    this.accessory = accessory;
    this.hap = hap;
    this.device = device;
    this.client = client;
    this.log = log;
    this.tvConfig = tvConfig;
    this.tokenStore = tokenStore;
    this.powerOnSequence = deps.powerOnSequence ?? defaultPowerOnSequence;
    this.entries = null; // built on the first update with inputs
    this.state = null;
    this.pendingPowerOn = null;
    const { Service, Characteristic } = hap;
    this.label = sanitizeName(device.label ?? device.name ?? 'TV');
    setInfo({ accessory, hap, device });

    this.tv = ensureService(accessory, Service.Television, this.label);
    this.tv.setCharacteristic(Characteristic.ConfiguredName, this.label);
    this.tv.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    this.speaker = ensureService(accessory, Service.TelevisionSpeaker, `${this.label} Speaker`, 'speaker');
    this.speaker.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE);
    this.speaker.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
    this.tv.addLinkedService(this.speaker);

    this.tv.getCharacteristic(Characteristic.Active).onSet((value) => this.#setActive(value));
    this.tv.getCharacteristic(Characteristic.ActiveIdentifier).onSet((value) => this.#setIdentifier(value));
    this.tv.getCharacteristic(Characteristic.RemoteKey).onSet((value) => this.#setRemoteKey(value));
    this.speaker.getCharacteristic(Characteristic.VolumeSelector).onSet((value) => this.#setVolume(value));
    this.speaker.getCharacteristic(Characteristic.Mute).onSet((value) => this.#setMute(value));
  }

  #send(commands) {
    return sendOrThrow(this, commands);
  }

  async #setActive(value) {
    if (!value) {
      await this.#send(powerOffCommand());
      return;
    }
    const cfg = this.tvConfig;
    if (!cfg?.ip || !cfg?.mac) {
      await this.#send(powerOnCommand());
      return;
    }
    // KEY_POWER toggles the TV, so never run two power on sequences at once.
    if (this.pendingPowerOn !== null) return;
    // Do not make HomeKit wait for the wake and key sequence.
    const pending = this.#localPowerOn(cfg).finally(() => {
      if (this.pendingPowerOn === pending) this.pendingPowerOn = null;
    });
    this.pendingPowerOn = pending;
  }

  async #localPowerOn({ mac, ip }) {
    try {
      const result = await this.powerOnSequence({ mac, ip, tokenStore: this.tokenStore });
      this.log?.info?.(`${this.label}: local power on finished with result ${result}`);
      if (result !== 'on' && this.state?.cloudPowerOn) {
        await this.client.sendCommands(this.device.deviceId, powerOnCommand());
      }
    } catch (error) {
      this.log?.warn?.(`${this.label}: power on failed: ${error?.message ?? error}`);
    }
  }

  async #setIdentifier(value) {
    const entry = this.entries?.find((e) => e.identifier === value);
    if (!entry) return;
    await this.#send(entry.kind === 'app' ? launchAppCommand(entry.appId) : inputCommand(entry.id));
  }

  async #setRemoteKey(value) {
    const { RemoteKey } = this.hap.Characteristic;
    const name = Object.keys(KEY_MAP).find((k) => RemoteKey[k] === value);
    if (!name) return;
    await this.#send(keyCommand(KEY_MAP[name]));
  }

  async #setVolume(value) {
    const { VolumeSelector } = this.hap.Characteristic;
    if (value === VolumeSelector.INCREMENT) await this.#send(volumeUpCommand());
    else if (value === VolumeSelector.DECREMENT) await this.#send(volumeDownCommand());
  }

  async #setMute(value) {
    await this.#send(muteCommand(Boolean(value)));
  }

  #buildInputs(state) {
    const { Service, Characteristic } = this.hap;
    const items = [
      ...state.inputs.map(({ id, name }) => ({ kind: 'input', id, name })),
      ...(this.tvConfig?.apps ?? []).map(({ name, appId }) => ({ kind: 'app', appId, name })),
    ];
    this.entries = items.map((item, i) => {
      const identifier = i + 1;
      const service = ensureService(this.accessory, Service.InputSource, item.name, `input-${identifier}`);
      service
        .setCharacteristic(Characteristic.Identifier, identifier)
        .setCharacteristic(Characteristic.ConfiguredName, sanitizeName(item.name))
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(
          Characteristic.InputSourceType,
          item.kind === 'app' ? Characteristic.InputSourceType.APPLICATION : Characteristic.InputSourceType.HDMI,
        )
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
      setName(service, this.hap, item.name);
      this.tv.addLinkedService(service);
      return { ...item, identifier, service };
    });
  }

  update(snapshot, localPower) {
    const { Characteristic } = this.hap;
    const state = tvState(snapshot, localPower);
    this.state = state;
    if (!this.entries && state.inputs.length > 0) this.#buildInputs(state);

    const active = state.on || this.pendingPowerOn !== null ? 1 : 0;
    this.tv.updateCharacteristic(Characteristic.Active, active);
    this.speaker.updateCharacteristic(Characteristic.Active, 1);
    this.speaker.updateCharacteristic(Characteristic.Mute, state.muted);
    const current = this.entries?.find((e) => e.kind === 'input' && e.id === state.currentInputId);
    if (current) this.tv.updateCharacteristic(Characteristic.ActiveIdentifier, current.identifier);
  }
}
