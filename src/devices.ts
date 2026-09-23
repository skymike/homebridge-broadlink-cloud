import type {API,Logger,PlatformAccessory,Service} from 'homebridge';
import type {Endpoint,Remote} from './client.ts';
import {selectCommand,validCommandName} from './fan-mapping.ts';
import {deviceCategories,type DeviceConfig} from './device-categories.ts';
const PLUGIN='homebridge-broadlink-cloud';
type Sender={sendCode(hub:Endpoint,code:string):Promise<void>};
interface Runtime {accessory:PlatformAccessory;config:DeviceConfig;available:boolean;hub?:Endpoint;sender?:Sender;codes:Map<string,string>;on?:boolean;position?:number;}
export class DeviceCoordinator {
 private configs:DeviceConfig[];private runtime=new Map<string,Runtime>();private stopped=false;private pending=new Set<ReturnType<typeof setImmediate>>();
 private log:Logger;private api:API;
 constructor(log:Logger,rows:unknown,api:API){
  this.log=log;this.api=api;
  if(rows===undefined)rows=[];if(!Array.isArray(rows))throw Error('devices must be an array');
  this.configs=rows.map(c=>{
   if(!c||!['name','remoteId','hubId'].every(k=>validCommandName(c[k]))||!Object.hasOwn(deviceCategories,c.category)||!c.commands||typeof c.commands!=='object'||Array.isArray(c.commands))throw Error('Invalid device category configuration');
   const keys=Object.keys(c.commands);if(!keys.length||keys.length>80||keys.some(k=>!validCommandName(k)||!validCommandName(c.commands[k])))throw Error('Device needs mapped commands');
   const service=deviceCategories[c.category as keyof typeof deviceCategories].service;
   if(['WindowCovering','Door'].includes(service)&&(!c.commands.open||!c.commands.close))throw Error('Covering requires separate open and close commands');
   if(new Set(Object.values(c.commands)).size!==keys.length)throw Error('Device command mappings must be distinct');
   return {...c,commands:{...c.commands}};
  });
  if(new Set(this.configs.map(c=>c.remoteId)).size!==this.configs.length)throw Error('Duplicate device remote');
 }
 private id(c:DeviceConfig){return this.api.hap.uuid.generate(PLUGIN+':device:'+c.remoteId);}
 configureAccessory(a:PlatformAccessory){
  const c=this.configs.find(c=>this.id(c)===a.UUID);if(!c&&!a.context.categoryDevice)return false;
  if(c)this.attach(a,c);else for(const s of a.services)for(const ch of s.characteristics){if(ch.props.perms.includes(this.api.hap.Perms.PAIRED_WRITE))ch.onSet(async()=>{throw this.error();});}
  return true;
 }
 private error(){return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);}
 async refresh(endpoints:Endpoint[],client:{getRemote(id:string):Promise<Remote>},sender:Sender){
  for(const c of this.configs){try{
   const hub=endpoints.find(e=>e.endpointId===c.hubId);if(!hub)throw this.error();const remote=await client.getRemote(c.remoteId);const codes=new Map<string,string>();
   for(const [key,name]of Object.entries(c.commands))codes.set(key,selectCommand(remote,name).codeList[0].code);
   if(this.stopped)return;let r=this.runtime.get(c.remoteId);if(!r){const a=new this.api.platformAccessory(c.name,this.id(c));a.context={categoryDevice:true};this.api.registerPlatformAccessories(PLUGIN,'BroadlinkCloud',[a]);r=this.attach(a,c);}
   r.hub=hub;r.sender=sender;r.codes=codes;r.available=true;
  }catch{const r=this.runtime.get(c.remoteId);if(r)r.available=false;this.log.warn('Device command discovery failed; cached accessory retained.');}}
 }
 private async send(r:Runtime,key:string){if(this.stopped||!r.available||!r.hub||!r.sender||!r.codes.has(key))throw this.error();try{await r.sender.sendCode(r.hub,r.codes.get(key)!);}catch{r.available=false;throw this.error();}}
 private later(fn:()=>void){const p=setImmediate(()=>{this.pending.delete(p);if(!this.stopped)fn();});this.pending.add(p);}
 private attach(a:PlatformAccessory,c:DeviceConfig){
  const S=this.api.hap.Service,C=this.api.hap.Characteristic;const r:Runtime={accessory:a,config:c,available:false,codes:new Map()};this.runtime.set(c.remoteId,r);a.context={categoryDevice:true};
  const spec=deviceCategories[c.category];const keep=new Set<Service>();const used=new Set<string>();
  const service=(Type:typeof S.Switch,name:string,subtype:string)=>{const s=a.getServiceById(Type,subtype)??a.addService(Type,name,subtype);keep.add(s);return s;};
  if(spec.service==='WindowCovering'||spec.service==='Door'){
   const s=service(S[spec.service] as typeof S.Switch,c.name,'main');s.setPrimaryService();used.add('open');used.add('close');
   s.getCharacteristic(C.CurrentPosition).onGet(()=>{if(!r.available||r.position===undefined)throw this.error();return r.position;});
   s.getCharacteristic(C.TargetPosition).setProps({validValues:[0,100],minStep:100}).onGet(()=>{if(!r.available||r.position===undefined)throw this.error();return r.position;}).onSet(async value=>{if(value!==0&&value!==100)throw new this.api.hap.HapStatusError(-70410);await this.send(r,value===100?'open':'close');r.position=Number(value);s.updateCharacteristic(C.CurrentPosition,r.position);});
   s.getCharacteristic(C.PositionState).onGet(()=>C.PositionState.STOPPED);
  }else if(c.commands.on&&c.commands.off){
   const s=service(S[spec.service] as typeof S.Switch,c.name,'main');s.setPrimaryService();used.add('on');used.add('off');
   s.getCharacteristic(C.On).onGet(()=>{if(!r.available)throw this.error();return r.on??false;}).onSet(async value=>{if(typeof value!=='boolean')throw new this.api.hap.HapStatusError(-70410);await this.send(r,value?'on':'off');r.on=value;});
  }
  for(const key of Object.keys(c.commands)){if(used.has(key))continue;const label=key.replaceAll('_',' ');const s=service(S.Switch,c.name+' '+label,'command:'+key);s.getCharacteristic(C.On).onGet(()=>false).onSet(async value=>{if(value!==true)return;try{await this.send(r,key);}finally{this.later(()=>s.updateCharacteristic(C.On,false));}});s.updateCharacteristic(C.On,false);}
  for(const s of [...a.services])if(s.UUID!==S.AccessoryInformation.UUID&&!keep.has(s))a.removeService(s);
  this.api.updatePlatformAccessories([a]);return r;
 }
 unavailable(){for(const r of this.runtime.values())r.available=false;}
 shutdown(){this.stopped=true;this.unavailable();for(const p of this.pending)clearImmediate(p);this.pending.clear();}
}
