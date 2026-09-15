import {open,rename,unlink} from 'node:fs/promises';
import {isAbsolute,win32} from 'node:path';
import {randomUUID} from 'node:crypto';
import {encodeEmailLogin} from './auth.ts';
import type {CloudSession} from './client.ts';

export interface AccountSession {userId:string;loginSession:string}
export interface FamilyOption {id:string;name:string}
export interface AccountOptions {fetch?:typeof globalThis.fetch;timeoutMs?:number}
const HOST='https://app-service-deu-6dc239d5.ibroadlink.com';
const LICENSE='5eda600025ae5057181daaa2124f79b7';
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&!/[\x00-\x1f\x7f]/.test(v);
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);

async function request(path:string,init:RequestInit,options:AccountOptions,label:string):Promise<unknown> {
  const timeout=options.timeoutMs??10_000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>60_000)throw new Error('Invalid request timeout');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error());},timeout);});
  try {
    return await Promise.race([(async()=>{
      const response=await (options.fetch??globalThis.fetch)(HOST+path,{...init,method:'POST',redirect:'error',signal:controller.signal});
      if(!response.ok)throw new Error();
      return await response.json();
    })(),deadline]);
  }catch{throw new Error(controller.signal.aborted?`BroadLink ${label} timed out; existing session retained`:`BroadLink ${label} request failed; existing session retained`);}
  finally{clearTimeout(timer);}
}

/** Signs in only in memory. The caller explicitly selects a family before saving. */
export async function loginAccount(email:string,password:string,options:AccountOptions={}):Promise<AccountSession> {
  if(!text(email)||!email.includes('@')||typeof password!=='string'||password.length===0)throw new Error('Enter a valid email and password');
  const encoded=encodeEmailLogin(email,password,Math.floor(Date.now()/1000));
  const result=await request('/account/login',{
    headers:{...encoded.headers,email,lid:LICENSE,licenseId:LICENSE,'content-type':'application/x-java-serialized-object',system:'android',appPlatform:'android',language:'en-us',appVersion:'1.8.33.1a7fbc2ce',messageId:String(Date.now())},
    body:new Uint8Array(encoded.body),
  },options,'login');
  if(!record(result)||result.error!==0||!text(result.userid)||!text(result.loginsession))throw new Error('BroadLink login failed; check email and password. Existing session retained');
  return {userId:result.userid,loginSession:result.loginsession};
}

/** APK FamilyService.familyList: POST with an empty body and account headers. */
export async function listFamilies(account:AccountSession,options:AccountOptions={}):Promise<FamilyOption[]> {
  if(!account||!text(account.userId)||!text(account.loginSession))throw new Error('Invalid account session');
  const result=await request('/appsync/group/member/getfamilylist',{
    headers:{userid:account.userId,loginsession:account.loginSession,licenseid:LICENSE,language:'en-us',appVersion:'1.8.33.1a7fbc2ce',timestamp:String(Math.floor(Date.now()/1000)),messageId:String(Date.now())},
    body:new Uint8Array(0),
  },options,'family discovery');
  if(!record(result)||result.status!==0||!record(result.data)||!Array.isArray(result.data.familyList))throw new Error('Invalid BroadLink family response');
  const seen=new Set<string>();
  return result.data.familyList.map((family:unknown)=>{
    if(!record(family))throw new Error('Invalid BroadLink family response');
    // Live EU responses use familyid; the APK model names it familyId.
    const id=family.familyid??family.familyId;
    if(!text(id)||!text(family.name)||(family.familyid!==undefined&&family.familyId!==undefined&&family.familyid!==family.familyId)||seen.has(id))throw new Error('Invalid BroadLink family response');
    seen.add(id);return {id,name:family.name};
  });
}

/** Explicit final save only. Atomically replaces the session with a mode-0600 file. */
export async function saveBootstrapSession(path:string,session:CloudSession):Promise<void> {
  if(!text(path)||!(isAbsolute(path)||win32.isAbsolute(path)))throw new Error('sessionFile must be an absolute path');
  if(!session||!text(session.userId)||!text(session.loginSession)||!text(session.familyId))throw new Error('Invalid cloud session');
  const temporary=`${path}.${randomUUID()}.tmp`;let created=false;
  try {
    const handle=await open(temporary,'wx',0o600);created=true;
    try{await handle.writeFile(JSON.stringify({userId:session.userId,loginSession:session.loginSession,familyId:session.familyId})+'\n','utf8');await handle.sync();}finally{await handle.close();}
    await rename(temporary,path);
  }catch{throw new Error('Could not securely save session; existing session file retained');}
  finally{if(created)await unlink(temporary).catch(()=>{});}
}
