import path from 'node:path';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';
import { TokenProvider } from './api/tokenProvider.js';
import { SmartThingsClient } from './api/client.js';
import { classify } from './core/classify.js';
import { Poller } from './core/poller.js';
import { FinishTracker, laundryState } from './devices/laundry.js';
import { moistureState } from './devices/moisture.js';
import { fridgeState } from './devices/fridge.js';
import { tvState } from './devices/tv.js';
import { chooseConnection } from './core/connection.js';
import { MatterPublisher } from './matter/matterPublisher.js';
import { TvPowerOn } from './local/tvPowerOn.js';
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
    this.matterCached = new Map();
    this.connection = null;
    this.matterPublisher = null;
    this.matterHandles = new Map();
    this.tvPowerOns = new Map(); // device id -> the one power on guard of that TV, kept across discovery retries
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

  // Homebridge 2 hands back the Matter accessories it remembered from the last run.
  configureMatterAccessory(accessory) {
    this.matterCached.set(accessory.UUID, accessory);
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
    if (this.connection === null) this.#chooseConnection();
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

  #chooseConnection() {
    const { api, log } = this;
    const matterOn = typeof api.isMatterEnabled === 'function' && api.isMatterEnabled() && Boolean(api.matter);
    const hapOn = typeof api.isHapEnabled === 'function' ? api.isHapEnabled() : true;
    this.connection = chooseConnection(this.config.connection, matterOn, hapOn, (m) => log.warn(m));
    log.info(`Devices are published over ${this.connection === 'matter' ? 'Matter' : 'HomeKit'}.`);
  }

  #matterOptions() {
    return {
      leakAs: this.config.leakAs === 'contact' ? 'contact' : 'leak',
      fridgeTemperature: this.config.fridgeTemperature === 'sensor' ? 'sensor' : 'thermostat',
    };
  }

  #newMatterPublisher(client) {
    const { api, log } = this;
    // The publisher survives a discovery retry, so what is already registered is not registered twice.
    if (this.matterPublisher) {
      this.matterPublisher.client = client;
      return this.matterPublisher;
    }
    this.matterPublisher = new MatterPublisher({
      matter: api.matter,
      uuidFor: (seed) => api.hap.uuid.generate(seed),
      cached: this.matterCached,
      client,
      log,
      pluginName: PLUGIN_NAME,
      platformName: PLATFORM_NAME,
    });
    return this.matterPublisher;
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
    const matterMode = this.connection === 'matter';
    const matterOptions = this.#matterOptions();
    const publisher = matterMode ? this.#newMatterPublisher(client) : null;
    const matterDeviceIds = [];

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
        const handler = { ip: tvConfig?.ip, tv: true, device };
        let powerOn;
        if (matterMode) {
          // One guard for both connections: KEY_POWER toggles the TV, so two sequences must never overlap.
          // A discovery retry reuses the guard (and the Matter handle, which closed over it), so the
          // HomeKit television and the Matter tile of a later attempt still share one guard.
          powerOn = this.tvPowerOns.get(device.deviceId);
          if (!powerOn) {
            powerOn = new TvPowerOn({
              client,
              device,
              log,
              label: sanitizeName(label),
              tvConfig,
              tokenStore,
              powerOnSequence: this.deps.powerOnSequence,
              cloudPowerOn: () => Boolean(this.handlers.get(device.deviceId)?.state?.cloudPowerOn),
              // Look at the TV as soon as the sequence is over, instead of waiting for the next poll.
              onSettled: () => this.poller?.pollNow?.(device.deviceId),
            });
            this.tvPowerOns.set(device.deviceId, powerOn);
          }
          handler.powerOn = powerOn;
        }
        const tvDeps = { powerOnSequence: this.deps.powerOnSequence, ...(powerOn ? { powerOn } : {}) };
        const instance = new TvAccessory({ ...common, accessory, tvConfig, tokenStore, deps: tvDeps });
        handler.instance = instance;
        let snapshot = { status: {}, online: false };
        // SmartThings returns the last known state of an offline TV, so the inputs can exist before publishing.
        try {
          const status = await client.getStatus(device.deviceId);
          snapshot = { status, online: false };
          instance.update(snapshot);
        } catch (error) {
          log.warn(`Could not read the last known state of ${label}: ${error?.message ?? error}`);
        }
        tvAccessories.push(accessory);
        this.handlers.set(device.deviceId, handler);
        if (matterMode) {
          handler.state = tvState(snapshot);
          await this.#publishMatter(publisher, handler, device, kind, matterOptions, {
            onTvPowerOn: async () => {
              await powerOn.request();
              // While the sequence runs the tile shows on, so the Home app does not snap back.
              if (powerOn.pending !== null) await handler.matter?.update(this.#tvMatterState(handler));
            },
          });
          matterDeviceIds.push(device.deviceId);
        }
        poller.add(device.deviceId, intervals.tv);
        continue;
      }

      if (matterMode) {
        const handler = { kind, device };
        if (kind === 'washer' || kind === 'dryer') handler.finishTracker = new FinishTracker({ holdMs });
        let snapshot = { status: {}, online: false };
        if (!this.matterHandles.has(device.deviceId)) {
          try {
            snapshot = { status: await client.getStatus(device.deviceId), online: false };
          } catch (error) {
            log.warn(`Could not read the last known state of ${label}: ${error?.message ?? error}`);
          }
        }
        this.handlers.set(device.deviceId, handler);
        this.#matterState(handler, snapshot);
        await this.#publishMatter(publisher, handler, device, kind, matterOptions, {});
        matterDeviceIds.push(device.deviceId);
        poller.add(device.deviceId, kind === 'moisture' ? intervals.moisture : intervals.appliances);
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

    if (matterMode) {
      await this.#clearOtherConnection(publisher, matterDeviceIds);
    } else {
      const orphans = [...this.cached.entries()].filter(([uuid]) => !used.has(uuid)).map(([, a]) => a.displayName);
      if (orphans.length > 0) {
        log.warn(`Cached accessories with no matching SmartThings device (kept, not removed): ${orphans.join(', ')}`);
      }
      await this.#clearMatter();
    }

    poller.start();
  }

  // The state the Matter tiles are built from, the same pure functions the HomeKit accessories use.
  #matterState(handler, snapshot, localPower) {
    const { kind } = handler;
    if (handler.tv) {
      handler.state = tvState(snapshot, localPower);
    } else if (kind === 'moisture') {
      handler.state = moistureState(snapshot);
    } else if (kind === 'fridge') {
      handler.state = fridgeState(snapshot);
    } else {
      const state = laundryState(kind, snapshot);
      handler.state = { ...state, finished: handler.finishTracker.update(state.running) };
    }
    return handler.state;
  }

  #tvMatterState(handler) {
    return { ...handler.state, on: Boolean(handler.state?.on) || handler.powerOn?.pending !== null };
  }

  async #publishMatter(publisher, handler, device, kind, options, extras) {
    const existing = this.matterHandles.get(device.deviceId);
    if (existing) {
      handler.matter = existing;
      return;
    }
    const getState = () => (handler.tv ? this.#tvMatterState(handler) : handler.state);
    handler.matter = await publisher.publish(device, kind, getState, options, extras);
    this.matterHandles.set(device.deviceId, handler.matter);
  }

  // Everything remembered that is no longer wanted goes, and so do the bridged HomeKit accessories
  // of earlier runs, so nothing shows up twice.
  async #clearOtherConnection(publisher, liveDeviceIds) {
    const { api, log } = this;
    try {
      await publisher.removeStale(liveDeviceIds);
    } catch (error) {
      log.warn(`Could not remove old Matter accessories: ${error?.message ?? error}`);
    }
    if (this.cached.size === 0) return;
    const old = [...this.cached.values()];
    try {
      api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, old);
      this.cached.clear();
      log.info(`Removed ${old.length} bridged HomeKit accessories from earlier runs, because the devices are now published over Matter.`);
    } catch (error) {
      log.warn(`Could not remove the bridged HomeKit accessories: ${error?.message ?? error}`);
    }
  }

  async #clearMatter() {
    if (this.matterCached.size === 0 || !this.api.matter) return;
    try {
      const count = await this.#newMatterPublisher(undefined).removeAll();
      if (count > 0) {
        this.log.info(`Removed ${count} Matter accessories from earlier runs, because the devices are now published over HomeKit.`);
      }
    } catch (error) {
      this.log.warn(`Could not remove the Matter accessories: ${error?.message ?? error}`);
    }
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
        if (handler.matter) {
          this.#matterState(handler, snapshot, localPower);
          await handler.matter.update(this.#tvMatterState(handler));
        }
      } else if (handler.matter) {
        await handler.matter.update(this.#matterState(handler, snapshot));
      } else {
        handler.instance.update(snapshot);
      }
    } catch (error) {
      this.log.warn(`Could not update accessory for ${deviceId}: ${error?.message ?? error}`);
    }
  }
}
