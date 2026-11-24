import path from 'node:path';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';
import { TokenProvider } from './api/tokenProvider.js';
import { SmartThingsClient } from './api/client.js';
import { classify } from './core/classify.js';
import { Poller } from './core/poller.js';
import { FinishTracker } from './devices/laundry.js';
import { getLocalInfo as defaultGetLocalInfo } from './local/samsungTv.js';
import { LocalTokenStore } from './local/localTokenStore.js';
import { MoistureAccessory } from './homekit/moistureAccessory.js';
import { LaundryAccessory } from './homekit/laundryAccessory.js';
import { FridgeAccessory } from './homekit/fridgeAccessory.js';
import { TvAccessory } from './homekit/tvAccessory.js';
import { sanitizeName } from './homekit/common.js';

const DEFAULT_POLL_SECONDS = { sensors: 30, appliances: 15, tvs: 20 };
const RETRY_MS = 60 * 1000;
const MIN_POLL_MS = 5 * 1000;

export class SmartThings5m5Platform {
  constructor(log, config, api, deps = {}) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.deps = deps;
    this.cached = new Map();
    this.handlers = new Map();
    this.retryTimer = null;
    this.poller = null;

    api.on('didFinishLaunching', () => this.#launch());
    api.on('shutdown', () => {
      this.poller?.stop?.();
      if (this.retryTimer !== null) (this.deps.clearTimer ?? clearTimeout)(this.retryTimer);
      this.retryTimer = null;
    });
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  #hasCredentials() {
    const { accessToken, oauth } = this.config;
    return Boolean(accessToken || (oauth?.clientId && oauth?.clientSecret && oauth?.refreshToken));
  }

  async #launch() {
    if (!this.#hasCredentials()) {
      this.log.error('No SmartThings credentials configured. Set accessToken or the oauth block, then restart Homebridge.');
      return;
    }
    try {
      await this.discover();
    } catch (error) {
      this.log.error(`SmartThings discovery failed: ${error?.message ?? error}. Retrying in 60 seconds.`);
      this.retryTimer = (this.deps.setTimer ?? setTimeout)(() => {
        this.retryTimer = null;
        this.#launch();
      }, RETRY_MS);
      this.retryTimer?.unref?.();
    }
  }

  #intervals() {
    const p = { ...DEFAULT_POLL_SECONDS, ...(this.config.pollSeconds ?? {}) };
    const ms = (v, d) => Math.max(MIN_POLL_MS, (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d) * 1000);
    return {
      moisture: ms(p.sensors, DEFAULT_POLL_SECONDS.sensors),
      appliances: ms(p.appliances, DEFAULT_POLL_SECONDS.appliances),
      tv: ms(p.tvs, DEFAULT_POLL_SECONDS.tvs),
    };
  }

  async discover() {
    const { api, config, log } = this;
    const storagePath = api.user.storagePath();
    const oauth = config.oauth?.clientId && config.oauth?.clientSecret && config.oauth?.refreshToken
      ? config.oauth
      : undefined;
    const tokenProvider = (this.deps.createTokenProvider ?? ((o) => new TokenProvider(o)))({
      accessToken: config.accessToken,
      oauth,
      storagePath: path.join(storagePath, 'smartthings-5m5-tokens.json'),
      log,
    });
    const client = (this.deps.createClient ?? ((o) => new SmartThingsClient(o)))({ tokenProvider, log });
    const tokenStore = new LocalTokenStore(path.join(storagePath, 'smartthings-5m5-tv-tokens.json'));
    const getLocalInfo = this.deps.getLocalInfo ?? defaultGetLocalInfo;
    const poller = (this.deps.createPoller ?? ((o) => new Poller(o)))({
      client,
      log,
      onSnapshot: (deviceId, snapshot) => this.#onSnapshot(deviceId, snapshot, getLocalInfo),
      onError: () => {},
    });

    const devices = await client.listDevices();

    const ignore = new Set(config.ignoreDevices ?? []);
    const intervals = this.#intervals();
    const holdMs = (Number(config.finishedHoldMinutes) > 0 ? Number(config.finishedHoldMinutes) : 30) * 60 * 1000;
    const unhandled = [];
    const used = new Set();
    this.handlers = new Map();
    this.poller = poller;
    const tvAccessories = [];

    for (const device of devices) {
      const label = device.label ?? device.name ?? device.deviceId;
      if (ignore.has(label)) continue;
      const kind = classify(device);
      if (!kind) {
        unhandled.push(label);
        continue;
      }
      const uuid = api.hap.uuid.generate(`smartthings-5m5:${device.deviceId}`);
      used.add(uuid);
      const common = { hap: api.hap, device, client, log };

      if (kind === 'tv') {
        const accessory = new api.platformAccessory(sanitizeName(label), uuid, api.hap.Categories.TELEVISION);
        const tvConfig = (config.tvs ?? []).find((t) => t.label === label);
        const instance = new TvAccessory({ ...common, accessory, tvConfig, tokenStore });
        // SmartThings returns the last known state of an offline TV, so the inputs can exist before publishing.
        try {
          const status = await client.getStatus(device.deviceId);
          instance.update({ status, online: false });
        } catch (error) {
          log.warn(`Could not read the last known state of ${label}: ${error?.message ?? error}`);
        }
        tvAccessories.push(accessory);
        this.handlers.set(device.deviceId, { instance, ip: tvConfig?.ip, tv: true });
        poller.add(device.deviceId, intervals.tv);
        continue;
      }

      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new api.platformAccessory(sanitizeName(label), uuid);
        api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.set(uuid, accessory);
      }
      let instance;
      let interval = intervals.appliances;
      if (kind === 'moisture') {
        instance = new MoistureAccessory({ ...common, accessory });
        interval = intervals.moisture;
      } else if (kind === 'fridge') {
        instance = new FridgeAccessory({ ...common, accessory });
      } else {
        instance = new LaundryAccessory({ ...common, accessory, kind, finishTracker: new FinishTracker({ holdMs }) });
      }
      this.handlers.set(device.deviceId, { instance });
      poller.add(device.deviceId, interval);
    }

    for (const accessory of tvAccessories) api.publishExternalAccessories(PLUGIN_NAME, [accessory]);

    if (unhandled.length > 0) log.info(`Unhandled SmartThings devices: ${unhandled.join(', ')}`);

    const orphans = [...this.cached.entries()].filter(([uuid]) => !used.has(uuid)).map(([, a]) => a.displayName);
    if (orphans.length > 0) {
      log.warn(`Cached accessories with no matching SmartThings device (kept, not removed): ${orphans.join(', ')}`);
    }

    poller.start();
  }

  async #onSnapshot(deviceId, snapshot, getLocalInfo) {
    const handler = this.handlers.get(deviceId);
    if (!handler) return;
    try {
      if (handler.tv) {
        let localPower;
        if (handler.ip) {
          try {
            localPower = (await getLocalInfo(handler.ip))?.powerState ?? undefined;
          } catch {
            localPower = undefined;
          }
        }
        handler.instance.update(snapshot, localPower);
      } else {
        handler.instance.update(snapshot);
      }
    } catch (error) {
      this.log.warn(`Could not update accessory for ${deviceId}: ${error?.message ?? error}`);
    }
  }
}
