import type {API,Logger,PlatformAccessory,Service} from 'homebridge';
import type {Endpoint,Remote} from './client.ts';
import {encodeTcl,TCL_PROFILE_ID,type TclState} from './tcl.ts';

const PLUGIN='homebridge-broadlink-cloud';
const PLATFORM='BroadlinkCloud';
export const AC_SENSOR_MAX_AGE_MS=180_000;
export interface AcThermostatConfig {remoteId:string;hubId:string;name?:string}
export interface AcRoomReading {temperature:number;humidity:number;observedAt:number}
interface Client {getRemote(id:string):Promise<Remote>}
interface Sender {sendCode(hub:Endpoint,hex:string):Promise<void>}
interface Sensors {read(hub:Endpoint):Promise<AcRoomReading>}
interface Runtime {
  config:AcThermostatConfig;accessory:PlatformAccessory;thermostat:Service;humidity:Service;
  available:boolean;hub?:Endpoint;sender?:Sender;reading?:AcRoomReading;
  target:number;displayUnits:number;targetMode?:number;lastIrMode:TclState['mode'];queue:Promise<void>;
}
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v);
const tenth=(v:number):number=>Math.round(v*10)/10;

/**
 * Current temperature/humidity are measured by the room's RM MAX.
 * CurrentHeatingCoolingState is estimated demand from measured temperature and
 * the last acknowledged IR command. It is never compressor telemetry.
 * Target 25C is a setup default. An explicit mode write is required before temperature writes.
 */
export class AcThermostatCoordinator {
  private readonly log:Logger;
  private readonly api:API;
  private readonly configs:AcThermostatConfig[];
  private readonly runtimes=new Map<string,Runtime>();
  private readonly deferred=new Set<ReturnType<typeof setImmediate>>();
  private stopped=false;
  private revision=0;
  constructor(log:Logger,configs:unknown,api:API) {
    this.log=log;this.api=api;
    if(configs===undefined)configs=[];
    if(!Array.isArray(configs))throw new Error('airConditioners must be an array');
    this.configs=configs.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value)||!identifier(value.remoteId)||!identifier(value.hubId)
        ||(value.name!==undefined&&!identifier(value.name)))throw new Error('Each AC requires explicit remoteId, hubId and an optional valid name');
      return{remoteId:value.remoteId,hubId:value.hubId,name:value.name};
    });
    if(new Set(this.configs.map(c=>c.remoteId)).size!==this.configs.length)throw new Error('Duplicate AC remoteId');
  }
  configureAccessory(accessory:PlatformAccessory):boolean {
    const config=this.configs.find(c=>this.uuid(c.remoteId)===accessory.UUID);
    if(!config&&accessory.context.acThermostat!==true)return false;
    accessory.context={acThermostat:true};
    if(config)this.attach(accessory,config);
    else {
      const C=this.api.hap.Characteristic;
      for(const service of accessory.services) {
        for(const type of [C.CurrentTemperature,C.CurrentRelativeHumidity,C.TargetTemperature,C.TargetHeatingCoolingState,C.CurrentHeatingCoolingState]) {
          if(!service.testCharacteristic(type))continue;
          service.getCharacteristic(type).onGet(()=>{throw this.failure();}).onSet(async()=>{throw this.failure();}).updateValue(this.failure());
        }
      }
    }
    return true;
  }
  async refresh(endpoints:Endpoint[],client:Client,sender:Sender,sensors:Sensors):Promise<void> {
    if(this.stopped)return;
    const revision=++this.revision;
    const sensorReads=new Map<string,Promise<AcRoomReading>>();
    for(const config of this.configs) {
      try {
        const hub=endpoints.find(e=>e.endpointId===config.hubId);
        if(!hub)throw new Error('Hub missing');
        const remote=await client.getRemote(config.remoteId);
        if(remote.endpointId!==config.remoteId||typeof remote.description?.codeUrl!=='string')throw new Error('Unsupported profile');
        const ids=new URL(remote.description.codeUrl).searchParams.getAll('ircodeid');
        if(ids.length!==1||ids[0]!==TCL_PROFILE_ID)throw new Error('Unsupported profile');
        if(this.stopped||revision!==this.revision)return;
        let runtime=this.runtimes.get(config.remoteId);
        if(!runtime) {
          const accessory=new this.api.platformAccessory(config.name??'TCL AC',this.uuid(config.remoteId));
          accessory.context={acThermostat:true};
          this.api.registerPlatformAccessories(PLUGIN,PLATFORM,[accessory]);
          runtime=this.attach(accessory,config);
        }
        runtime.hub=hub;runtime.sender=sender;runtime.available=true;
        try {
          let read=sensorReads.get(config.hubId);
          if(!read){read=sensors.read(hub);sensorReads.set(config.hubId,read);}
          const reading=await read;
          if(this.stopped||revision!==this.revision)return;
          if(!reading||!Number.isFinite(reading.temperature)||reading.temperature< -40||reading.temperature>100
            ||!Number.isFinite(reading.humidity)||reading.humidity<0||reading.humidity>100
            ||!Number.isFinite(reading.observedAt)||reading.observedAt>Date.now()+1000||Date.now()-reading.observedAt>AC_SENSOR_MAX_AGE_MS)throw new Error('Invalid sensor sample');
          runtime.reading={...reading};
        } catch {
          if(this.stopped||revision!==this.revision)return;
          runtime.reading=undefined;
          this.log.warn('AC room sensor unavailable; measured values will report unavailable.');
        }
        this.publish(runtime);
      } catch {
        if(this.stopped||revision!==this.revision)return;
        const runtime=this.runtimes.get(config.remoteId);
        if(runtime){runtime.available=false;runtime.reading=undefined;this.publish(runtime);}
        this.log.warn('AC discovery failed or profile unsupported; cached accessory retained.');
      }
    }
  }
  unavailable():void {
    this.revision++;
    for(const runtime of this.runtimes.values()){runtime.available=false;runtime.reading=undefined;this.publish(runtime);}
  }
  shutdown():void {
    this.stopped=true;this.unavailable();
    for(const handle of this.deferred)clearImmediate(handle);
    this.deferred.clear();
  }
  private uuid(id:string):string{return this.api.hap.uuid.generate(`${PLUGIN}:ac:${id}`);}
  private failure():Error{return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);}
  private invalid():Error{return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);}
  private sample(runtime:Runtime):AcRoomReading {
    const sample=runtime.reading;
    if(this.stopped||!runtime.available||!sample||Date.now()-sample.observedAt>AC_SENSOR_MAX_AGE_MS)throw this.failure();
    return sample;
  }
  private commandedMode(runtime:Runtime):number {
    if(this.stopped||!runtime.available||runtime.targetMode===undefined)throw this.failure();
    return runtime.targetMode;
  }
  private currentDemand(runtime:Runtime):number {
    const mode=this.commandedMode(runtime);
    const temperature=this.sample(runtime).temperature;
    if(mode===0)return 0;
    if((mode===1||mode===3)&&temperature<runtime.target)return 1;
    if((mode===2||mode===3)&&temperature>runtime.target)return 2;
    return 0;
  }
  private attach(accessory:PlatformAccessory,config:AcThermostatConfig):Runtime {
    const {Service:S,Characteristic:C}=this.api.hap;
    const thermostat=accessory.getService(S.Thermostat)??accessory.addService(S.Thermostat,config.name??'TCL AC');
    const humidity=accessory.getService(S.HumiditySensor)??accessory.addService(S.HumiditySensor,'Room Humidity');
    const runtime:Runtime={config,accessory,thermostat,humidity,available:false,target:25,displayUnits:0,lastIrMode:'cool',queue:Promise.resolve()};
    this.runtimes.set(config.remoteId,runtime);
    accessory.getService(S.AccessoryInformation)?.setCharacteristic(C.Manufacturer,'TCL').setCharacteristic(C.Model,'GYKQ-03_1014 with RM MAX room sensor');
    thermostat.getCharacteristic(C.CurrentTemperature).setProps({minValue:-40,maxValue:100,minStep:0.1}).onGet(()=>tenth(this.sample(runtime).temperature));
    humidity.getCharacteristic(C.CurrentRelativeHumidity).setProps({minStep:0.1}).onGet(()=>tenth(this.sample(runtime).humidity));
    thermostat.getCharacteristic(C.TargetTemperature).updateValue(runtime.target).setProps({minValue:16,maxValue:30,minStep:1}).onGet(()=>runtime.target).onSet(async value=>{
      if(typeof value!=='number'||!Number.isInteger(value)||value<16||value>30)throw this.invalid();
      await this.command(runtime,{target:value});
    });
    thermostat.getCharacteristic(C.TargetHeatingCoolingState).setProps({validValues:[0,1,2,3]}).onGet(()=>this.commandedMode(runtime)).onSet(async value=>{
      if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>3)throw this.invalid();
      await this.command(runtime,{mode:value});
    });
    thermostat.getCharacteristic(C.CurrentHeatingCoolingState).onGet(()=>this.currentDemand(runtime));
    thermostat.getCharacteristic(C.TemperatureDisplayUnits).onGet(()=>runtime.displayUnits).onSet(async value=>{if(value!==0&&value!==1)throw this.invalid();runtime.displayUnits=value;});
    this.publish(runtime);
    return runtime;
  }
  private async command(runtime:Runtime,change:{target?:number;mode?:number}):Promise<void> {
    const operation=runtime.queue.then(async()=>{
      if(this.stopped||!runtime.available||!runtime.hub||!runtime.sender)throw this.failure();
      if(change.target!==undefined&&runtime.targetMode===undefined)throw this.failure();
      const target=change.target??runtime.target;
      const mode=change.mode??runtime.targetMode??2;
      const irMode=mode===0?runtime.lastIrMode:mode===1?'heat':mode===2?'cool':'auto';
      await runtime.sender.sendCode(runtime.hub,encodeTcl({power:mode!==0,mode:irMode,temperature:target,speed:'auto',swing:false,key:0}));
      runtime.target=target;runtime.targetMode=mode;runtime.lastIrMode=irMode;
    });
    runtime.queue=operation.catch(()=>{});
    try{await operation;}catch{
      this.log.warn('AC command failed; command was not retried.');
      throw this.failure();
    }finally{
      // Publish after HAP has committed the setter's requested value, including failures.
      if(!this.stopped){
        const handle=setImmediate(()=>{this.deferred.delete(handle);this.publish(runtime);});
        handle.unref();this.deferred.add(handle);
      }
    }
  }
  private publish(runtime:Runtime):void {
    const C=this.api.hap.Characteristic;
    const safely=(read:()=>number):number|Error=>{try{return read();}catch{return this.failure();}};
    runtime.thermostat.getCharacteristic(C.CurrentTemperature).updateValue(safely(()=>tenth(this.sample(runtime).temperature)));
    runtime.humidity.getCharacteristic(C.CurrentRelativeHumidity).updateValue(safely(()=>tenth(this.sample(runtime).humidity)));
    runtime.thermostat.updateCharacteristic(C.TargetTemperature,runtime.target);
    runtime.thermostat.getCharacteristic(C.TargetHeatingCoolingState).updateValue(safely(()=>this.commandedMode(runtime)));
    runtime.thermostat.getCharacteristic(C.CurrentHeatingCoolingState).updateValue(safely(()=>this.currentDemand(runtime)));
  }
}
