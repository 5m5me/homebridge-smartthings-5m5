import { PLATFORM_NAME } from './settings.js';
import { SmartThings5m5Platform } from './platform.js';

export default (api) => {
  api.registerPlatform(PLATFORM_NAME, SmartThings5m5Platform);
};
