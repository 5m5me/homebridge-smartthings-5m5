// HomeKit rejects most punctuation in names (hap-nodejs warns about it), so keep letters,
// digits, space, apostrophe, period, comma and hyphen.
export function sanitizeName(name) {
  const cleaned = String(name ?? '')
    .replace(/[^\p{L}\p{N} '.,-]/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return cleaned === '' ? 'Device' : cleaned;
}

export function ensureService(accessory, ServiceType, name, subtype) {
  const existing = subtype === undefined
    ? accessory.getService(ServiceType)
    : accessory.getServiceById(ServiceType, subtype);
  const service = existing ?? (subtype === undefined
    ? accessory.addService(ServiceType, sanitizeName(name))
    : accessory.addService(ServiceType, sanitizeName(name), subtype));
  return service;
}

export function setInfo({ accessory, hap, device }) {
  const { Service, Characteristic } = hap;
  const info = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
  info
    .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
    .setCharacteristic(Characteristic.Model, String(device.deviceTypeName || device.type || 'SmartThings'))
    .setCharacteristic(Characteristic.SerialNumber, String(device.deviceId));
}

export function setName(service, hap, name) {
  service.setCharacteristic(hap.Characteristic.Name, sanitizeName(name));
}

// Sends commands; on failure logs a warning (message only, never credentials)
// and throws a HomeKit communication failure.
export async function sendOrThrow({ client, device, hap, log }, commands) {
  try {
    await client.sendCommands(device.deviceId, commands);
  } catch (error) {
    log?.warn?.(`Command failed for ${device.label ?? device.deviceId}: ${error?.message ?? error}`);
    throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
