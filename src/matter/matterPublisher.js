// Publishes the tiles of each device as top-level Matter accessories through Homebridge 2's
// Matter API. Imports nothing from Homebridge: the API arrives through the constructor.
import { matterTiles, asTemperatureSensor, TV_POWER_ON } from './matterTiles.js';

// Handler names wired for each tile type (everything else is read only).
const HANDLERS = {
  OnOffOutlet: { onOff: ['on', 'off'] },
  Thermostat: { thermostat: ['occupiedCoolingSetpointChange', 'systemModeChange'] },
};

function serialFor(deviceId, tileId) {
  const full = `${deviceId}-${tileId}`;
  if (full.length <= 32) return full;
  // Keep the tile id, so tiles of one device keep different serial numbers.
  const room = 32 - tileId.length - 1;
  return room > 0 ? `${String(deviceId).slice(0, room)}-${tileId}` : full.slice(0, 32);
}

const SNAP_BACK_MS = 1500;

const messageOf = (error) => error?.message ?? String(error);

export class MatterPublisher {
  constructor({ matter, uuidFor, cached, client, log, pluginName, platformName, setTimer = setTimeout }) {
    this.matter = matter;
    this.uuidFor = uuidFor;
    this.cached = cached;
    this.client = client;
    this.log = log;
    this.pluginName = pluginName;
    this.platformName = platformName;
    this.setTimer = setTimer;
    this.live = new Map(); // uuid -> accessory registered by this run
    this.wanted = new Map(); // deviceId -> Set of uuids the device's tiles should have right now
    this.thermostatType = undefined; // composed once, null when composing failed
  }

  #uuid(deviceId, tileId) {
    return this.uuidFor(`smartthings-5m5:matter:${deviceId}:${tileId}`);
  }

  #debug(message) {
    this.log?.debug?.(message);
  }

  #warn(message) {
    this.log?.warn?.(message);
  }

  // Every matter.* call goes through here: awaited, and a failure never escapes.
  async #call(what, fn) {
    try {
      await fn();
      return true;
    } catch (error) {
      this.#warn(`Matter: could not ${what}: ${messageOf(error)}`);
      return false;
    }
  }

  // Cooling only thermostat: the stock type picks its features from the declared setpoints, so
  // compose the Cooling feature explicitly. Null when this Homebridge cannot do it.
  #thermostat() {
    if (this.thermostatType !== undefined) return this.thermostatType;
    try {
      const { deviceTypes, deviceRequirements } = this.matter;
      this.thermostatType = deviceTypes.Thermostat.with(deviceRequirements.Thermostat.ThermostatServer.with('Cooling'));
    } catch (error) {
      this.thermostatType = null;
      this.#warn(`Matter: could not compose a cooling thermostat (${messageOf(error)}). `
        + 'Fridge and freezer temperatures are shown as read-only temperature sensors instead.');
    }
    return this.thermostatType;
  }

  // Returns { tile, deviceType } or null when the tile cannot be published at all.
  #resolve(tile) {
    let effective = tile;
    let deviceType;
    if (tile.type === 'Thermostat') {
      deviceType = this.#thermostat();
      if (!deviceType) {
        effective = asTemperatureSensor(tile);
        deviceType = this.matter.deviceTypes?.[effective.type];
      }
    } else {
      deviceType = this.matter.deviceTypes?.[tile.type];
    }
    if (!deviceType) {
      this.#warn(`Matter: this Homebridge has no device type ${effective.type}, so "${tile.name}" is not published.`);
      return null;
    }
    return { tile: effective, deviceType };
  }

  async publish(device, kind, getState, options = {}, extras = {}) {
    const publisher = this;
    const entries = new Map(); // tile id -> { tile, accessory, sent }
    let queue = Promise.resolve();

    const push = async (entry, force) => {
      for (const [cluster, attributes] of Object.entries(entry.tile.clusters ?? {})) {
        const json = JSON.stringify(attributes);
        if (!force && entry.sent.get(cluster) === json) continue;
        entry.sent.set(cluster, json);
        try {
          await publisher.matter.updateAccessoryState(entry.accessory.UUID, cluster, attributes);
        } catch (error) {
          entry.sent.delete(cluster);
          publisher.#debug(`${entry.tile.name}: Matter state update failed: ${messageOf(error)}`);
        }
      }
    };

    // The state Apple Home shows may differ from the truth after a failed command: send it again.
    const repush = async (id) => {
      const entry = entries.get(id);
      if (entry) await push(entry, true);
    };

    // The controller can apply its own change a moment after the handler returned, so put the true
    // state back once now and once more shortly after.
    const snapBack = async (id) => {
      await repush(id);
      try {
        const handle = publisher.setTimer(() => {
          repush(id).catch((error) => publisher.#debug(`Matter delayed state update failed: ${messageOf(error)}`));
        }, SNAP_BACK_MS);
        handle?.unref?.();
      } catch (error) {
        publisher.#debug(`Matter could not schedule a delayed state update: ${messageOf(error)}`);
      }
    };

    const handle = (id, name) => async (args) => {
      try {
        const entry = entries.get(id);
        if (!entry) return;
        if (name === 'systemModeChange') {
          // The thermostat is cooling only, so a mode change snaps back.
          await snapBack(id);
          return;
        }
        const tile = entry.tile;
        const result = tile.command?.(name, args);
        if (result === null || result === undefined) return;
        try {
          if (result === TV_POWER_ON) await extras.onTvPowerOn?.();
          else await publisher.client.sendCommands(device.deviceId, result);
          // Until the next update replaces the tile, the requested value is the current value, so an
          // on followed by an off inside one poll interval sends both commands.
          tile.confirm?.(name, args);
          // The controller has already changed the attribute itself. Forget what was sent, so the next
          // update puts the true state back even when it equals the last value we sent.
          entries.get(id)?.sent.clear();
        } catch (error) {
          publisher.#warn(`Command failed for ${entry.tile.name}: ${messageOf(error)}`);
          await snapBack(id);
        }
      } catch (error) {
        publisher.#debug(`Matter handler ${name} failed: ${messageOf(error)}`);
      }
    };

    const build = (tile, deviceType) => {
      const handlers = {};
      for (const [cluster, names] of Object.entries(HANDLERS[tile.type] ?? {})) {
        handlers[cluster] = {};
        for (const name of names) handlers[cluster][name] = handle(tile.id, name);
      }
      return {
        UUID: publisher.#uuid(device.deviceId, tile.id),
        displayName: tile.name,
        deviceType,
        serialNumber: serialFor(device.deviceId, tile.id),
        manufacturer: 'Samsung',
        model: String(device.deviceTypeName || device.type || 'SmartThings'),
        context: { deviceId: device.deviceId, tileId: tile.id },
        clusters: structuredClone(tile.clusters ?? {}),
        handlers,
      };
    };

    // One matter.* call per tile: Homebridge handles a batch one accessory at a time and stops at the
    // first one that throws, so a single bad tile must not take the tiles after it down with it.
    // Returns the ids of tiles that could not be unregistered; they stay and are tried again later.
    const unregister = async (ids) => {
      const gone = ids.map((id) => entries.get(id)).filter(Boolean);
      const failed = new Set();
      for (const e of gone) {
        const ok = await publisher.#call(`unregister ${e.tile.name}`,
          () => publisher.matter.unregisterPlatformAccessories(publisher.pluginName, publisher.platformName, [e.accessory]));
        if (!ok) {
          failed.add(e.tile.id);
          continue;
        }
        entries.delete(e.tile.id);
        publisher.live.delete(e.accessory.UUID);
        publisher.cached.delete(e.accessory.UUID);
      }
      return failed;
    };

    const register = async (tiles) => {
      const fresh = [];
      for (const tile of tiles) {
        const resolved = publisher.#resolve(tile);
        if (resolved) fresh.push({ ...resolved, accessory: build(resolved.tile, resolved.deviceType) });
      }
      const registeredNow = [];
      for (const f of fresh) {
        // Handlers cannot be remembered by Homebridge, so every accessory is registered on every start.
        const ok = await publisher.#call(`register ${f.tile.name}`,
          () => publisher.matter.registerPlatformAccessories(publisher.pluginName, publisher.platformName, [f.accessory]));
        if (!ok) continue; // Not live, so the next update tries again.
        const entry = { tile: f.tile, accessory: f.accessory, sent: new Map() };
        entries.set(f.tile.id, entry);
        publisher.live.set(f.accessory.UUID, f.accessory);
        publisher.cached.set(f.accessory.UUID, f.accessory);
        registeredNow.push(entry);
      }
      // A remembered accessory keeps its old state, so send the current state after registering.
      for (const entry of registeredNow) await push(entry, true);
    };

    const apply = async (state) => {
      let wanted;
      try {
        wanted = matterTiles(kind, device, state, options);
      } catch (error) {
        publisher.#warn(`Matter: could not work out the tiles for ${device.label ?? device.deviceId}: ${messageOf(error)}`);
        return;
      }
      const wantedIds = new Set(wanted.map((t) => t.id));
      publisher.wanted.set(device.deviceId, new Set(wanted.map((t) => publisher.#uuid(device.deviceId, t.id))));
      const changedType = wanted
        .filter((t) => entries.has(t.id) && publisher.#resolve(t)?.tile.type !== entries.get(t.id).tile.type)
        .map((t) => t.id);
      const stuck = await unregister([...entries.keys()].filter((id) => !wantedIds.has(id) || changedType.includes(id)));
      const appeared = wanted.filter((t) => !entries.has(t.id));
      // Existing tiles keep their handlers and take the new values (and the new command closure).
      for (const tile of wanted) {
        const entry = entries.get(tile.id);
        if (!entry || stuck.has(tile.id)) continue;
        entry.tile = entry.tile.type === tile.type ? tile : asTemperatureSensor(tile);
        await push(entry, false);
      }
      await register(appeared);
    };

    const run = (state) => {
      const next = queue.then(() => apply(state)).catch((error) => {
        publisher.#debug(`Matter update failed: ${messageOf(error)}`);
      });
      queue = next;
      return next;
    };

    await run(getState());
    return {
      update: (state) => run(state),
      remove: () => {
        const next = queue.then(() => {
          publisher.wanted.delete(device.deviceId);
          return unregister([...entries.keys()]);
        }).catch(() => {});
        queue = next;
        return next;
      },
    };
  }

  async #drop(match) {
    const gone = [...this.cached.values()].filter((a) => !this.live.has(a.UUID) && match(a));
    if (gone.length === 0) return 0;
    let count = 0;
    for (const a of gone) {
      const ok = await this.#call(`unregister remembered accessory ${a.displayName ?? a.UUID}`,
        () => this.matter.unregisterPlatformAccessories(this.pluginName, this.platformName, [a]));
      if (!ok) continue;
      this.cached.delete(a.UUID);
      count += 1;
    }
    return count;
  }

  // Remembered accessories of devices that are gone, and remembered tiles that are no longer wanted.
  // Call after every device has been published: whatever is remembered and not live is not wanted.
  async removeStale(liveDeviceIds) {
    const live = new Set(liveDeviceIds);
    return this.#drop((a) => {
      const deviceId = a.context?.deviceId;
      if (!live.has(deviceId)) return true;
      // A live device whose tiles were never worked out keeps what it has.
      const wanted = this.wanted.get(deviceId);
      return wanted !== undefined && !wanted.has(a.UUID);
    });
  }

  async removeAll() {
    return this.#drop(() => true);
  }
}
