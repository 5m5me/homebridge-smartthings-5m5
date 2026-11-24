import { attr } from '../core/status.js';

export function tvState({ status, online }, localPower) {
  let on;
  if (localPower === 'on') on = true;
  else if (localPower === 'standby') on = false;
  else on = Boolean(online) && attr(status, 'main', 'switch', 'switch') === 'on';

  const volume = attr(status, 'main', 'audioVolume', 'volume');
  const map = attr(status, 'main', 'samsungvd.mediaInputSource', 'supportedInputSourcesMap');
  const ocf = attr(status, 'main', 'samsungvd.supportsPowerOnByOcf', 'supportsPowerOnByOcf');
  return {
    on,
    volume: typeof volume === 'number' ? volume : null,
    muted: attr(status, 'main', 'audioMute', 'mute') === 'muted',
    inputs: Array.isArray(map) ? map.map(({ id, name }) => ({ id, name })) : [],
    currentInputId: attr(status, 'main', 'samsungvd.mediaInputSource', 'inputSource') ?? null,
    cloudPowerOn: ocf === 'true' || ocf === true,
  };
}

const cmd = (capability, command, args = []) => [{ component: 'main', capability, command, arguments: args }];

export const powerOffCommand = () => cmd('switch', 'off');
export const powerOnCommand = () => cmd('switch', 'on');
export const inputCommand = (id) => cmd('samsungvd.mediaInputSource', 'setInputSource', [id]);
export const volumeUpCommand = () => cmd('audioVolume', 'volumeUp');
export const volumeDownCommand = () => cmd('audioVolume', 'volumeDown');
export const setVolumeCommand = (n) => cmd('audioVolume', 'setVolume', [n]);
export const muteCommand = (muted) => cmd('audioMute', 'setMute', [muted ? 'muted' : 'unmuted']);
export const keyCommand = (key) => cmd('samsungvd.remoteControl', 'send', [key, 'PRESS_AND_RELEASED']);
export const launchAppCommand = (appId) => cmd('custom.launchapp', 'launchApp', [appId]);
