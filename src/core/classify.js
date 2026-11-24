const BY_TYPE = {
  'Samsung OCF TV': 'tv',
  'Samsung OCF Washer': 'washer',
  'Samsung OCF Dryer': 'dryer',
  'Samsung OCF Refrigerator': 'fridge',
};

export function classify(device) {
  const byType = BY_TYPE[device?.deviceTypeName];
  if (byType) return byType;
  const main = device?.components?.find((c) => c.id === 'main');
  if (main?.capabilities?.some((c) => c.id === 'waterSensor')) return 'moisture';
  return null;
}
