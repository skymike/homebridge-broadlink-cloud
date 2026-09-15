import { readFile } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import type { API, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { BroadlinkCloudClient } from './client.ts';
import type { CloudSession, Endpoint, Remote, RemoteCommand } from './client.ts';
import { buildFanMapping } from './fan-mapping.ts';
import type { FanMapping } from './fan-mapping.ts';
import { AcPresetCoordinator } from './ac-presets.ts';
import { BroadlinkCloudControl } from './control.ts';
import { AcThermostatCoordinator } from './ac-thermostat.ts';
import { BroadlinkCloudSensors } from './sensors.ts';
import type { SensorReading } from './sensors.ts';

export const PLUGIN_NAME = 'homebridge-broadlink-cloud';
export const PLATFORM_NAME = 'BroadlinkCloud';
interface FanConfig { remoteId: string; hubId: string; name?: string; exposeLightToggle?: boolean }
interface Sender { send(hub: Endpoint, command: RemoteCommand): Promise<void> }
interface Dependencies {
  readSession(path: string): Promise<CloudSession>;
  createClient(session: CloudSession): { listDevices(): Promise<Endpoint[]>; getRemote(id: string): Promise<Remote> };
  createSender(session: CloudSession): Sender;
  createControl(session: CloudSession): { sendCode(hub: Endpoint, code: string): Promise<void> };
  createSensors(session: CloudSession): { read(hub: Endpoint): Promise<SensorReading> };
}
interface FanRuntime {
  accessory: PlatformAccessory; config: FanConfig; available: boolean;
  mapping?: FanMapping; hub?: Endpoint; sender?: Sender; speed?: number;
  queue: Promise<void>;
}
const defaults: Dependencies = {
  readSession: async path => JSON.parse(await readFile(path, 'utf8')) as CloudSession,
  createClient: session => new BroadlinkCloudClient(session),
  createControl: session => new BroadlinkCloudControl(session),
  createSensors: session => new BroadlinkCloudSensors(session),
  createSender: session => ({ send: async (hub, command) => {
    // Sequence timing is undocumented. Never silently truncate or replay a learned sequence.
    if (command.codeList.length !== 1) throw new Error('Unsupported command sequence');
    const { BroadlinkCloudControl } = await import('./control.ts');
    await new BroadlinkCloudControl(session).sendCode(hub, command.codeList[0].code);
  } }),
};
export class BroadlinkCloudPlatform {
  private readonly log: Logger;
  private readonly api: API;
  private readonly deps: Dependencies;
  private readonly sessionFile: string;
  private readonly configured: FanConfig[];
  private readonly acPresets: AcPresetCoordinator;
  private readonly airConditioners: AcThermostatCoordinator;
  private readonly cache = new Map<string, PlatformAccessory>();
  private readonly fans = new Map<string, FanRuntime>();
  private readonly hubQueues = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly pendingUpdates = new Set<ReturnType<typeof setImmediate>>();
  private refreshing?: Promise<void>;
  private stopped = false;

  constructor(log: Logger, config: PlatformConfig, api: API, deps: Partial<Dependencies> = {}) {
    this.log = log; this.api = api; this.deps = { ...defaults, ...deps };
    this.sessionFile = config.sessionFile;
    if (typeof this.sessionFile !== 'string' || !(isAbsolute(this.sessionFile) || win32.isAbsolute(this.sessionFile))) throw new Error('sessionFile must be an absolute path');
    const fans = config.fans === undefined ? [] : config.fans;
    if (!Array.isArray(fans) || fans.some((fan: FanConfig) => !fan || typeof fan.remoteId !== 'string' || !fan.remoteId.trim() || typeof fan.hubId !== 'string' || !fan.hubId.trim())) throw new Error('Each fan requires explicit remoteId and hubId');
    this.configured = fans;
    this.acPresets = new AcPresetCoordinator(log, config.acPresets, api);
    this.airConditioners = new AcThermostatCoordinator(log, config.airConditioners, api);
    const thermostatRemotes = new Set<string>((config.airConditioners ?? []).map((ac: { remoteId: string }) => ac.remoteId));
    if ((config.acPresets ?? []).some((preset: { remoteId: string }) => thermostatRemotes.has(preset.remoteId))) {
      throw new Error('Choose either acPresets or airConditioners for each AC remote');
    }
    if (new Set(this.configured.map(f => f.remoteId)).size !== this.configured.length) throw new Error('Duplicate fan remoteId');
    api.on('didFinishLaunching', () => {
      void this.refresh();
      this.timer = setInterval(() => { void this.refresh(); }, 60_000);
      this.timer.unref();
    });
    api.on('shutdown', () => {
      this.stopped = true; clearInterval(this.timer);
      this.acPresets.shutdown();
      this.airConditioners.shutdown();
      for (const update of this.pendingUpdates) clearImmediate(update);
      this.pendingUpdates.clear();
      for (const fan of this.fans.values()) fan.available = false;
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    if (this.airConditioners.configureAccessory(accessory)) return;
    if (this.acPresets.configureAccessory(accessory)) return;
    // Do not persist sessions, commands or assumed appliance state in Homebridge's cache.
    accessory.context = {};
    this.cache.set(accessory.UUID, accessory);
    const config = this.configured.find(f => this.uuid(f.remoteId) === accessory.UUID);
    if (config) this.attach(accessory, config);
    else {
      const { Service: S, Characteristic: C } = this.api.hap;
      const fan = accessory.getService(S.Fanv2);
      for (const characteristic of [C.Active, C.RotationSpeed]) {
        fan?.getCharacteristic(characteristic).onGet(() => { throw this.failure(); }).onSet(async () => { throw this.failure(); });
      }
      const light = accessory.getService(S.Switch);
      light?.getCharacteristic(C.On).onGet(() => false).onSet(async value => {
        light.updateCharacteristic(C.On, false);
        if (value === true) throw this.failure();
      });
      light?.updateCharacteristic(C.On, false);
    }
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.refreshing) this.refreshing = this.discover().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async discover(): Promise<void> {
    try {
      const session = await this.deps.readSession(this.sessionFile);
      const client = this.deps.createClient(session);
      const endpoints = await client.listDevices();
      const fanSender = this.deps.createSender(session);
      const sender: Sender = { send: (hub, command) => this.onHub(hub, () => fanSender.send(hub, command)) };
      const rawControl = this.deps.createControl(session);
      const control = { sendCode: (hub: Endpoint, code: string) => this.onHub(hub, () => rawControl.sendCode(hub, code)) };
      const rawSensors = this.deps.createSensors(session);
      const sensors = { read: (hub: Endpoint) => this.onHub(hub, () => rawSensors.read(hub)) };
      for (const config of this.configured) {
        try {
          const hub = endpoints.find(e => e.endpointId === config.hubId);
          if (!hub) throw new Error('Configured hub unavailable');
          const mapping = buildFanMapping(await client.getRemote(config.remoteId));
          if ([mapping.off, ...mapping.speeds, ...(config.exposeLightToggle && mapping.lightToggle ? [mapping.lightToggle] : [])].some(c => c.codeList.length !== 1)) throw new Error('Unsupported command sequence');
          if (this.stopped) return;
          let runtime = this.fans.get(config.remoteId);
          if (!runtime) {
            const uuid = this.uuid(config.remoteId);
            const accessory = this.cache.get(uuid) ?? new this.api.platformAccessory(config.name ?? 'BroadLink Fan', uuid);
            if (!this.cache.has(uuid)) {
              this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
              this.cache.set(uuid, accessory);
            }
            runtime = this.attach(accessory, config);
          }
          runtime.mapping = mapping; runtime.hub = hub; runtime.sender = sender; runtime.available = true;
          this.bind(runtime);
        } catch {
          const fan = this.fans.get(config.remoteId); if (fan) fan.available = false;
          this.log.warn('Fan discovery failed; cached accessory retained.');
        }
      }
      await this.acPresets.refresh(endpoints, client, control);
      await this.airConditioners.refresh(endpoints, client, control, sensors);
    } catch {
      this.acPresets.unavailable();
      this.airConditioners.unavailable();
      for (const fan of this.fans.values()) fan.available = false;
      this.log.error('Cloud refresh failed; check session file and connectivity. Cached accessories retained.');
    }
  }

  private uuid(remoteId: string): string { return this.api.hap.uuid.generate(`${PLUGIN_NAME}:${remoteId}`); }
  private failure(): Error { return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  private invalid(): Error { return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST); }
  private attach(accessory: PlatformAccessory, config: FanConfig): FanRuntime {
    const runtime: FanRuntime = { accessory, config, available: false, queue: Promise.resolve() };
    this.fans.set(config.remoteId, runtime);
    this.bind(runtime);
    return runtime;
  }
  private bind(fan: FanRuntime): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    const service = fan.accessory.getService(S.Fanv2) ?? fan.accessory.addService(S.Fanv2, fan.config.name ?? 'BroadLink Fan');
    const readSpeed = () => { if (!fan.available || fan.speed === undefined) throw this.failure(); return fan.speed; };
    service.getCharacteristic(C.Active).onGet(() => readSpeed() > 0 ? 1 : 0).onSet(async value => {
      if (value !== 0 && value !== 1) throw this.invalid();
      await this.enqueue(fan, async () => {
        const speed = value === 0 ? 0 : fan.speed && fan.speed > 0 ? fan.speed : 100 / fan.mapping!.speeds.length;
        await this.setSpeed(fan, service, speed);
      });
    });
    service.getCharacteristic(C.RotationSpeed).setProps({ minValue: 0, maxValue: 100, minStep: 1 }).onGet(readSpeed).onSet(async value => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw this.invalid();
      await this.enqueue(fan, () => this.setSpeed(fan, service, value));
    });
    if (fan.accessory.getService(S.Switch) || (fan.config.exposeLightToggle && fan.mapping?.lightToggle)) {
      const light = fan.accessory.getService(S.Switch) ?? fan.accessory.addService(S.Switch, `${fan.config.name ?? 'Fan'} Light Toggle`);
      light.getCharacteristic(C.On).onGet(() => false).onSet(async value => {
        try { if (value === true) await this.enqueue(fan, async () => {
          if (!fan.config.exposeLightToggle || !fan.mapping?.lightToggle) throw this.failure();
          await fan.sender!.send(fan.hub!, fan.mapping.lightToggle);
        }); }
        finally { this.publishAfterWrite(() => { light.updateCharacteristic(C.On, false); }); }
      });
      light.updateCharacteristic(C.On, false);
    }
  }
  private async setSpeed(fan: FanRuntime, service: Service, requested: number): Promise<void> {
    const count = fan.mapping!.speeds.length;
    const level = requested === 0 ? 0 : Math.max(1, Math.min(count, Math.round(requested * count / 100)));
    await fan.sender!.send(fan.hub!, level === 0 ? fan.mapping!.off : fan.mapping!.speeds[level - 1]);
    fan.speed = Math.round(level * 100 / count);
    this.publishAfterWrite(() => {
      // Read the latest acknowledged state so adjacent queued writes cannot publish stale levels.
      service.updateCharacteristic(this.api.hap.Characteristic.Active, fan.speed! > 0 ? 1 : 0);
      service.updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, fan.speed!);
    });
  }
  private publishAfterWrite(publish: () => void): void {
    if (this.stopped) return;
    // HAP overwrites characteristic.value with the request after awaiting onSet. Publish on
    // the next event-loop turn, after that completion, rather than inside the setter.
    const update = setImmediate(() => {
      this.pendingUpdates.delete(update);
      if (!this.stopped) publish();
    });
    this.pendingUpdates.add(update);
    update.unref();
  }
  private enqueue(fan: FanRuntime, action: () => Promise<void>): Promise<void> {
    const task = fan.queue.then(async () => {
      if (this.stopped || !fan.available || !fan.mapping || !fan.sender || !fan.hub) throw this.failure();
      try { await action(); } catch { throw this.failure(); }
    });
    fan.queue = task.catch(() => {});
    return task;
  }
  private onHub<T>(hub: Endpoint, action: () => Promise<T>): Promise<T> {
    const previous = this.hubQueues.get(hub.endpointId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (this.stopped) throw this.failure();
      return action();
    });
    this.hubQueues.set(hub.endpointId, operation.then(() => {}, () => {}));
    return operation;
  }
}
