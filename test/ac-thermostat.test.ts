import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {AcThermostatCoordinator} from '../src/ac-thermostat.ts';
import {encodeTcl,TCL_PROFILE_ID} from '../src/tcl.ts';
const require=createRequire(import.meta.url);const hr=createRequire(require.resolve('homebridge'));const hap=hr('hap-nodejs');const {PlatformAccessory}=require('homebridge/lib/platformAccessory');
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

test('real room sensor readings, default target and unknown command state; discovery sends nothing',async()=>{
 let sends=0;const f=setup(async()=>{sends++;});await f.refresh();assert.equal(sends,0);
 assert.ok(Math.abs(await char(f,C.CurrentTemperature).handleGetRequest()-27.1)<0.000001);
 const humidity=f.accessories[0].getService(hap.Service.HumiditySensor).getCharacteristic(C.CurrentRelativeHumidity);assert.ok(Math.abs(await humidity.handleGetRequest()-46.8)<0.000001);
 assert.equal(await char(f,C.TargetTemperature).handleGetRequest(),25);
 await assert.rejects(char(f,C.TargetHeatingCoolingState).handleGetRequest(),failure);
 await assert.rejects(char(f,C.CurrentHeatingCoolingState).handleGetRequest(),failure);
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
