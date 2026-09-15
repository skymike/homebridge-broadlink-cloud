import type {API,Logger,PlatformAccessory,Service} from 'homebridge';
import type {Endpoint,Remote} from './client.ts';
import {encodeTcl,TCL_PROFILE_ID,type TclState} from './tcl.ts';

const PLUGIN='homebridge-broadlink-cloud';
const PLATFORM='BroadlinkCloud';
export interface AcPresetConfig extends Omit<TclState,'key'> {id:string;name:string;remoteId:string;hubId:string}
interface Client {getRemote(id:string):Promise<Remote>}
interface Sender {sendCode(hub:Endpoint,hex:string):Promise<void>}
interface Runtime {config:AcPresetConfig;accessory:PlatformAccessory;service:Service;available:boolean;hub?:Endpoint;sender?:Sender}
const identifier=(v:unknown):v is string=>typeof v==='string' && v.trim().length>0 && v===v.trim() && !/[\x00-\x1f\x7f]/.test(v);

/** Momentary complete-state commands; these switches do not report physical AC state. */
export class AcPresetCoordinator {
  private readonly api:API;
  private readonly log:Logger;
  private readonly configs:AcPresetConfig[];
  private readonly runtime=new Map<string,Runtime>();
  private readonly queues=new Map<string,Promise<void>>();
  private readonly resets=new Set<ReturnType<typeof setImmediate>>();
  private stopped=false;
  private revision=0;
  constructor(log:Logger,presets:unknown,api:API) {
    this.log=log;this.api=api;
    if (presets===undefined) presets=[];
    if (!Array.isArray(presets)) throw new Error('acPresets must be an array');
    this.configs=presets.map(value=>{
      if (!value || typeof value!=='object' || Array.isArray(value)
          || !['id','name','remoteId','hubId'].every(key=>identifier(value[key]))) throw new Error('Each AC preset requires explicit id, name, remoteId and hubId');
      try {encodeTcl({...value,key:0});} catch {throw new Error('Each AC preset requires valid complete TCL power, temperature, mode, speed and swing');}
      const {id,name,remoteId,hubId,power,temperature,mode,speed,swing}=value;
      return {id,name,remoteId,hubId,power,temperature,mode,speed,swing};
    });
    if (new Set(this.configs.map(c=>c.id)).size!==this.configs.length) throw new Error('Duplicate AC preset id');
    const hubs=new Map<string,string>();
    for(const c of this.configs) {
      if(hubs.has(c.remoteId) && hubs.get(c.remoteId)!==c.hubId) throw new Error('AC presets for the same remote require the same hub');
      hubs.set(c.remoteId,c.hubId);
    }
  }
  configureAccessory(accessory:PlatformAccessory):boolean {
    const config=this.configs.find(c=>this.uuid(c.id)===accessory.UUID);
    if(!config && accessory.context.acPreset!==true) return false;
    accessory.context={acPreset:true};
    if(config) this.attach(accessory,config);
    else {
      const C=this.api.hap.Characteristic;
      const service=accessory.getService(this.api.hap.Service.Switch);
      service?.getCharacteristic(C.On).onGet(()=>false).onSet(async value=>{
        if(value===true) throw this.failure();
      });
      service?.updateCharacteristic(C.On,false);
    }
    return true;
  }
  async refresh(endpoints:Endpoint[],client:Client,sender:Sender):Promise<void> {
    if(this.stopped) return;
    const revision=++this.revision;
    const remotes=new Map<string,Promise<Remote>>();
    for(const config of this.configs) {
      try {
        const hub=endpoints.find(e=>e.endpointId===config.hubId);
        if(!hub) throw new Error('Hub unavailable');
        let pending=remotes.get(config.remoteId);
        if(!pending) {pending=client.getRemote(config.remoteId);remotes.set(config.remoteId,pending);}
        const remote=await pending;
        if(remote.endpointId!==config.remoteId || typeof remote.description?.codeUrl!=='string'
           || new URL(remote.description.codeUrl).searchParams.getAll('ircodeid').length!==1
           || new URL(remote.description.codeUrl).searchParams.get('ircodeid')!==TCL_PROFILE_ID) throw new Error('Unsupported AC profile');
        if(this.stopped || revision!==this.revision) return;
        let runtime=this.runtime.get(config.id);
        if(!runtime) {
          const accessory=new this.api.platformAccessory(config.name,this.uuid(config.id));
          accessory.context={acPreset:true};
          this.api.registerPlatformAccessories(PLUGIN,PLATFORM,[accessory]);
          runtime=this.attach(accessory,config);
        }
        runtime.hub=hub;runtime.sender=sender;runtime.available=true;
      } catch {
        if(this.stopped || revision!==this.revision) return;
        const runtime=this.runtime.get(config.id);if(runtime)runtime.available=false;
        this.log.warn('AC preset discovery failed or profile unsupported; cached accessory retained.');
      }
    }
  }
  unavailable():void {this.revision++;for(const runtime of this.runtime.values())runtime.available=false;}
  shutdown():void {
    this.stopped=true;this.unavailable();
    for(const reset of this.resets)clearImmediate(reset);
    this.resets.clear();
    for(const runtime of this.runtime.values())runtime.service.updateCharacteristic(this.api.hap.Characteristic.On,false);
  }
  private uuid(id:string):string {return this.api.hap.uuid.generate(`${PLUGIN}:ac-preset:${id}`);}
  private failure():Error {return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);}
  private attach(accessory:PlatformAccessory,config:AcPresetConfig):Runtime {
    const {Service:S,Characteristic:C}=this.api.hap;
    const service=accessory.getService(S.Switch)??accessory.addService(S.Switch,config.name);
    const runtime:Runtime={accessory,config,service,available:false};
    this.runtime.set(config.id,runtime);
    accessory.getService(S.AccessoryInformation)?.setCharacteristic(C.Manufacturer,'TCL').setCharacteristic(C.Model,'TCL GYKQ-03_1014 Preset');
    service.getCharacteristic(C.On).onGet(()=>false).onSet(async value=>{
      if(value===false)return;
      if(value!==true)throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      const previous=this.queues.get(config.hubId)??Promise.resolve();
      const operation=previous.then(async()=>{
        if(this.stopped || !runtime.available || !runtime.hub || !runtime.sender)throw this.failure();
        await runtime.sender.sendCode(runtime.hub,encodeTcl({...config,key:0}));
      });
      this.queues.set(config.hubId,operation.catch(()=>{}));
      try {await operation;} catch {
        runtime.available=false;
        this.log.warn('AC preset command failed; command was not retried.');
        throw this.failure();
      } finally {
        // HAP commits the requested true value after this handler resolves.
        // Reset in the next event-loop turn, after that commit, on success and error.
        const reset=setImmediate(()=>{this.resets.delete(reset);service.updateCharacteristic(C.On,false);});
        reset.unref();
        this.resets.add(reset);
      }
    });
    service.updateCharacteristic(C.On,false);
    return runtime;
  }
}
