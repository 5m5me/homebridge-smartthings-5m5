import { attr, attrUnit, toCelsius } from '../core/status.js';

export function moistureState({ status, online }) {
  const temp = attr(status, 'main', 'temperatureMeasurement', 'temperature');
  const unit = attrUnit(status, 'main', 'temperatureMeasurement', 'temperature');
  const battery = attr(status, 'main', 'battery', 'battery');
  const batteryPercent = typeof battery === 'number' ? battery : null;
  return {
    leak: attr(status, 'main', 'waterSensor', 'water') === 'wet',
    temperatureC: toCelsius(temp, unit),
    batteryPercent,
    lowBattery: batteryPercent !== null && batteryPercent < 20,
    fault: !online,
  };
}
