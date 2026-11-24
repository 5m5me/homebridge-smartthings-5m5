function node(status, component, capability, attribute) {
  return status?.components?.[component]?.[capability]?.[attribute];
}

export function attr(status, component, capability, attribute) {
  return node(status, component, capability, attribute)?.value;
}

export function attrUnit(status, component, capability, attribute) {
  return node(status, component, capability, attribute)?.unit;
}

export function toCelsius(value, unit) {
  if (value === null || value === undefined) return null;
  if (unit !== 'F') return value;
  return Math.round(((value - 32) * 5) / 9 * 10) / 10;
}
