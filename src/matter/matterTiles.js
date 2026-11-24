// Pure description of the Matter tiles for each SmartThings device. Nothing here touches Homebridge.
// A tile is one top-level Matter accessory: { id, name, type, clusters, command? }.
// `type` is a key of api.matter.deviceTypes. Temperatures are hundredths of a degree Celsius.
import { sanitizeName } from '../homekit/common.js';
import { laundryCommand } from '../devices/laundry.js';
import { setpointCommand, powerCoolCommand, powerFreezeCommand, vacationCommand } from '../devices/fridge.js';
import { powerOffCommand } from '../devices/tv.js';

export const TV_POWER_ON = 'tv-power-on';

// Matter Thermostat values used here: ControlSequenceOfOperation 0 is cooling only, SystemMode 3 is cool.
const COOLING_ONLY = 0;
const SYSTEM_MODE_COOL = 3;

const hundredths = (c) => Math.round(c * 100);

const contact = (open) => ({ booleanState: { stateValue: !open } });

// Matter hands the plugin its own state updates back as commands, so a command that changes
// nothing returns null.
// `confirm` is called by the publisher once a command went through: until the next update replaces
// the tile, the requested value counts as the current one, so on then off sends both commands.
function outletBehaviour(isOn, onCommand, offCommand) {
  let current = Boolean(isOn);
  return {
    command: (name) => {
      if (name === 'on') return current ? null : onCommand();
      if (name === 'off') return current ? offCommand() : null;
      return null;
    },
    confirm: (name) => {
      if (name === 'on') current = true;
      else if (name === 'off') current = false;
    },
  };
}

function outlet(id, name, isOn, onCommand, offCommand) {
  return {
    id,
    name: sanitizeName(name),
    type: 'OnOffOutlet',
    clusters: { onOff: { onOff: Boolean(isOn) } },
    ...outletBehaviour(isOn, onCommand, offCommand),
  };
}

function moistureTiles(label, state, options) {
  const asContact = options.leakAs === 'contact';
  const tiles = [{
    id: 'leak',
    name: sanitizeName(label),
    type: asContact ? 'ContactSensor' : 'LeakSensor',
    // A leak is true for the leak sensor and open for the contact sensor.
    clusters: asContact ? contact(state.leak) : { booleanState: { stateValue: Boolean(state.leak) } },
  }];
  if (state.temperatureC !== null && state.temperatureC !== undefined) {
    tiles.push({
      id: 'temp',
      name: sanitizeName(`${label} Temperature`),
      type: 'TemperatureSensor',
      clusters: { temperatureMeasurement: { measuredValue: hundredths(state.temperatureC) } },
    });
  }
  return tiles;
}

function laundryTiles(kind, label, state) {
  const tiles = [
    {
      id: 'running',
      name: sanitizeName(`${label} Running`),
      type: 'MotionSensor',
      clusters: { occupancySensing: { occupancy: { occupied: Boolean(state.running) } } },
    },
    {
      id: 'finished',
      name: sanitizeName(`${label} Finished`),
      type: 'ContactSensor',
      clusters: contact(Boolean(state.finished)),
    },
  ];
  if (state.remoteEnabled) {
    tiles.push(outlet(
      'start',
      `${label} Start`,
      state.running,
      () => laundryCommand(kind, 'start'),
      () => laundryCommand(kind, 'pause'),
    ));
  }
  return tiles;
}

function roundToStep(value, step) {
  if (!(step > 0)) return value;
  return Number((Math.round(value / step) * step).toFixed(4));
}

function thermostatTile(label, section) {
  const min = hundredths(section.min);
  const max = hundredths(section.max);
  let current = section.setpointC;
  const requested = (name, args) => {
    if (name !== 'occupiedCoolingSetpointChange') return null;
    const raw = args?.occupiedCoolingSetpoint;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    return Math.min(section.max, Math.max(section.min, roundToStep(raw / 100, section.step)));
  };
  return {
    id: `temp-${section.id}`,
    name: sanitizeName(`${label} ${section.name}`),
    type: 'Thermostat',
    clusters: {
      thermostat: {
        localTemperature: section.temperatureC === null ? null : hundredths(section.temperatureC),
        occupiedCoolingSetpoint: hundredths(section.setpointC),
        // matter.js falls back to 16 to 32 degrees unless the absolute limits are declared as well.
        absMinCoolSetpointLimit: min,
        absMaxCoolSetpointLimit: max,
        minCoolSetpointLimit: min,
        maxCoolSetpointLimit: max,
        controlSequenceOfOperation: COOLING_ONLY,
        systemMode: SYSTEM_MODE_COOL,
      },
    },
    command: (name, args) => {
      const value = requested(name, args);
      if (value === null || value === current) return null;
      return setpointCommand(section.id, value);
    },
    confirm: (name, args) => {
      const value = requested(name, args);
      if (value !== null) current = value;
    },
  };
}

// Order matters: Homebridge stops registering a batch at the first accessory that throws, so the
// proven tiles (doors, outlets) come first and the temperature tiles, which may fail, come last.
function fridgeTiles(label, state, options) {
  const tiles = [];
  for (const section of state.sections) {
    tiles.push({
      id: `door-${section.id}`,
      name: sanitizeName(`${label} ${section.name} Door`),
      type: 'ContactSensor',
      clusters: contact(section.doorOpen),
    });
  }
  tiles.push(outlet('powercool', `${label} Power Cool`, state.powerCool,
    () => powerCoolCommand(true), () => powerCoolCommand(false)));
  tiles.push(outlet('powerfreeze', `${label} Power Freeze`, state.powerFreeze,
    () => powerFreezeCommand(true), () => powerFreezeCommand(false)));
  tiles.push(outlet('vacation', `${label} Vacation Mode`, state.vacation,
    () => vacationCommand(true), () => vacationCommand(false)));
  for (const section of state.sections) {
    const ranged = section.min !== null && section.max !== null && section.setpointC !== null;
    if (options.fridgeTemperature !== 'sensor' && ranged) {
      tiles.push(thermostatTile(label, section));
    } else {
      tiles.push({
        id: `temp-${section.id}`,
        name: sanitizeName(`${label} ${section.name}`),
        type: 'TemperatureSensor',
        clusters: {
          temperatureMeasurement: {
            measuredValue: section.temperatureC === null ? null : hundredths(section.temperatureC),
          },
        },
      });
    }
  }
  return tiles;
}

// Apple Home has no Matter TV tile, so a TV is one power outlet. The platform handles the power on
// sequence, so "on" returns a marker instead of SmartThings commands.
function tvTiles(label, state) {
  return [outlet('power', label, state.on, () => TV_POWER_ON, powerOffCommand)];
}

export function matterTiles(kind, device, state, options = {}) {
  const label = String(device?.label ?? device?.name ?? device?.deviceId ?? kind);
  switch (kind) {
    case 'moisture': return moistureTiles(label, state, options);
    case 'washer':
    case 'dryer': return laundryTiles(kind, label, state);
    case 'fridge': return fridgeTiles(label, state, options);
    case 'tv': return tvTiles(label, state);
    default: return [];
  }
}

// The read-only form of a thermostat tile, used when the thermostat cannot be composed.
export function asTemperatureSensor(tile) {
  const local = tile.clusters?.thermostat?.localTemperature;
  return {
    id: tile.id,
    name: tile.name,
    type: 'TemperatureSensor',
    clusters: { temperatureMeasurement: { measuredValue: local ?? null } },
  };
}
