import type { API, Logger, PlatformAccessory, Service } from 'homebridge';
import type { Endpoint, Remote } from './client.ts';
import { selectCommand, validCommandName } from './fan-mapping.ts';

const PLUGIN = 'homebridge-broadlink-cloud';
export interface ButtonConfig { id: string; name: string; remoteId: string; hubId: string; command: string }
interface Sender { sendCode(hub: Endpoint, code: string): Promise<void> }
interface Runtime { accessory: PlatformAccessory; service: Service; available: boolean; hub?: Endpoint; code?: string; sender?: Sender }

/** Learned commands have no state feedback; expose deliberate, momentary actions. */
export class ButtonCoordinator {
  private readonly api: API;
  private readonly log: Logger;
  private readonly configs: ButtonConfig[];
  private readonly runtime = new Map<string, Runtime>();
  private readonly resets = new Set<ReturnType<typeof setImmediate>>();
  private stopped = false;
  private revision = 0;
  constructor(log: Logger, buttons: unknown, api: API) {
    this.api = api; this.log = log;
    if (buttons === undefined) buttons = [];
    if (!Array.isArray(buttons)) throw new Error('buttons must be an array');
    this.configs = buttons.filter(value => !(value && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === 0)).map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || !['id', 'name', 'remoteId', 'hubId', 'command'].every(key => validCommandName(value[key]))
          || ['id', 'remoteId', 'hubId'].some(key => value[key] !== value[key].trim())) throw new Error('Each button requires id, name, remoteId, hubId and command');
      const { id, name, remoteId, hubId, command } = value;
      return { id, name, remoteId, hubId, command };
    });
    if (new Set(this.configs.map(c => c.id)).size !== this.configs.length) throw new Error('Duplicate button id');
  }
  configureAccessory(accessory: PlatformAccessory): boolean {
    const config = this.configs.find(c => this.uuid(c.id) === accessory.UUID);
    if (!config && accessory.context.genericButton !== true) return false;
    accessory.context = { genericButton: true };
    if (config) this.attach(accessory, config);
    else {
      const C = this.api.hap.Characteristic;
      const service = accessory.getService(this.api.hap.Service.Switch);
      service?.getCharacteristic(C.On).onGet(() => false).onSet(async value => {
        try { if (value === true) throw this.failure(); }
        finally { if (service) this.reset(service); }
      });
      service?.updateCharacteristic(C.On, false);
    }
    return true;
  }
  async refresh(endpoints: Endpoint[], client: { getRemote(id: string): Promise<Remote> }, sender: Sender): Promise<void> {
    if (this.stopped) return;
    const revision = ++this.revision;
    const remotes = new Map<string, Promise<Remote>>();
    for (const config of this.configs) {
      try {
        const hub = endpoints.find(e => e.endpointId === config.hubId);
        if (!hub) throw new Error('Hub unavailable');
        let pending = remotes.get(config.remoteId);
        if (!pending) { pending = client.getRemote(config.remoteId); remotes.set(config.remoteId, pending); }
        const remote = await pending;
        if (remote.endpointId !== config.remoteId) throw new Error('Remote mismatch');
        const command = selectCommand(remote, config.command);
        if (this.stopped || revision !== this.revision) return;
        let runtime = this.runtime.get(config.id);
        if (!runtime) {
          const accessory = new this.api.platformAccessory(config.name, this.uuid(config.id));
          accessory.context = { genericButton: true };
          this.api.registerPlatformAccessories(PLUGIN, 'BroadlinkCloud', [accessory]);
          runtime = this.attach(accessory, config);
        }
        runtime.hub = hub; runtime.code = command.codeList[0].code; runtime.sender = sender; runtime.available = true;
      } catch {
        if (this.stopped || revision !== this.revision) return;
        const runtime = this.runtime.get(config.id); if (runtime) runtime.available = false;
        this.log.warn('Button discovery failed; cached accessory retained.');
      }
    }
  }
  unavailable(): void { this.revision++; for (const runtime of this.runtime.values()) runtime.available = false; }
  shutdown(): void {
    this.stopped = true; this.unavailable();
    for (const reset of this.resets) clearImmediate(reset);
    this.resets.clear();
  }
  private uuid(id: string): string { return this.api.hap.uuid.generate(`${PLUGIN}:button:${id}`); }
  private failure(): Error { return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  private attach(accessory: PlatformAccessory, config: ButtonConfig): Runtime {
    const { Service: S, Characteristic: C } = this.api.hap;
    accessory.context = { genericButton: true };
    const service = accessory.getService(S.Switch) ?? accessory.addService(S.Switch, config.name);
    const runtime: Runtime = { accessory, service, available: false };
    this.runtime.set(config.id, runtime);
    service.getCharacteristic(C.On).onGet(() => false).onSet(async value => {
      if (value === false) return;
      if (value !== true) throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      try {
        if (this.stopped || !runtime.available || !runtime.hub || !runtime.sender || !runtime.code) throw this.failure();
        await runtime.sender.sendCode(runtime.hub, runtime.code);
      } catch {
        runtime.available = false;
        this.log.warn('Button command failed; command was not retried.');
        throw this.failure();
      } finally { this.reset(service); }
    });
    service.updateCharacteristic(C.On, false);
    this.api.updatePlatformAccessories([accessory]);
    return runtime;
  }
  private reset(service: Service): void {
    if (this.stopped) return;
    const reset = setImmediate(() => {
      this.resets.delete(reset);
      if (!this.stopped) service.updateCharacteristic(this.api.hap.Characteristic.On, false);
    });
    reset.unref(); this.resets.add(reset);
  }
}
