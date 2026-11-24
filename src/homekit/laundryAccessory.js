import { laundryState, laundryCommand } from '../devices/laundry.js';
import { ensureService, setInfo, setName, sanitizeName, sendOrThrow } from './common.js';

export class LaundryAccessory {
  constructor({ accessory, hap, device, client, log, kind, finishTracker }) {
    this.accessory = accessory;
    this.hap = hap;
    this.device = device;
    this.client = client;
    this.log = log;
    this.kind = kind;
    this.finishTracker = finishTracker;
    this.label = sanitizeName(device.label ?? device.name ?? kind);
    const { Service } = hap;
    setInfo({ accessory, hap, device });
    this.running = ensureService(accessory, Service.OccupancySensor, `${this.label} Running`, 'running');
    setName(this.running, hap, `${this.label} Running`);
    this.finished = ensureService(accessory, Service.ContactSensor, `${this.label} Finished`, 'finished');
    setName(this.finished, hap, `${this.label} Finished`);
    // A switch restored from the cache keeps no handlers, so bind them again.
    const cached = accessory.getServiceById(Service.Switch, 'startpause');
    if (cached) this.#bindSwitch(cached);
  }

  #bindSwitch(service) {
    const { Characteristic } = this.hap;
    service.getCharacteristic(Characteristic.On).onSet(async (value) => {
      await sendOrThrow(this, laundryCommand(this.kind, value ? 'start' : 'pause'));
    });
    return service;
  }

  update(snapshot) {
    const { Service, Characteristic } = this.hap;
    const state = laundryState(this.kind, snapshot);
    const finished = this.finishTracker.update(state.running);
    this.running.updateCharacteristic(Characteristic.OccupancyDetected, state.running ? 1 : 0);
    this.finished.updateCharacteristic(Characteristic.ContactSensorState, finished ? 1 : 0);

    let sw = this.accessory.getServiceById(Service.Switch, 'startpause');
    if (state.remoteEnabled) {
      if (!sw) {
        sw = this.accessory.addService(Service.Switch, `${this.label} Start`, 'startpause');
        setName(sw, this.hap, `${this.label} Start`);
        this.#bindSwitch(sw);
      }
      sw.updateCharacteristic(Characteristic.On, state.running);
    } else if (sw) {
      this.accessory.removeService(sw);
    }
  }
}
