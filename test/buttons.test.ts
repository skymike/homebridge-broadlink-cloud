import test from 'node:test';
import assert from 'node:assert/strict';
import { BroadlinkCloudPlatform } from '../src/platform.ts';
import { HomebridgeAPI } from './homebridge-runtime.ts';

const button = {id:'lamp',name:'Lamp toggle',remoteId:'remote',hubId:'hub',command:'Lamp'};
const log = {error(){},warn(){},info(){},debug(){}} as any;
function fixture(config: any = {}, fail = false) {
  const api = new HomebridgeAPI(); const accessories:any[]=[]; const sent:string[]=[]; let updates=0;
  api.registerPlatformAccessories=(_p,_n,list)=>{ for(const a of list) {assert.equal(a.getService(api.hap.Service.Switch),undefined);accessories.push(a);} };
  api.updatePlatformAccessories=()=>{updates++;};
  const deps={readSession:async()=>({userId:'u',loginSession:'s',familyId:'f'}),createClient:()=>({listDevices:async()=>[{endpointId:'hub'}],getRemote:async()=>({endpointId:'remote',irData:[{name:'Lamp',codeList:[{code:'lamp-code'}]}],ircodeDesc:'{}',description:{},channelList:null})}),createControl:()=>({sendCode:async(_h:any,code:string)=>{sent.push(code);if(fail)throw Error('private');}})};
  const platform=new BroadlinkCloudPlatform(log,{platform:'BroadlinkCloud',sessionFile:'C:/session.json',buttons:[button],...config},api,deps);
  return {api,platform,accessories,sent,deps,updates:()=>updates};
}
test('generic button sends once and resets after real HAP write; cache is reused without command data',async()=>{
  const f=fixture();await f.platform.refresh();assert.equal(f.accessories.length,1);assert.deepEqual(f.sent,[]);
  const accessory=f.accessories[0];const on=accessory.getService(f.api.hap.Service.Switch).getCharacteristic(f.api.hap.Characteristic.On);
  await on.handleSetRequest(true);await new Promise(setImmediate);assert.equal(on.value,false);assert.deepEqual(f.sent,['lamp-code']);
  assert.deepEqual(accessory.context,{genericButton:true});assert.equal(f.updates(),1);
  const restored=new BroadlinkCloudPlatform(log,{platform:'BroadlinkCloud',sessionFile:'C:/session.json',buttons:[button]},f.api,f.deps);
  restored.configureAccessory(accessory);await restored.refresh();assert.equal(f.accessories.length,1);
  await on.handleSetRequest(false);assert.equal(f.sent.length,1);f.api.emit('shutdown');
});
test('failed generic command is not retried and removed cached button cannot send',async()=>{
  const f=fixture({},true);await f.platform.refresh();const accessory=f.accessories[0];
  const on=accessory.getService(f.api.hap.Service.Switch).getCharacteristic(f.api.hap.Characteristic.On);
  await assert.rejects(on.handleSetRequest(true),e=>e===-70402);await new Promise(setImmediate);assert.equal(on.value,false);assert.equal(f.sent.length,1);
  const removed=new BroadlinkCloudPlatform(log,{platform:'BroadlinkCloud',sessionFile:'C:/session.json'},f.api,f.deps);removed.configureAccessory(accessory);
  await assert.rejects(on.handleSetRequest(true),e=>e===-70402);assert.equal(f.sent.length,1);f.api.emit('shutdown');
});
test('generic button config rejects partial rows and duplicate ids',()=>{
  for(const buttons of [[{id:'partial'}],[{...button,command:''}],[button,button]])assert.throws(()=>fixture({buttons}));
});


test('empty optional button row is ignored without ignoring partial rows',async()=>{
  const f=fixture({buttons:[{}]});await f.platform.refresh();assert.equal(f.accessories.length,0);f.api.emit('shutdown');
});
