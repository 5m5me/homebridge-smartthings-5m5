// Decides which connection carries the devices. They are published over one connection only,
// otherwise every tile would show up twice in Apple Home.
export function chooseConnection(setting, matterOn, hapOn, warn) {
  const wanted = setting === 'homekit' || setting === 'matter' ? setting : 'auto';
  if (wanted === 'matter' && !matterOn) {
    warn('The settings ask for Matter, but Matter is not switched on for this bridge. Using HomeKit instead.');
    return 'homekit';
  }
  if (wanted === 'homekit' && !hapOn && matterOn) {
    warn('The settings ask for HomeKit, but HomeKit (HAP) is switched off for this bridge. Using Matter instead.');
    return 'matter';
  }
  if (wanted === 'auto') return matterOn ? 'matter' : 'homekit';
  return wanted;
}
