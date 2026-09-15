import test from 'node:test';
import assert from 'node:assert/strict';
import { BroadlinkCloudPlatform } from '../src/platform.ts';
import { HomebridgeAPI } from './homebridge-runtime.ts';
import { TCL_PROFILE_ID } from '../src/tcl.ts';
import { CloudSessionExpiredError } from '../src/client.ts';

class Characteristic {
  getter?: () => unknown;
  setter?: (value: any) => Promise<void>;
  value: unknown;
  onGet(fn: () => unknown) { this.getter = fn; return this; }
  onSet(fn: (value: any) => Promise<void>) { this.setter = fn; return this; }
  setProps() { return this; }
  updateValue(value: unknown) { this.value = value; return this; }
}
class Service {
  chars = new Map<string, Characteristic>();
  getCharacteristic(key: string) { if (!this.chars.has(key)) this.chars.set(key, new Characteristic()); return this.chars.get(key)!; }
  updateCharacteristic(key: string, value: unknown) { this.getCharacteristic(key).updateValue(value); return this; }
  setCharacteristic(key: string, value: unknown) { return this.updateCharacteristic(key, value); }
}
class Accessory {
  context = {};
  registered = false;
  services = new Map<string, Service>();
  displayName: string; UUID: string; constructor(displayName: string, UUID: string) { this.displayName = displayName; this.UUID = UUID; }
  getService(key: string) { return this.services.get(key); }
  addService(key: string) { assert.ok(this.registered, 'accessory must be registered before services'); const service = new Service(); this.services.set(key, service); return service; }
}
const command = (name: string) => ({ name, codeList: [{ code: name }] });
const remote = { endpointId: 'fan1', irData: ['fanoff', '1', '2', 'lighton/off'].map(command), ircodeDesc: '{}', description: {}, channelList: null };
function fixture(overrides: any = {}, exposeLightToggle = true) {
  const accessories: Accessory[] = [];
  const commands: string[] = [];
  const logs: string[] = [];
  const events: Record<string, () => void> = {};
  const api: any = {
    hap: { Service: { Fanv2: 'fan', Switch: 'switch', AccessoryInformation: 'info' }, Characteristic: { Active: 'active', RotationSpeed: 'speed', On: 'on', Manufacturer: 'manufacturer', Model: 'model', SerialNumber: 'serial' }, uuid: { generate: (id: string) => id }, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402, INVALID_VALUE_IN_REQUEST: -70410 }, HapStatusError: class extends Error { hapStatus: number; constructor(hapStatus: number) { super(String(hapStatus)); this.hapStatus = hapStatus; } } },
    platformAccessory: Accessory,
    registerPlatformAccessories(_p: string, _n: string, list: Accessory[]) { for (const a of list) { a.registered = true; accessories.push(a); } },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories() { assert.fail('must not remove cached accessories'); },
    on(name: string, cb: () => void) { events[name] = cb; },
  };
  const deps = {
    readSession: async () => ({ userId: 'u', loginSession: 'secret', familyId: 'f' }),
    createClient: () => ({ listDevices: async () => [{ endpointId: 'hub1' }, { endpointId: 'fan1' }], getRemote: async () => remote }),
    createSender: () => ({ send: async (hub: any, c: any) => { assert.equal(hub.endpointId, 'hub1'); commands.push(c.codeList[0].code); } }),
    ...overrides,
  };
  const platform = new BroadlinkCloudPlatform({ error(message: string) { logs.push(message); }, warn(message: string) { logs.push(message); }, info() {}, debug() {} } as any, { platform: 'BroadlinkCloud', sessionFile: 'C:/session.json', fans: [{ remoteId: 'fan1', hubId: 'hub1', exposeLightToggle }] } as any, api, deps);
  return { platform, accessories, commands, events, logs };
}
test('registers before services and exposes controllable startup display without sending commands', async () => {
  const f = fixture(); await f.platform.refresh();
  assert.equal(f.accessories.length, 1);
  const fan = f.accessories[0].getService('fan')!;
  assert.equal(fan.getCharacteristic('active').getter!(), 0);
  assert.equal(fan.getCharacteristic('speed').getter!(), 0);
  assert.deepEqual(f.commands, []);
  await fan.getCharacteristic('speed').setter!(100);
  assert.deepEqual(f.commands, ['2']);
  assert.equal(fan.getCharacteristic('active').getter!(), 1);
  assert.equal(fan.getCharacteristic('speed').getter!(), 100);
  assert.ok(!JSON.stringify(f.accessories[0].context).includes('secret'));
});
test('failed send does not commit assumed state, retry or expose upstream secrets', async () => {
  let attempts = 0;
  const f = fixture({ createSender: () => ({ send: async () => { attempts++; throw new Error('secret'); } }) });
  await f.platform.refresh();
  const fan = f.accessories[0].getService('fan')!;
  await assert.rejects(fan.getCharacteristic('speed').setter!(50), /-70402/);
  assert.equal(attempts, 1);
  assert.equal(fan.getCharacteristic('speed').getter!(), 0);
});
test('serializes fan and light controls and momentary light does not change fan state', async () => {
  let release!: () => void; const sent: string[] = [];
  const f = fixture({ createSender: () => ({ send: async (_hub: string, c: any) => { sent.push(c.name); if (sent.length === 1) await new Promise<void>(r => { release = r; }); } }) });
  await f.platform.refresh();
  const fan = f.accessories[0].getService('fan')!; const light = f.accessories[0].getService('switch')!.getCharacteristic('on');
  const first = fan.getCharacteristic('speed').setter!(50); const second = light.setter!(true);
  await new Promise(setImmediate); assert.deepEqual(sent, ['1']); release(); await Promise.all([first, second]);
  assert.deepEqual(sent, ['1', 'lighton/off']); assert.equal(light.value, false); assert.equal(light.getter!(), false);
  assert.equal(fan.getCharacteristic('speed').getter!(), 50);
});
test('failed discovery preserves cached accessory and fails reads', async () => {
  let failed = false;
  const f = fixture({ createClient: () => ({ listDevices: async () => { if (failed) throw Error('secret'); return [{ endpointId: 'hub1' }, { endpointId: 'fan1' }]; }, getRemote: async () => remote }) });
  await f.platform.refresh(); const accessory = f.accessories[0];
  await accessory.getService('fan')!.getCharacteristic('speed').setter!(50);
  failed = true; await f.platform.refresh();
  assert.equal(f.accessories.length, 1); assert.throws(() => accessory.getService('fan')!.getCharacteristic('active').getter!(), /-70402/);
});
test('restored cache is wired without fresh discovery and session is reloaded on every refresh', async () => {
  let reads = 0;
  const f = fixture({ readSession: async () => { reads++; throw Error('expired'); } });
  const cached = new Accessory('Restored', 'homebridge-broadlink-cloud:fan1'); cached.registered = true;
  cached.context = { loginSession: 'secret' };
  f.platform.configureAccessory(cached as any);
  await f.platform.refresh(); await f.platform.refresh();
  assert.equal(reads, 2); assert.equal(f.accessories.length, 0); assert.deepEqual(cached.context, {});
  assert.throws(() => cached.getService('fan')!.getCharacteristic('active').getter!(), /-70402/);
});
test('rejects unsupported multi-code sequences rather than sending only one code', async () => {
  const f = fixture({ createClient: () => ({ listDevices: async () => [{ endpointId: 'hub1' }], getRemote: async () => ({ ...remote, irData: remote.irData.map(c => ({ ...c, codeList: [{ code: 'first' }, { code: 'second' }] })) }) }) });
  await f.platform.refresh(); assert.equal(f.accessories.length, 0); assert.deepEqual(f.commands, []);
});
test('failed light toggle resets momentary switch and does not change acknowledged fan state', async () => {
  const f = fixture({ createSender: () => ({ send: async (_hub: any, c: any) => { if (c.name === 'lighton/off') throw Error('secret'); } }) });
  await f.platform.refresh();
  const fan = f.accessories[0].getService('fan')!;
  await fan.getCharacteristic('speed').setter!(100);
  const light = f.accessories[0].getService('switch')!.getCharacteristic('on');
  await assert.rejects(light.setter!(true), /-70402/); assert.equal(light.value, false);
  assert.equal(fan.getCharacteristic('speed').getter!(), 100);
});
test('cached light reads are momentary even when fresh discovery fails', async () => {
  const f = fixture({ readSession: async () => { throw Error('expired'); } });
  const cached = new Accessory('Restored', 'homebridge-broadlink-cloud:fan1'); cached.registered = true;
  const light = cached.addService('switch').getCharacteristic('on'); light.value = true;
  f.platform.configureAccessory(cached as any); await f.platform.refresh();
  assert.equal(light.getter?.(), false); assert.equal(light.value, false);
  await assert.rejects(light.setter!(true), /-70402/);
});
test('removed configuration retains accessory but makes cached fan unavailable', async () => {
  const f = fixture();
  const cached = new Accessory('Old fan', 'homebridge-broadlink-cloud:old'); cached.registered = true;
  const active = cached.addService('fan').getCharacteristic('active'); active.value = 1;
  f.platform.configureAccessory(cached as any);
  assert.throws(() => active.getter!(), /-70402/);
  await assert.rejects(active.setter!(0), /-70402/);
});

async function realHapFixture(failSend = false) {
  const api = new HomebridgeAPI();
  const accessories: any[] = [];
  const sent: string[] = [];
  api.registerPlatformAccessories = (_plugin: string, _platform: string, list: any[]) => { accessories.push(...list); };
  const platform = new BroadlinkCloudPlatform({ error() {}, warn() {}, info() {}, debug() {} } as any,
    { platform: 'BroadlinkCloud', sessionFile: 'C:/session.json', fans: [{ remoteId: 'fan1', hubId: 'hub1', exposeLightToggle: true }] } as any, api, {
      readSession: async () => ({ userId: 'u', loginSession: 's', familyId: 'f' }),
      createClient: () => ({ listDevices: async () => [{ endpointId: 'hub1' }], getRemote: async () => ({ ...remote, irData: ['fanoff', '1', '2', '3', '4', '5', '6', 'lighton/off'].map(command) }) }),
      createSender: () => ({ send: async (_hub, c) => { sent.push(c.name as string); if (failSend) throw Error('private upstream error'); } }),
    });
  await platform.refresh();
  return { api, accessory: accessories[0], sent };
}
test('real HAP resets successful momentary toggle after completing its write', async () => {
  const f = await realHapFixture();
  const on = f.accessory.getService(f.api.hap.Service.Switch).getCharacteristic(f.api.hap.Characteristic.On);
  await on.handleSetRequest(true);
  await new Promise(setImmediate);
  assert.equal(on.value, false);
  assert.deepEqual(f.sent, ['lighton/off']);
  f.api.emit('shutdown');
});
test('real HAP publishes acknowledged speed level after completing a non-level write', async () => {
  const f = await realHapFixture();
  const speed = f.accessory.getService(f.api.hap.Service.Fanv2).getCharacteristic(f.api.hap.Characteristic.RotationSpeed);
  await speed.handleSetRequest(20);
  await new Promise(setImmediate);
  assert.equal(speed.value, 17);
  assert.equal(await speed.handleGetRequest(), 17);
  assert.deepEqual(f.sent, ['1']);
  f.api.emit('shutdown');
});
test('real HAP failed toggle returns an error, resets false and never retries', async () => {
  const f = await realHapFixture(true);
  const on = f.accessory.getService(f.api.hap.Service.Switch).getCharacteristic(f.api.hap.Characteristic.On);
  on.updateValue(true);
  await assert.rejects(on.handleSetRequest(true), error => error === -70402);
  await new Promise(setImmediate);
  assert.equal(on.value, false); assert.deepEqual(f.sent, ['lighton/off']);
  f.api.emit('shutdown');
});
test('shutdown cancels pending HAP publications', async () => {
  const f = await realHapFixture();
  const on = f.accessory.getService(f.api.hap.Service.Switch).getCharacteristic(f.api.hap.Characteristic.On);
  await on.handleSetRequest(true);
  f.api.emit('shutdown');
  let changes = 0; on.on('change', () => { changes++; });
  await new Promise(setImmediate);
  assert.equal(changes, 0);
});

test('AC-only platform registers preset, restores its cache and marks it unavailable on cloud failure', async () => {
  const api = new HomebridgeAPI(); const registered: any[] = []; const sent: string[] = [];
  api.registerPlatformAccessories = (_p: string, _n: string, list: any[]) => { registered.push(...list); };
  api.unregisterPlatformAccessories = () => { assert.fail('retain cached presets'); };
  let failed = false;
  const config = { platform: 'BroadlinkCloud', sessionFile: 'C:/session.json', acPresets: [{ id: 'cool', name: 'AC Cool', remoteId: 'ac1', hubId: 'hub1', power: true, temperature: 25, mode: 'cool', speed: 'auto', swing: false }] };
  const dependencies = {
    readSession: async () => ({ userId: 'u', loginSession: 'secret', familyId: 'f' }),
    createClient: () => ({ listDevices: async () => { if (failed) throw Error('secret'); return [{ endpointId: 'hub1' }]; }, getRemote: async () => ({ ...remote, endpointId: 'ac1', description: { codeUrl: `https://example.invalid/code?ircodeid=${TCL_PROFILE_ID}` } }) }),
    createControl: () => ({ sendCode: async (hub: any, code: string) => { assert.equal(hub.endpointId, 'hub1'); sent.push(code); } }),
  };
  const log = { error() {}, warn() {}, info() {}, debug() {} } as any;
  const first = new BroadlinkCloudPlatform(log, config as any, api, dependencies);
  await first.refresh(); assert.equal(registered.length, 1);
  const accessory = registered[0]; const on = accessory.getService(api.hap.Service.Switch).getCharacteristic(api.hap.Characteristic.On);
  assert.equal(accessory.getService(api.hap.Service.Fanv2), undefined);
  await on.handleSetRequest(true); await new Promise(setImmediate); assert.equal(on.value, false); assert.equal(sent.length, 1);
  const restored = new BroadlinkCloudPlatform(log, config as any, api, dependencies);
  restored.configureAccessory(accessory); assert.deepEqual(accessory.context, { acPreset: true });
  await restored.refresh(); assert.equal(registered.length, 1);
  await on.handleSetRequest(true); await new Promise(setImmediate); assert.equal(sent.length, 2);
  failed = true; await restored.refresh();
  await assert.rejects(on.handleSetRequest(true), error => error === -70402);
  assert.equal(sent.length, 2); assert.equal(registered.length, 1);
  api.emit('shutdown');
});

async function mixedPlatformFixture(includeThermostat = false) {
  const api = new HomebridgeAPI(); const accessories: any[] = []; const sent: string[] = [];
  api.registerPlatformAccessories = (_p: string, _n: string, list: any[]) => { accessories.push(...list); };
  let release!: () => void;
  let sensorReads = 0;
  const send = async (_hub: any, code: string) => {
    sent.push(code);
    if (sent.length === 1) await new Promise<void>(resolve => { release = resolve; });
  };
  const platform = new BroadlinkCloudPlatform({ error() {}, warn() {}, info() {}, debug() {} } as any, {
    platform: 'BroadlinkCloud', sessionFile: 'C:/session.json', fans: [{ remoteId: 'fan1', hubId: 'hub1' }],
    buttons: [{ id: 'light', name: 'Fan light', remoteId: 'fan1', hubId: 'hub1', command: 'lighton/off' }],
    acPresets: includeThermostat ? [] : [{ id: 'cool', name: 'AC Cool', remoteId: 'ac1', hubId: 'hub1', power: true, temperature: 25, mode: 'cool', speed: 'auto', swing: false }],
    ...(includeThermostat ? { airConditioners: [{ remoteId: 'ac1', hubId: 'hub1', name: 'TCL AC' }] } : {}),
  } as any, api, {
    readSession: async () => ({ userId: 'u', loginSession: 'secret', familyId: 'f' }),
    createClient: () => ({ listDevices: async () => [{ endpointId: 'hub1' }], getRemote: async id => id === 'fan1' ? remote : ({ ...remote, endpointId: 'ac1', description: { codeUrl: `https://example.invalid/code?ircodeid=${TCL_PROFILE_ID}` } }) }),
    createSender: () => ({ send: async (hub, c) => send(hub, c.codeList[0].code) }),
    createControl: () => ({ sendCode: send }),
    createSensors: () => ({ read: async () => { sensorReads++; return { temperature: 27.13, humidity: 46.77, observedAt: Date.now() }; } }),
  });
  await platform.refresh();
  return { platform, api, sent, release: () => release(), sensorReads: () => sensorReads,
    speed: accessories.find(a => a.getService(api.hap.Service.Fanv2)).getService(api.hap.Service.Fanv2).getCharacteristic(api.hap.Characteristic.RotationSpeed),
    preset: accessories.find(a => a.context.acPreset)?.getService(api.hap.Service.Switch).getCharacteristic(api.hap.Characteristic.On),
    button: accessories.find(a => a.context.genericButton)?.getService(api.hap.Service.Switch).getCharacteristic(api.hap.Characteristic.On),
  };
}
test('fan and AC commands serialize on the same hub across cloud refreshes', async () => {
  const f = await mixedPlatformFixture();
  const first = f.speed.handleSetRequest(50);
  await new Promise(setImmediate); assert.deepEqual(f.sent, ['1']);
  await f.platform.refresh();
  const second = f.preset.handleSetRequest(true);
  await new Promise(setImmediate); assert.deepEqual(f.sent, ['1']);
  f.release(); await Promise.all([first, second]); assert.equal(f.sent.length, 2);
  f.api.emit('shutdown');
});
test('shared hub queue never sends a pending command after shutdown', async () => {
  const f = await mixedPlatformFixture();
  const first = f.speed.handleSetRequest(50); await new Promise(setImmediate);
  const second = f.preset.handleSetRequest(true);
  const rejected = assert.rejects(second, error => error === -70402);
  await new Promise(setImmediate); f.api.emit('shutdown'); f.release();
  await Promise.all([first, rejected]); assert.deepEqual(f.sent, ['1']);
});
test('sensor polling waits for a command on the same hub without sending AC controls', async () => {
  const f = await mixedPlatformFixture(true);
  assert.equal(f.sensorReads(), 1); assert.equal(f.sent.length, 0);
  const first = f.speed.handleSetRequest(50); await new Promise(setImmediate);
  const refresh = f.platform.refresh(); await new Promise(setImmediate);
  assert.equal(f.sensorReads(), 1); assert.deepEqual(f.sent, ['1']);
  f.release(); await Promise.all([first, refresh]);
  assert.equal(f.sensorReads(), 2); assert.deepEqual(f.sent, ['1']); f.api.emit('shutdown');
});
test('HVAC platform refresh exposes measured RM MAX temperature without controlling AC and fails stale reads', async () => {
  const api = new HomebridgeAPI(); const accessories: any[] = []; let sends = 0; let failed = false;
  api.registerPlatformAccessories = (_p: string, _n: string, list: any[]) => { accessories.push(...list); };
  const config = { platform: 'BroadlinkCloud', sessionFile: 'C:/session.json', airConditioners: [{ remoteId: 'ac1', hubId: 'hub1', name: 'TCL AC' }] };
  const deps = {
    readSession: async () => ({ userId: 'u', loginSession: 's', familyId: 'f' }),
    createClient: () => ({ listDevices: async () => { if (failed) throw Error('secret'); return [{ endpointId: 'hub1' }]; }, getRemote: async () => ({ ...remote, endpointId: 'ac1', description: { codeUrl: `https://example.invalid/code?ircodeid=${TCL_PROFILE_ID}` } }) }),
    createControl: () => ({ sendCode: async () => { sends++; } }),
    createSensors: () => ({ read: async () => ({ temperature: 27.13, humidity: 46.77, observedAt: Date.now() }) }),
  };
  const log = { error() {}, warn() {}, info() {}, debug() {} } as any;
  const platform = new BroadlinkCloudPlatform(log, config as any, api, deps);
  await platform.refresh(); assert.equal(accessories.length, 1); assert.equal(sends, 0);
  const thermostat = accessories[0].getService(api.hap.Service.Thermostat);
  assert.ok(thermostat);
  const temperature = thermostat.getCharacteristic(api.hap.Characteristic.CurrentTemperature);
  assert.ok(Math.abs(Number(await temperature.handleGetRequest()) - 27.13) < 0.05);
  const restored = new BroadlinkCloudPlatform(log, config as any, api, deps);
  restored.configureAccessory(accessories[0]); await restored.refresh();
  assert.equal(accessories.length, 1); assert.equal(sends, 0);
  failed = true; await restored.refresh();
  await assert.rejects(temperature.handleGetRequest(), error => error === -70402);
  assert.equal(sends, 0); api.emit('shutdown');
});
test('rejects preset and thermostat interfaces for the same AC remote at startup', () => {
  const api = new HomebridgeAPI();
  assert.throws(() => new BroadlinkCloudPlatform({ error() {}, warn() {}, info() {}, debug() {} } as any, {
    platform: 'BroadlinkCloud', sessionFile: 'C:/session.json',
    acPresets: [{ id: 'cool', name: 'AC Cool', remoteId: 'ac1', hubId: 'hub1', power: true, temperature: 25, mode: 'cool', speed: 'auto', swing: false }],
    airConditioners: [{ remoteId: 'ac1', hubId: 'hub1', name: 'TCL AC' }],
  } as any, api), /Choose either acPresets or airConditioners for each AC remote/);
});

test('expired discovery renews once and restarts read-only discovery without sending commands', async () => {
  for (const expiryLocation of ['list', 'remote']) {
    let renewals = 0; let lists = 0;
    const f = fixture({
      renewSession: async () => { renewals++; return { userId: 'u', loginSession: 'renewed', familyId: 'f' }; },
      createClient: (session: any) => ({
        listDevices: async () => { lists++; if (expiryLocation === 'list' && session.loginSession !== 'renewed') throw new CloudSessionExpiredError(); return [{ endpointId: 'hub1' }]; },
        getRemote: async () => { if (expiryLocation === 'remote' && session.loginSession !== 'renewed') throw new CloudSessionExpiredError(); return remote; },
      }),
    });
    await Promise.all([f.platform.refresh(), f.platform.refresh()]);
    assert.equal(renewals, 1); assert.equal(lists, 2); assert.equal(f.accessories.length, 1); assert.deepEqual(f.commands, []);
  }
});
test('failed renewal backs off, retains cache and accepts an externally replaced session', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let expired = false; let renewals = 0;
  const f = fixture({
    renewSession: async () => { renewals++; throw Error('PRIVATE incorrect password'); },
    createClient: () => ({ listDevices: async () => { if (expired) throw new CloudSessionExpiredError(); return [{ endpointId: 'hub1' }]; }, getRemote: async () => remote }),
  });
  await f.platform.refresh(); expired = true;
  await f.platform.refresh(); await f.platform.refresh();
  assert.equal(renewals, 1); assert.equal(f.accessories.length, 1);
  assert.ok(f.logs.some(message => message.includes('email and password')));
  assert.ok(!f.logs.join('').includes('PRIVATE'));
  t.mock.timers.tick(300_001); await f.platform.refresh(); assert.equal(renewals, 2);
  const fan = f.accessories[0].getService('fan')!;
  await assert.rejects(fan.getCharacteristic('active').setter!(1), /-70402/);
  expired = false; await f.platform.refresh();
  await fan.getCharacteristic('active').setter!(1); assert.deepEqual(f.commands, ['1']);
});
test('generic discovery failures do not renew and physical command failures never replay', async () => {
  let renewals = 0;
  const broken = fixture({ renewSession: async () => { renewals++; throw Error('unexpected'); }, createClient: () => ({ listDevices: async () => { throw Error('network'); } }) });
  await broken.platform.refresh(); assert.equal(renewals, 0);
  let sends = 0;
  const f = fixture({ renewSession: async () => { renewals++; throw Error('unexpected'); }, createSender: () => ({ send: async () => { sends++; throw new CloudSessionExpiredError(); } }) });
  await f.platform.refresh(); await assert.rejects(f.accessories[0].getService('fan')!.getCharacteristic('speed').setter!(50), /-70402/);
  assert.equal(renewals, 0); assert.equal(sends, 1);
});
test('renewed session rejected by cloud does not cause a second login or discovery loop', async () => {
  let renewals = 0; let lists = 0;
  const f = fixture({ renewSession: async () => { renewals++; return { userId: 'u', loginSession: 'new', familyId: 'f' }; }, createClient: () => ({ listDevices: async () => { lists++; throw new CloudSessionExpiredError(); } }) });
  await f.platform.refresh(); assert.equal(renewals, 1); assert.equal(lists, 2); assert.equal(f.accessories.length, 0);
});
test('expiry swallowed inside AC discovery still renews once and creates the preset without a command', async () => {
  const api = new HomebridgeAPI(); const accessories: any[] = []; let renewals = 0; let sends = 0;
  api.registerPlatformAccessories = (_p: string, _n: string, list: any[]) => { accessories.push(...list); };
  const platform = new BroadlinkCloudPlatform({ error() {}, warn() {}, info() {}, debug() {} } as any, {
    platform: 'BroadlinkCloud', sessionFile: 'C:/session.json',
    acPresets: [{ id: 'cool', name: 'Cool', remoteId: 'ac1', hubId: 'hub1', power: true, temperature: 25, mode: 'cool', speed: 'auto', swing: false }],
  } as any, api, {
    readSession: async () => ({ userId: 'u', loginSession: 'old', familyId: 'f' }),
    renewSession: async () => { renewals++; return { userId: 'u', loginSession: 'new', familyId: 'f' }; },
    createClient: session => ({ listDevices: async () => [{ endpointId: 'hub1' }], getRemote: async () => {
      if (session.loginSession === 'old') throw new CloudSessionExpiredError();
      return { ...remote, endpointId: 'ac1', description: { codeUrl: `https://example.invalid/code?ircodeid=${TCL_PROFILE_ID}` } };
    } }),
    createControl: () => ({ sendCode: async () => { sends++; } }),
  });
  await platform.refresh(); assert.equal(renewals, 1); assert.equal(accessories.length, 1); assert.equal(sends, 0); api.emit('shutdown');
});

test('fan empty form placeholders are ignored but partial or wrongly typed rows fail startup', () => {
  const api = new HomebridgeAPI(); const log = {error(){},warn(){},info(){},debug(){}} as any;
  const construct = (fans:any) => new BroadlinkCloudPlatform(log,{platform:'BroadlinkCloud',sessionFile:'C:/session.json',fans} as any,api);
  assert.doesNotThrow(()=>construct([{exposeLightToggle:false}]));
  for(const fan of [{remoteId:'fan1'}, {remoteId:'fan1',hubId:'hub1',exposeLightToggle:'yes'}, {remoteId:'fan1',hubId:'hub1',name:8}])assert.throws(()=>construct([fan]));
});

test('generic button shares fan hub queue across refresh and is blocked after shutdown', async () => {
  for (const shutdown of [false,true]) {
    const f=await mixedPlatformFixture();const first=f.speed.handleSetRequest(50);await new Promise(setImmediate);
    await f.platform.refresh();const second=f.button.handleSetRequest(true);
    const done=shutdown ? assert.rejects(second,e=>e===-70402) : second;
    await new Promise(setImmediate);assert.deepEqual(f.sent,['1']);
    if(shutdown)f.api.emit('shutdown');f.release();await Promise.all([first,done]);
    assert.deepEqual(f.sent,shutdown?['1']:['1','lighton/off']);f.api.emit('shutdown');
  }
});

test('explicit fan mapping reaches selected commands through real HAP',async()=>{
  const api=new HomebridgeAPI();const accessories:any[]=[];const sent:string[]=[];
  api.registerPlatformAccessories=(_p,_n,list)=>{accessories.push(...list);};
  const platform=new BroadlinkCloudPlatform({error(){},warn(){},info(){},debug(){}} as any,{
    platform:'BroadlinkCloud',sessionFile:'C:/session.json',fans:[{remoteId:'fan1',hubId:'hub1',commands:{off:'Stop',speeds:['Slow','Fast']}}],
  } as any,api,{
    readSession:async()=>({userId:'u',loginSession:'s',familyId:'f'}),
    createClient:()=>({listDevices:async()=>[{endpointId:'hub1'}],getRemote:async()=>({...remote,irData:['Stop','Slow','Fast'].map(command)})}),
    createSender:()=>({send:async(_h,c)=>{sent.push(c.name!);}}),
  });
  await platform.refresh();assert.equal(accessories.length,1);
  const speed=accessories[0].getService(api.hap.Service.Fanv2).getCharacteristic(api.hap.Characteristic.RotationSpeed);
  await speed.handleSetRequest(50);await speed.handleSetRequest(100);await speed.handleSetRequest(0);
  assert.deepEqual(sent,['Slow','Fast','Stop']);api.emit('shutdown');
});

test('omitted session file uses the Homebridge storage directory',async()=>{
  const api=new HomebridgeAPI();let seen='';
  const platform=new BroadlinkCloudPlatform({error(){},warn(){},info(){},debug(){}} as any,{platform:'BroadlinkCloud'},api,{
    readSession:async path=>{seen=path;throw Error('missing');},
  });
  await platform.refresh();assert.ok(seen.endsWith('broadlink-session.json'));assert.ok(seen.startsWith(api.user.storagePath()));api.emit('shutdown');
});

test('untouched optional command objects keep legacy fans and partial mappings fail',async()=>{
  const api=new HomebridgeAPI();const accessories:any[]=[];
  api.registerPlatformAccessories=(_p,_n,list)=>{accessories.push(...list);};api.updatePlatformAccessories=()=>{};
  const log={error(){},warn(){},info(){},debug(){}} as any;
  for(const commands of [{},{speeds:[]},{off:'',lightToggle:'',speeds:[]}]) {
    const platform=new BroadlinkCloudPlatform(log,{platform:'BroadlinkCloud',sessionFile:'C:/session.json',fans:[{remoteId:'fan1',hubId:'hub1',commands}]} as any,api,{
      readSession:async()=>({userId:'u',loginSession:'s',familyId:'f'}),createClient:()=>({listDevices:async()=>[{endpointId:'hub1'}],getRemote:async()=>remote}),
    });
    const before=accessories.length;await platform.refresh();assert.equal(accessories.length,before+1);
  }
  for(const commands of [{off:'Stop',speeds:[]},{off:'',speeds:['Slow']},{lightToggle:'Lamp'}, {unknown:''}]) {
    assert.throws(()=>new BroadlinkCloudPlatform(log,{platform:'BroadlinkCloud',sessionFile:'C:/session.json',fans:[{remoteId:'fan1',hubId:'hub1',commands}]} as any,api));
  }
  api.emit('shutdown');
});

test('discovered light service on cached fan is persisted once when added',async()=>{
  const api=new HomebridgeAPI();const snapshots:boolean[]=[];
  api.updatePlatformAccessories=list=>{snapshots.push(!!list[0].getService(api.hap.Service.Switch));};
  const platform=new BroadlinkCloudPlatform({error(){},warn(){},info(){},debug(){}} as any,{platform:'BroadlinkCloud',sessionFile:'C:/session.json',fans:[{remoteId:'fan1',hubId:'hub1',exposeLightToggle:true}]} as any,api,{
    readSession:async()=>({userId:'u',loginSession:'s',familyId:'f'}),createClient:()=>({listDevices:async()=>[{endpointId:'hub1'}],getRemote:async()=>remote}),
  });
  const cached=new api.platformAccessory('Fan',api.hap.uuid.generate('homebridge-broadlink-cloud:fan1'));
  cached.addService(api.hap.Service.Fanv2,'Fan');platform.configureAccessory(cached);await platform.refresh();await platform.refresh();
  assert.deepEqual(snapshots,[true]);api.emit('shutdown');
});

test('blank optional sessionFile and lightToggle use defaults without weakening required selectors',async()=>{
  const api=new HomebridgeAPI();let seen='';const accessories:any[]=[];
  api.registerPlatformAccessories=(_p,_n,list)=>{accessories.push(...list);};api.updatePlatformAccessories=()=>{};
  const platform=new BroadlinkCloudPlatform({error(){},warn(){},info(){},debug(){}} as any,{
    platform:'BroadlinkCloud',sessionFile:'',fans:[{remoteId:'fan1',hubId:'hub1',commands:{off:'Stop',speeds:['Slow'],lightToggle:''}}],
  } as any,api,{
    readSession:async path=>{seen=path;return {userId:'u',loginSession:'s',familyId:'f'};},
    createClient:()=>({listDevices:async()=>[{endpointId:'hub1'}],getRemote:async()=>({...remote,irData:['Stop','Slow'].map(command)})}),
  });
  await platform.refresh();assert.equal(accessories.length,1);assert.ok(seen.startsWith(api.user.storagePath()));assert.ok(seen.endsWith('broadlink-session.json'));api.emit('shutdown');
});

test('blank optional fan names use the default display name',async()=>{
  for(const name of ['', '   ']) {
    const api=new HomebridgeAPI();const accessories:any[]=[];
    api.registerPlatformAccessories=(_p,_n,list)=>{accessories.push(...list);};api.updatePlatformAccessories=()=>{};
    const platform=new BroadlinkCloudPlatform({error(){},warn(){},info(){},debug(){}} as any,{
      platform:'BroadlinkCloud',sessionFile:'C:/session.json',fans:[{remoteId:'fan1',hubId:'hub1',name}],
    } as any,api,{
      readSession:async()=>({userId:'u',loginSession:'s',familyId:'f'}),
      createClient:()=>({listDevices:async()=>[{endpointId:'hub1'}],getRemote:async()=>remote}),
    });
    await platform.refresh();assert.equal(accessories.length,1);assert.equal(accessories[0].displayName,'BroadLink Fan');api.emit('shutdown');
  }
});
