import {join} from 'node:path';
import {loginAccount,listFamilies,saveBootstrapSession,type AccountSession,type FamilyOption} from './account.ts';
import {BroadlinkCloudClient,type CloudSession,type Endpoint,type Remote} from './client.ts';
import {SessionManager} from './session.ts';
import {TCL_PROFILE_ID} from './tcl.ts';
interface SetupDeps {
 getConfig():Promise<Record<string,any>>;
 readSession(path:string,config:Record<string,any>):Promise<CloudSession>;
 loginAccount:typeof loginAccount;listFamilies:typeof listFamilies;saveSession:typeof saveBootstrapSession;
 createClient(session:CloudSession):{listDevices():Promise<Endpoint[]>;getRemote(id:string):Promise<Remote>};
}
const string=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export class SetupError extends Error {}
/** Per-settings-window controller. Only whitelisted metadata crosses the UI boundary. */
export class SetupService {
 private storage:string;private deps:SetupDeps;
 private pending?:{account:AccountSession;families:FamilyOption[];expires:number};
 private selected?:CloudSession;private devices:Endpoint[]=[];private lastLogin=0;
 constructor(storage:string,deps:Partial<SetupDeps>&Pick<SetupDeps,'getConfig'>){
  this.storage=storage;
  this.deps={readSession:(path,config)=>new SessionManager({sessionFile:path,email:config.email,password:config.password}).getSession(),loginAccount,listFamilies,saveSession:saveBootstrapSession,createClient:s=>new BroadlinkCloudClient(s),...deps};
 }
 private path(config:Record<string,any>):string{return typeof config.sessionFile==='string'&&config.sessionFile?config.sessionFile:join(this.storage,'broadlink-session.json');}
 private clearDiscovery(){this.selected=undefined;this.devices=[];}
 async login(payload:unknown){
  this.pending=undefined;this.clearDiscovery();
  if(!object(payload)||!string(payload.email)||!payload.email.includes('@')||typeof payload.password!=='string'||!payload.password||payload.password.length>4096)throw new SetupError('Enter your BroadLink email and password.');
  if(Date.now()-this.lastLogin<5000)throw new SetupError('Wait a few seconds before trying to sign in again.');
  this.lastLogin=Date.now();
  try{
   const account=await this.deps.loginAccount(payload.email.trim(),payload.password);
   const families=await this.deps.listFamilies(account);
   if(!families.length)throw new SetupError('No homes');
   this.pending={account,families,expires:Date.now()+10*60_000};return{families};
  }catch{throw new SetupError('Could not sign in or list homes. Check your credentials and EU account region.');}
 }
 private pendingSession(familyId:unknown):CloudSession{
  if(!string(familyId)||!this.pending||this.pending.expires<Date.now()||!this.pending.families.some(f=>f.id===familyId))throw new SetupError('Sign in and select one of your listed homes.');
  return{...this.pending.account,familyId};
 }
 async discover(payload:unknown){
  this.clearDiscovery();
  try{
   const familyId=object(payload)?payload.familyId:undefined;
   const config=await this.deps.getConfig();
   const session=familyId!==undefined?this.pendingSession(familyId):await this.deps.readSession(this.path(config),config);
   const devices=await this.deps.createClient(session).listDevices();
   this.selected=session;this.devices=devices;
   const ids=new Set(devices.map(d=>d.endpointId));
   return{devices:devices.map(d=>({id:d.endpointId,name:typeof d.friendlyName==='string'?d.friendlyName.slice(0,160):'Unnamed device',...(typeof d.gatewayId==='string'&&ids.has(d.gatewayId)?{hubId:d.gatewayId}:{})}))};
  }catch{this.clearDiscovery();throw new SetupError('Discovery failed. Sign in again, select your home, and check the EU account region.');}
 }
 async commands(payload:unknown){
  if(!object(payload)||!string(payload.remoteId)||!this.selected||!this.devices.some(d=>d.endpointId===payload.remoteId))throw new SetupError('Discover devices and select a listed remote first.');
  try{
   const remote=await this.deps.createClient(this.selected).getRemote(payload.remoteId);
   const counts=new Map<string,number>();for(const c of remote.irData)if(string(c.name))counts.set(c.name,(counts.get(c.name)??0)+1);
   const commands=Array.from(counts,([name,count])=>{const c=remote.irData.find(c=>c.name===name)!;return{name,supported:count===1&&c.codeList.length===1&&typeof c.codeList[0].code==='string'&&/^(?:[0-9a-f]{2})+$/i.test(c.codeList[0].code)};});
   let supportedAc=false;try{const url=new URL(String(remote.description.codeUrl));supportedAc=url.searchParams.getAll('ircodeid').length===1&&url.searchParams.get('ircodeid')===TCL_PROFILE_ID;}catch{}
   const productId=this.devices.find(d=>d.endpointId===payload.remoteId)?.productId;
   const category=productId==='000000000000000000000000ba090100'?'fan':productId==='000000000000000000000000e35a0100'?'projector':productId==='000000000000000000000000c2050100'?'ac':undefined;
   return{commands,supportedAc,...(category?{category}:{})};
  }catch{throw new SetupError('Could not read this remote. It may not expose learned commands through this cloud API.');}
 }
 async saveSession(payload:unknown){
  const session=this.pendingSession(object(payload)?payload.familyId:undefined);
  if(!this.selected||JSON.stringify(session)!==JSON.stringify(this.selected))throw new SetupError('Discover the selected home before saving it.');
  const config=await this.deps.getConfig();const path=this.path(config);
  const hasDevices=['fans','buttons','airConditioners','acPresets','devices'].some(key=>Array.isArray(config[key])&&config[key].length);
  if(hasDevices){
   let old:CloudSession;try{old=await this.deps.readSession(path,config);}catch{throw new SetupError('Existing devices require their original account session. Restore it before changing accounts.');}
   if(old.userId!==session.userId||old.familyId!==session.familyId)throw new SetupError('This configuration already contains devices from another account or home. Use a separate Homebridge instance or remove those mappings first.');
  }
  try{await this.deps.saveSession(path,session);}catch{throw new SetupError('Could not securely save the session. Existing configuration was retained.');}
  return{sessionFile:path};
 }
}
