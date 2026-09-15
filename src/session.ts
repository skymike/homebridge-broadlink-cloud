import {readFile} from 'node:fs/promises';
import {isAbsolute,win32} from 'node:path';

import {loginAccount,saveBootstrapSession} from './account.ts';
import type {CloudSession} from './client.ts';

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
    const result=await loginAccount(this.#email,this.#password,{fetch:this.#fetch,timeoutMs:this.#timeoutMs});
    if(result.userId!==previous.userId)throw new Error('Login account differs from the bootstrap session; existing family and session retained');
    const updated:CloudSession={userId:result.userId,loginSession:result.loginSession,familyId:previous.familyId};
    // Do not overwrite an externally refreshed session that arrived during login.
    const current=await this.getSession();
    if(current.userId!==previous.userId||current.loginSession!==previous.loginSession||current.familyId!==previous.familyId)throw new Error('Session file changed during login; newer session retained');
    await saveBootstrapSession(this.#path,updated);
    return updated;
  }
}
