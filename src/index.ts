import type { API } from 'homebridge';
import { BroadlinkCloudPlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform.ts';

export default function register(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, BroadlinkCloudPlatform);
}
