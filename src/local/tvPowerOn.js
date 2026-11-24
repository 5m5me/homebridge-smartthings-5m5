import { powerOnCommand } from '../devices/tv.js';
import { powerOnSequence as defaultPowerOnSequence } from './samsungTv.js';

// The guarded power on behaviour shared by the HomeKit television and the Matter power tile.
// KEY_POWER toggles the TV, so never run two sequences at once, even from two connections.
export class TvPowerOn {
  constructor({ client, device, log, label, tvConfig, tokenStore, powerOnSequence, cloudPowerOn, onSettled }) {
    this.client = client;
    this.device = device;
    this.log = log;
    this.label = label ?? device?.label ?? 'TV';
    this.tvConfig = tvConfig;
    this.tokenStore = tokenStore;
    this.powerOnSequence = powerOnSequence ?? defaultPowerOnSequence;
    this.cloudPowerOn = cloudPowerOn ?? (() => false);
    this.onSettled = onSettled;
    this.pending = null;
  }

  // True when the local wake and key sequence is configured (ip and mac).
  get hasLocal() {
    return Boolean(this.tvConfig?.ip && this.tvConfig?.mac);
  }

  // Starts the local sequence unless one is already running. Does not wait for it.
  startLocal() {
    if (this.pending !== null) return;
    const pending = this.#localPowerOn(this.tvConfig).finally(() => {
      if (this.pending === pending) this.pending = null;
      try {
        this.onSettled?.();
      } catch {
        // A throwing callback must not break the power on.
      }
    });
    this.pending = pending;
  }

  // The whole power on request: the local sequence when configured, otherwise the cloud command.
  // A cloud failure is thrown to the caller.
  async request() {
    if (!this.hasLocal) {
      await this.client.sendCommands(this.device.deviceId, powerOnCommand());
      return;
    }
    this.startLocal();
  }

  async #localPowerOn({ mac, ip }) {
    try {
      const result = await this.powerOnSequence({ mac, ip, tokenStore: this.tokenStore });
      this.log?.info?.(`${this.label}: local power on finished with result ${result}`);
      if (result !== 'on' && this.cloudPowerOn()) {
        await this.client.sendCommands(this.device.deviceId, powerOnCommand());
      }
    } catch (error) {
      this.log?.warn?.(`${this.label}: power on failed: ${error?.message ?? error}`);
    }
  }
}
