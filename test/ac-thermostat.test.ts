import test from 'node:test';
import assert from 'node:assert/strict';
import {hap,PlatformAccessory} from './homebridge-runtime.ts';
import {AcThermostatCoordinator} from '../src/ac-thermostat.ts';
import {encodeTcl,TCL_PROFILE_ID} from '../src/tcl.ts';
const C=hap.Characteristic;
const config={remoteId:'ac',hubId:'hub',name:'Bedroom AC'};
const remote={endpointId:'ac',description:{codeUrl:`https://example.invalid/?ircodeid=${TCL_PROFILE_ID}`}};
function setup(send=async(_hub:any,_code:string)=>{},configs:any=[config]) {
 const accessories:any[]=[];const logs:string[]=[];
 class Accessory extends PlatformAccessory {registered=false;addService(...args:any[]){assert.ok(this.registered);return super.addService(...args);}}
 const api:any={hap,platformAccessory:Accessory,registerPlatformAccessories(_p:any,_n:any,list:any[]){for(const a of list){a.registered=true;accessories.push(a);}},unregisterPlatformAccessories(){assert.fail('retain cache');}};
 const coordinator=new AcThermostatCoordinator({warn:(m:string)=>logs.push(m)} as any,configs,api);
 const client:any={getRemote:async()=>remote};const sender={sendCode:send};
 const sensors:any={read:async()=>({temperature:27.13,humidity:46.77,observedAt:Date.now()})};
 const refresh=()=>coordinator.refresh([{endpointId:'hub'}],client,sender,sensors);
 return{accessories,logs,api,coordinator,client,sender,sensors,refresh};
}
const char=(f:any,key:any)=>f.accessories[0].getService(hap.Service.Thermostat).getCharacteristic(key);
const failure=(e:any)=>e===hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;

test('real room readings and reachable startup display; discovery sends nothing',async()=>{
 let sends=0;const f=setup(async()=>{sends++;});await f.refresh();assert.equal(sends,0);
 assert.ok(Math.abs(await char(f,C.CurrentTemperature).handleGetRequest()-27.1)<0.000001);
 const humidity=f.accessories[0].getService(hap.Service.HumiditySensor).getCharacteristic(C.CurrentRelativeHumidity);assert.ok(Math.abs(await humidity.handleGetRequest()-46.8)<0.000001);
 assert.equal(await char(f,C.TargetTemperature).handleGetRequest(),25);
 assert.equal(await char(f,C.TargetHeatingCoolingState).handleGetRequest(),0);
 assert.equal(await char(f,C.CurrentHeatingCoolingState).handleGetRequest(),0);
 assert.equal(char(f,C.TargetTemperature).props.minValue,16);assert.equal(char(f,C.TargetTemperature).props.maxValue,30);assert.equal(char(f,C.TargetTemperature).props.minStep,1);f.coordinator.shutdown();
});
test('acknowledged mode and temperature controls send exact full state and estimate HVAC demand',async()=>{
 const sent:string[]=[];const f=setup(async(_h,code)=>{sent.push(code);});await f.refresh();
 await char(f,C.TargetHeatingCoolingState).handleSetRequest(2);
 assert.equal(await char(f,C.TargetHeatingCoolingState).handleGetRequest(),2);assert.equal(await char(f,C.CurrentHeatingCoolingState).handleGetRequest(),2);
 await char(f,C.TargetTemperature).handleSetRequest(28);await new Promise(setImmediate);assert.equal(await char(f,C.CurrentHeatingCoolingState).handleGetRequest(),0);
 await char(f,C.TargetHeatingCoolingState).handleSetRequest(1);assert.equal(await char(f,C.CurrentHeatingCoolingState).handleGetRequest(),1);
 await char(f,C.TargetHeatingCoolingState).handleSetRequest(0);assert.equal(await char(f,C.CurrentHeatingCoolingState).handleGetRequest(),0);
 assert.deepEqual(sent,[['cool',25,true],['cool',28,true],['heat',28,true],['heat',28,false]].map(([mode,temperature,power])=>encodeTcl({power,mode,temperature,speed:'auto',swing:false,key:0} as any)));f.coordinator.shutdown();
});
test('serialized writes compose latest acknowledged state and do not retry failures',async()=>{
 let release!:()=>void;const sent:string[]=[];const f=setup(async(_h,code)=>{sent.push(code);if(sent.length===1)await new Promise<void>(r=>{release=r;});if(sent.length===3)throw Error('PRIVATE');});await f.refresh();
 const a=char(f,C.TargetHeatingCoolingState).handleSetRequest(1);const b=char(f,C.TargetTemperature).handleSetRequest(24);await new Promise(setImmediate);assert.equal(sent.length,1);release();await Promise.all([a,b]);
 assert.equal(sent[1],encodeTcl({power:true,mode:'heat',temperature:24,speed:'auto',swing:false,key:0}));
 await assert.rejects(char(f,C.TargetTemperature).handleSetRequest(26),failure);assert.equal(await char(f,C.TargetTemperature).handleGetRequest(),24);assert.equal(await char(f,C.TargetHeatingCoolingState).handleGetRequest(),1);assert.equal(sent.length,3);assert.ok(!f.logs.join('').includes('PRIVATE'));f.coordinator.shutdown();
});
test('sensor failure or stale readings fail measured characteristics and estimated current HVAC',async()=>{
 const f=setup();await f.refresh();await char(f,C.TargetHeatingCoolingState).handleSetRequest(2);
 f.sensors.read=async()=>({temperature:27,humidity:46,observedAt:Date.now()-180001});await f.refresh();await assert.rejects(char(f,C.CurrentTemperature).handleGetRequest(),failure);await assert.rejects(char(f,C.CurrentHeatingCoolingState).handleGetRequest(),failure);
 f.sensors.read=async()=>{throw Error('PRIVATE');};await f.refresh();await assert.rejects(char(f,C.CurrentTemperature).handleGetRequest(),failure);
 const h=f.accessories[0].getService(hap.Service.HumiditySensor).getCharacteristic(C.CurrentRelativeHumidity);await assert.rejects(h.handleGetRequest(),failure);assert.ok(!f.logs.join('').includes('PRIVATE'));f.coordinator.shutdown();
});
test('profile mismatch blocks commands and retains existing cache; initial mismatch creates none',async()=>{
 let sends=0;const f=setup(async()=>{sends++;});f.client.getRemote=async()=>({...remote,description:{codeUrl:'https://example.invalid/?ircodeid=wrong'}});await f.refresh();assert.equal(f.accessories.length,0);
 f.client.getRemote=async()=>remote;await f.refresh();f.client.getRemote=async()=>{throw Error('PRIVATE');};await f.refresh();await assert.rejects(char(f,C.TargetHeatingCoolingState).handleSetRequest(2),failure);assert.equal(sends,0);assert.equal(f.accessories.length,1);f.coordinator.shutdown();
});
test('restored and removed thermostat cache stays wired without claiming physical state',async()=>{
 const f=setup();const cached=new f.api.platformAccessory('Restored',hap.uuid.generate('homebridge-broadlink-cloud:ac:ac'));cached.registered=true;cached.context={secret:'PRIVATE'};
 assert.equal(f.coordinator.configureAccessory(cached),true);assert.deepEqual(cached.context,{acThermostat:true});await assert.rejects(cached.getService(hap.Service.Thermostat).getCharacteristic(C.CurrentTemperature).handleGetRequest());await f.refresh();assert.equal(f.accessories.length,0);f.coordinator.shutdown();
 const empty=setup(undefined,[]);assert.equal(empty.coordinator.configureAccessory(cached),true);await assert.rejects(cached.getService(hap.Service.Thermostat).getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(2));empty.coordinator.shutdown();
});
test('invalid target/mode are rejected without a transmission',async()=>{
 let sends=0;const f=setup(async()=>{sends++;});await f.refresh();
 for(const value of [15,31,25.5,NaN])await assert.rejects(char(f,C.TargetTemperature).setHandler(value));
 for(const value of [-1,4,'2',null])await assert.rejects(char(f,C.TargetHeatingCoolingState).setHandler(value));
 assert.equal(sends,0);f.coordinator.shutdown();
});
test('invalid configs reject and shutdown prevents queued commands',async()=>{
 for(const configs of [null,{},[{}],[{...config,remoteId:' '}],[config,config]])assert.throws(()=>setup(undefined,configs));
 let release!:()=>void;let sends=0;const f=setup(async()=>{sends++;await new Promise<void>(r=>{release=r;});});await f.refresh();
 const first=char(f,C.TargetHeatingCoolingState).handleSetRequest(2);const second=assert.rejects(char(f,C.TargetTemperature).handleSetRequest(26));await new Promise(setImmediate);f.coordinator.shutdown();release();await first;await second;assert.equal(sends,1);await assert.rejects(char(f,C.CurrentTemperature).handleGetRequest());
});

test('unknown power rejects temperature-only command; units are display preference only',async()=>{
 let sends=0;const f=setup(async()=>{sends++;});await f.refresh();await assert.rejects(char(f,C.TargetTemperature).handleSetRequest(24),failure);assert.equal(sends,0);assert.equal(await char(f,C.TargetTemperature).handleGetRequest(),25);
 await char(f,C.TemperatureDisplayUnits).handleSetRequest(1);assert.equal(await char(f,C.TemperatureDisplayUnits).handleGetRequest(),1);assert.equal(await char(f,C.TargetTemperature).handleGetRequest(),25);assert.equal(sends,0);f.coordinator.shutdown();
});

test('in-flight command settling after shutdown does not publish deferred sensor updates',async t=>{
 let release!:()=>void;const f=setup(async()=>{await new Promise<void>(resolve=>{release=resolve;});});await f.refresh();
 const pending=char(f,C.TargetHeatingCoolingState).handleSetRequest(2);await new Promise(setImmediate);
 f.coordinator.shutdown();
 const update=t.mock.method(char(f,C.CurrentTemperature),'updateValue');
 release();await pending;await new Promise(setImmediate);
 assert.equal(update.mock.callCount(),0);
});

const extra=(f:any,id:string)=>f.accessories[0].getServiceById(hap.Service.Switch,'ac-'+id).getCharacteristic(C.On);
test('AC grouped speed and swing preserve full state through thermostat writes',async()=>{
 const sent:string[]=[];const f=setup(async(_h,code)=>{sent.push(code);});await f.refresh();
 await extra(f,'speed-low').handleSetRequest(true);await extra(f,'swing').handleSetRequest(true);
 assert.equal(sent.length,0,'settings while power unknown must not operate AC');
 await char(f,C.TargetHeatingCoolingState).handleSetRequest(2);
 await char(f,C.TargetTemperature).handleSetRequest(23);
 assert.equal(sent.at(-1),encodeTcl({power:true,mode:'cool',temperature:23,speed:'low',swing:true,key:0}));
 await extra(f,'speed-high').handleSetRequest(true);await new Promise(setImmediate);
 assert.equal(await extra(f,'speed-low').handleGetRequest(),false);assert.equal(await extra(f,'speed-high').handleGetRequest(),true);
 await extra(f,'speed-high').handleSetRequest(false);await new Promise(setImmediate);
 assert.equal(await extra(f,'speed-high').handleGetRequest(),true,'speed selectors cannot clear selected value');
 assert.equal(sent.length,3);f.coordinator.shutdown();
});
test('Dry and Fan-only share exclusive modes and preserve speed swing and target',async()=>{
 const sent:string[]=[];const f=setup(async(_h,code)=>{sent.push(code);});await f.refresh();
 await extra(f,'speed-medium').handleSetRequest(true);await extra(f,'swing').handleSetRequest(true);
 await extra(f,'dry').handleSetRequest(true);await char(f,C.TargetTemperature).handleSetRequest(24);
 assert.equal(sent.at(-1),encodeTcl({power:true,mode:'dry',temperature:24,speed:'medium',swing:true,key:0}));
 await extra(f,'fan').handleSetRequest(true);await extra(f,'dry').handleSetRequest(false);
 assert.equal(sent.length,3,'turning off an inactive mode cannot stop another mode');
 assert.equal(await extra(f,'dry').handleGetRequest(),false);assert.equal(await extra(f,'fan').handleGetRequest(),true);
 await char(f,C.TargetHeatingCoolingState).handleSetRequest(1);
 assert.equal(await extra(f,'fan').handleGetRequest(),false);
 assert.equal(sent.at(-1),encodeTcl({power:true,mode:'heat',temperature:24,speed:'medium',swing:true,key:0}));
 await extra(f,'dry').handleSetRequest(true);await extra(f,'dry').handleSetRequest(false);
 assert.equal(sent.at(-1),encodeTcl({power:false,mode:'dry',temperature:24,speed:'medium',swing:true,key:0}));f.coordinator.shutdown();
});
test('extra controls roll back failed writes and fail on lost discovery',async()=>{
 let fail=false;let sends=0;const f=setup(async()=>{sends++;if(fail)throw Error('PRIVATE');});await f.refresh();
 await char(f,C.TargetHeatingCoolingState).handleSetRequest(2);fail=true;
 await assert.rejects(extra(f,'speed-high').handleSetRequest(true),failure);await new Promise(setImmediate);
 assert.equal(await extra(f,'speed-auto').handleGetRequest(),true);assert.equal(await extra(f,'speed-high').handleGetRequest(),false);assert.equal(sends,2);
 f.coordinator.unavailable();await assert.rejects(extra(f,'swing').handleGetRequest(),failure);await assert.rejects(extra(f,'dry').handleSetRequest(true),failure);assert.equal(sends,2);f.coordinator.shutdown();
});
test('cached AC migration reuses all grouped controls and sends nothing',async()=>{
 const f=setup();await f.refresh();const a=f.accessories[0];const n=a.services.length;
 const next=setup();next.coordinator.configureAccessory(a);await next.refresh();
 assert.equal(a.services.length,n);assert.equal(next.accessories.length,0);assert.equal(a.services.filter((s:any)=>s.UUID===hap.Service.Switch.UUID).length,7);
 f.coordinator.shutdown();next.coordinator.shutdown();
});

test('concurrent grouped writes compose acknowledged state and shutdown blocks later changes',async()=>{
 const sent:string[]=[];let release!:()=>void;let delay=false;
 const f=setup(async(_h,code)=>{sent.push(code);if(delay){delay=false;await new Promise<void>(r=>{release=r;});}});await f.refresh();
 await char(f,C.TargetHeatingCoolingState).handleSetRequest(2);delay=true;
 const speed=extra(f,'speed-high').handleSetRequest(true);const swing=extra(f,'swing').handleSetRequest(true);
 await new Promise(setImmediate);assert.equal(sent.length,2);release();await Promise.all([speed,swing]);
 assert.equal(sent[2],encodeTcl({power:true,mode:'cool',temperature:25,speed:'high',swing:true,key:0}));
 await extra(f,'speed-auto').handleSetRequest(true);await extra(f,'swing').handleSetRequest(false);
 assert.equal(sent.at(-1),encodeTcl({power:true,mode:'cool',temperature:25,speed:'auto',swing:false,key:0}));
 f.coordinator.shutdown();await assert.rejects(extra(f,'speed-low').handleSetRequest(true),failure);assert.equal(sent.length,5);
});
