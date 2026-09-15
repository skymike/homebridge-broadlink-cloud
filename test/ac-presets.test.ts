import test from 'node:test';
import assert from 'node:assert/strict';
import {hap,PlatformAccessory} from './homebridge-runtime.ts';
import {AcPresetCoordinator} from '../src/ac-presets.ts';
import {encodeTcl,TCL_PROFILE_ID} from '../src/tcl.ts';
const preset={id:'cool',name:'AC Cool 25',remoteId:'remote',hubId:'hub',power:true,temperature:25,mode:'cool',speed:'auto',swing:false};
const remote={endpointId:'remote',description:{codeUrl:`https://example.invalid/code?ircodeid=${TCL_PROFILE_ID}`}};
function setup(presets:any=[preset],send=async(_hub:any,_code:string)=>{}) {
 const accessories:any[]=[]; const logs:string[]=[];
 class Accessory extends PlatformAccessory {
  registered=false;
  addService(...args:any[]) { assert.ok(this.registered,'register before adding services'); return super.addService(...args); }
 }
 const api:any={hap,platformAccessory:Accessory,registerPlatformAccessories(_p:any,_n:any,items:any[]) {items.forEach(a=>{a.registered=true;accessories.push(a);});},unregisterPlatformAccessories(){assert.fail('keep cache');}};
 const log:any={warn:(message:string)=>logs.push(message)};
 const coordinator=new AcPresetCoordinator(log,presets,api);
 const client:any={getRemote:async()=>remote}; const sender={sendCode:send};
 const refresh=()=>coordinator.refresh([{endpointId:'hub'},{endpointId:'remote'}],client,sender);
 return {coordinator,api,accessories,logs,client,sender,refresh};
}
const on=(a:any)=>a.getService(hap.Service.Switch).getCharacteristic(hap.Characteristic.On);

test('AC preset validates exact profile, sends full state and resets after actual HAP setter',async()=>{
 const sent:string[]=[]; const f=setup(undefined,async(_hub,code)=>{sent.push(code);}); await f.refresh();
 assert.equal(f.accessories.length,1); const c=on(f.accessories[0]);
 assert.equal(await c.handleGetRequest(),false);
 await c.handleSetRequest(true); assert.equal(c.value,true);
 await new Promise(setImmediate); assert.equal(c.value,false);
 assert.deepEqual(sent,[encodeTcl({...preset,key:0} as any)]);
 await c.handleSetRequest(false); assert.equal(sent.length,1); f.coordinator.shutdown();
});
test('AC presets share queue and never retry failed controls or leak errors',async()=>{
 let release!:()=>void; let attempts=0;
 const f=setup([preset,{...preset,id:'off',power:false,name:'AC Off'}],async()=>{attempts++;if(attempts===1)await new Promise<void>(r=>{release=r;});else throw Error('PRIVATE TOKEN');}); await f.refresh();
 const a=on(f.accessories[0]);const b=on(f.accessories[1]);
 const first=a.handleSetRequest(true);const second=assert.rejects(b.handleSetRequest(true),e=>e===hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
 await new Promise(setImmediate);assert.equal(attempts,1);release();await first;await second;
 await new Promise(setImmediate);assert.equal(b.value,false);assert.equal(attempts,2);assert.ok(!f.logs.join('').includes('PRIVATE'));f.coordinator.shutdown();
});
test('profile mismatch and refresh failures retain cached preset, block sends',async()=>{
 let sends=0;const f=setup(undefined,async()=>{sends++;});await f.refresh();
 f.client.getRemote=async()=>({...remote,description:{codeUrl:'https://example.invalid/code?ircodeid=wrong'}});await f.refresh();
 assert.equal(f.accessories.length,1);await assert.rejects(on(f.accessories[0]).handleSetRequest(true));assert.equal(sends,0);
 f.client.getRemote=async()=>{throw Error('PRIVATE');};await f.refresh();assert.equal(f.accessories.length,1);assert.ok(!f.logs.join('').includes('PRIVATE'));f.coordinator.shutdown();
});
test('cached ownership, removed preset and unavailable/shutdown lifecycle',async()=>{
 const f=setup();const uuid=hap.uuid.generate('homebridge-broadlink-cloud:ac-preset:cool');
 const cached=new f.api.platformAccessory('AC',uuid);cached.registered=true;cached.context={secret:'PRIVATE'};
 assert.equal(f.coordinator.configureAccessory(cached),true);assert.deepEqual(cached.context,{acPreset:true});await assert.rejects(on(cached).handleSetRequest(true));
 await f.refresh();assert.equal(f.accessories.length,0);f.coordinator.unavailable();await assert.rejects(on(cached).handleSetRequest(true));
 await f.refresh();f.coordinator.shutdown();await assert.rejects(on(cached).handleSetRequest(true));await f.refresh();assert.equal(f.accessories.length,0);
 const empty=setup([]);assert.equal(empty.coordinator.configureAccessory(cached),true);await assert.rejects(on(cached).handleSetRequest(true));
 const unknown=new f.api.platformAccessory('Other',hap.uuid.generate('other'));assert.equal(empty.coordinator.configureAccessory(unknown),false);empty.coordinator.shutdown();
});
test('invalid and duplicate complete preset configs fail before registration',()=>{
 for(const config of [null,{},[{}],[{...preset,id:''}],[{...preset,name:''}],[{...preset,remoteId:'\n'}],[{...preset,temperature:31}],[{...preset,power:1}],[{...preset,swing:undefined}],[{...preset,mode:'x'}],[preset,preset]])assert.throws(()=>setup(config));
 const f=setup(undefined);f.coordinator.shutdown();
});
test('shutdown cancels queued preset commands',async()=>{
 let release!:()=>void;let sends=0;const f=setup([preset,{...preset,id:'second'}],async()=>{sends++;await new Promise<void>(r=>{release=r;});});await f.refresh();
 const first=on(f.accessories[0]).handleSetRequest(true);const second=assert.rejects(on(f.accessories[1]).handleSetRequest(true));await new Promise(setImmediate);f.coordinator.shutdown();release();await first;await second;assert.equal(sends,1);
});

test('unsupported profiles or missing hubs create no accessories',async()=>{
 const f=setup();f.client.getRemote=async()=>({...remote,description:{codeUrl:`https://example.invalid/?ircodeid=${TCL_PROFILE_ID}&ircodeid=other`}});
 await f.refresh();assert.equal(f.accessories.length,0);
 f.client.getRemote=async()=>remote;await f.coordinator.refresh([],f.client,f.sender);assert.equal(f.accessories.length,0);f.coordinator.shutdown();
});
test('shutdown while send resolves still resets real HAP committed value',async()=>{
 let release!:()=>void;const f=setup(undefined,async()=>{await new Promise<void>(r=>{release=r;});});await f.refresh();const c=on(f.accessories[0]);
 const pending=c.handleSetRequest(true);await new Promise(setImmediate);f.coordinator.shutdown();release();await pending;await new Promise(setImmediate);assert.equal(c.value,false);
});
