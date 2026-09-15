import {readFile,open,rename,unlink} from 'node:fs/promises';
import {isAbsolute,win32} from 'node:path';
import {randomUUID} from 'node:crypto';
import {encodeEmailLogin} from './auth.ts';
import type {CloudSession} from './client.ts';

const LOGIN_URL='https://app-service-deu-6dc239d5.ibroadlink.com/account/login';
const LICENSE='5eda600025ae5057181daaa2124f79b7';
export interface SessionManagerOptions {sessionFile:string;email?:string;password?:string;fetch?:typeof globalThis.fetch;timeoutMs?:number}
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&!/[\x00-\x1f\x7f]/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Reacquires a native session by password login; never retries a device command. */
export class SessionManager {
  #path:string;
  #email?:string;
  #password?:string;
  #fetch:typeof globalThis.fetch;
  #timeoutMs:number;
  #renewing?:Promise<CloudSession>;
  constructor(options:SessionManagerOptions) {
    if(!options||!text(options.sessionFile)||!(isAbsolute(options.sessionFile)||win32.isAbsolute(options.sessionFile)))throw new Error('sessionFile must be an absolute path');
    const email=typeof options.email==='string'&&options.email.trim()===''?undefined:options.email;
    const password=options.password===''?undefined:options.password;
    const hasEmail=email!==undefined;const hasPassword=password!==undefined;
    if(hasEmail!==hasPassword||(hasEmail&&(!text(email)||!email.includes('@')||typeof password!=='string'||!password.length)))throw new Error('Configure both a valid email and password, or neither');
    const timeoutMs=options.timeoutMs??10_000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw new Error('Invalid login timeout');
    this.#path=options.sessionFile;this.#email=email;this.#password=password;this.#fetch=options.fetch??globalThis.fetch;this.#timeoutMs=timeoutMs;
  }
  async getSession():Promise<CloudSession> {
    try {
      const session:unknown=JSON.parse(await readFile(this.#path,'utf8'));
      if(!record(session)||!text(session.userId)||!text(session.loginSession)||!text(session.familyId))throw new Error();
      return {userId:session.userId,loginSession:session.loginSession,familyId:session.familyId};
    }catch{throw new Error('Cannot read a valid session file; restore the protected bootstrap session file');}
  }
  renew():Promise<CloudSession> {
    if(!this.#renewing)this.#renewing=this.login().finally(()=>{this.#renewing=undefined;});
    return this.#renewing;
  }
  private async login():Promise<CloudSession> {
    if(this.#email===undefined||this.#password===undefined)throw new Error('Session expired; configure email and password in Homebridge settings or replace the protected session file');
    const previous=await this.getSession();
    const seconds=Math.floor(Date.now()/1000);
    const encoded=encodeEmailLogin(this.#email,this.#password,seconds);
    const controller=new AbortController();let timedOut=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error('timeout'));},this.#timeoutMs);});
    let result:unknown;
    try {
      const operation=async():Promise<unknown>=>{
        const response=await this.#fetch(LOGIN_URL,{
          method:'POST',redirect:'error',signal:controller.signal,
          headers:{...encoded.headers,email:this.#email!,lid:LICENSE,licenseId:LICENSE,'content-type':'application/x-java-serialized-object',system:'android',appPlatform:'android',language:'en-us',appVersion:'1.8.33.1a7fbc2ce',messageId:String(Date.now())},
          body:new Uint8Array(encoded.body),
        });
        if(!response.ok)throw new Error('HTTP failure');
        return await response.json();
      };
      result=await Promise.race([operation(),deadline]);
    }catch{throw new Error(timedOut?'BroadLink login timed out; existing session retained':'BroadLink login request failed; existing session retained');}
    finally{clearTimeout(timer);}
    if(!record(result)||result.error!==0||!text(result.userid)||!text(result.loginsession))throw new Error('BroadLink login failed; check email and password. Existing session retained');
    if(result.userid!==previous.userId)throw new Error('Login account differs from the bootstrap session; existing family and session retained');
    const updated:CloudSession={userId:result.userid,loginSession:result.loginsession,familyId:previous.familyId};
    // Do not overwrite an externally refreshed session that arrived during login.
    const current=await this.getSession();
    if(current.userId!==previous.userId||current.loginSession!==previous.loginSession||current.familyId!==previous.familyId)throw new Error('Session file changed during login; newer session retained');
    await this.persist(updated);
    return updated;
  }
  private async persist(session:CloudSession):Promise<void> {
    const temporary=`${this.#path}.${randomUUID()}.tmp`;
    let created=false;
    try {
      const handle=await open(temporary,'wx',0o600);created=true;
      try{await handle.writeFile(JSON.stringify(session)+'\n','utf8');await handle.sync();}finally{await handle.close();}
      await rename(temporary,this.#path);
    }catch{throw new Error('Could not securely save refreshed session; existing session file retained');}
    finally{if(created)await unlink(temporary).catch(()=>{});}
  }
}
