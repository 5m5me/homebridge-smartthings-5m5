import { moistureState } from '../devices/moisture.js';
import { ensureService, setInfo, setName, sanitizeName } from './common.js';

export class MoistureAccessory {
  constructor({ accessory, hap, device, client, log }) {
    this.accessory = accessory;
    this.hap = hap;
    this.device = device;
    this.client = client;
    this.log = log;
    const { Service } = hap;
    setInfo({ accessory, hap, device });
    const label = sanitizeName(device.label ?? device.name ?? 'Moisture Sensor');
    this.leak = ensureService(accessory, Service.LeakSensor, label, 'leak');
    this.temp = ensureService(accessory, Service.TemperatureSensor, `${label} Temperature`, 'temperature');
    this.battery = ensureService(accessory, Service.Battery, `${label} Battery`, 'battery');
    setName(this.leak, hap, label);
    setName(this.temp, hap, `${label} Temperature`);
    setName(this.battery, hap, `${label} Battery`);
    this.temp.getCharacteristic(hap.Characteristic.CurrentTemperature).setProps({ minValue: -40, maxValue: 100, minStep: 0.1 });
  }

  update(snapshot) {
    const { Characteristic } = this.hap;
    const s = moistureState(snapshot);
    const lowBattery = s.lowBattery ? 1 : 0;
    this.leak.updateCharacteristic(Characteristic.LeakDetected, s.leak ? 1 : 0);
    this.leak.updateCharacteristic(Characteristic.StatusLowBattery, lowBattery);
    this.leak.updateCharacteristic(Characteristic.StatusFault, s.fault ? 1 : 0);
    if (s.temperatureC !== null) {
      this.temp.updateCharacteristic(Characteristic.CurrentTemperature, s.temperatureC);
    }
    if (s.batteryPercent !== null) {
      this.battery.updateCharacteristic(Characteristic.BatteryLevel, s.batteryPercent);
    }
    this.battery.updateCharacteristic(Characteristic.StatusLowBattery, lowBattery);
  }
}
