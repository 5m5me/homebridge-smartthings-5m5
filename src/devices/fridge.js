import { attr, attrUnit, toCelsius } from '../core/status.js';

const CANDIDATES = [
  { id: 'cooler', name: 'Fridge' },
  { id: 'freezer', name: 'Freezer' },
  { id: 'cvroom', name: 'Flex Zone' },
];

function nonNull(v) {
  return v !== null && v !== undefined;
}

export function fridgeState({ status, online }) {
  const disabled = attr(status, 'main', 'custom.disabledComponents', 'disabledComponents');
  const disabledList = Array.isArray(disabled) ? disabled : [];
  const sections = [];
  for (const { id, name } of CANDIDATES) {
    if (disabledList.includes(id)) continue;
    const contact = attr(status, id, 'contactSensor', 'contact');
    const temp = attr(status, id, 'temperatureMeasurement', 'temperature');
    if (!nonNull(contact) && !nonNull(temp)) continue;
    const setpoint = attr(status, id, 'thermostatCoolingSetpoint', 'coolingSetpoint');
    const range = attr(status, id, 'thermostatCoolingSetpoint', 'coolingSetpointRange');
    sections.push({
      id,
      name,
      doorOpen: contact === 'open',
      temperatureC: toCelsius(temp, attrUnit(status, id, 'temperatureMeasurement', 'temperature')),
      setpointC: toCelsius(setpoint, attrUnit(status, id, 'thermostatCoolingSetpoint', 'coolingSetpoint')),
      min: range?.minimum ?? null,
      max: range?.maximum ?? null,
      step: range?.step ?? null,
    });
  }
  return {
    sections,
    powerCool: attr(status, 'main', 'refrigeration', 'rapidCooling') === 'on',
    powerFreeze: attr(status, 'main', 'refrigeration', 'rapidFreezing') === 'on',
    vacation: attr(status, 'main', 'samsungce.fridgeVacationMode', 'vacationMode') === 'on',
    fault: !online,
  };
}

export function setpointCommand(sectionId, valueC) {
  return [
    { component: sectionId, capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [valueC] },
  ];
}

const onOff = (on) => (on ? 'on' : 'off');

export function powerCoolCommand(on) {
  return [{ component: 'main', capability: 'refrigeration', command: 'setRapidCooling', arguments: [onOff(on)] }];
}

export function powerFreezeCommand(on) {
  return [{ component: 'main', capability: 'refrigeration', command: 'setRapidFreezing', arguments: [onOff(on)] }];
}

export function vacationCommand(on) {
  return [
    { component: 'main', capability: 'samsungce.fridgeVacationMode', command: 'setVacationMode', arguments: [onOff(on)] },
  ];
}
