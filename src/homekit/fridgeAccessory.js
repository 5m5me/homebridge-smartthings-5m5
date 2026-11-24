import {
  fridgeState, setpointCommand, powerCoolCommand, powerFreezeCommand, vacationCommand,
} from '../devices/fridge.js';
import { ensureService, setInfo, setName, sendOrThrow } from './common.js';

export class FridgeAccessory {
  constructor({ accessory, hap, device, client, log }) {
    this.accessory = accessory;
    this.hap = hap;
    this.device = device;
    this.client = client;
    this.log = log;
    const { Service, Characteristic } = hap;
    setInfo({ accessory, hap, device });
    const switches = [
      ['powercool', 'Power Cool', powerCoolCommand],
      ['powerfreeze', 'Power Freeze', powerFreezeCommand],
      ['vacation', 'Vacation Mode', vacationCommand],
    ];
    this.switches = {};
    for (const [subtype, name, command] of switches) {
      const service = ensureService(accessory, Service.Switch, name, subtype);
      setName(service, hap, name);
      service.getCharacteristic(Characteristic.On).onSet(async (value) => {
        await sendOrThrow(this, command(Boolean(value)));
      });
      this.switches[subtype] = service;
    }
  }

  #section(section) {
    const { Service, Characteristic } = this.hap;
    const door = ensureService(this.accessory, Service.ContactSensor, `${section.name} Door`, `door-${section.id}`);
    setName(door, this.hap, `${section.name} Door`);
    let thermostat = null;
    if (section.min !== null && section.max !== null) {
      thermostat = ensureService(this.accessory, Service.Thermostat, section.name, `temp-${section.id}`);
      setName(thermostat, this.hap, section.name);
      const COOL = Characteristic.TargetHeatingCoolingState.COOL;
      // Props first, then values, so hap-nodejs does not clamp or warn.
      thermostat.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -40, maxValue: 40 });
      thermostat.getCharacteristic(Characteristic.TargetTemperature).setProps({
        minValue: section.min,
        maxValue: section.max,
        minStep: section.step ?? 1,
      });
      thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({ validValues: [COOL] });
      thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(COOL);
      thermostat.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.COOL);
      thermostat.getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
      thermostat.getCharacteristic(Characteristic.TargetTemperature).onSet(async (value) => {
        await sendOrThrow(this, setpointCommand(section.id, value));
      });
    }
    return { door, thermostat };
  }

  update(snapshot) {
    const { Characteristic } = this.hap;
    const state = fridgeState(snapshot);
    for (const section of state.sections) {
      const { door, thermostat } = this.#section(section);
      door.updateCharacteristic(Characteristic.ContactSensorState, section.doorOpen ? 1 : 0);
      if (thermostat) {
        if (section.temperatureC !== null) {
          thermostat.updateCharacteristic(Characteristic.CurrentTemperature, section.temperatureC);
        }
        if (section.setpointC !== null) {
          thermostat.updateCharacteristic(Characteristic.TargetTemperature, section.setpointC);
        }
      }
    }
    this.switches.powercool.updateCharacteristic(Characteristic.On, state.powerCool);
    this.switches.powerfreeze.updateCharacteristic(Characteristic.On, state.powerFreeze);
    this.switches.vacation.updateCharacteristic(Characteristic.On, state.vacation);
  }
}
