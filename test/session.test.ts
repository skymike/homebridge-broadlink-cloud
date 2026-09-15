import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '../src/session.ts';
import {encodeEmailLogin} from '../src/auth.ts';
const original={userId:'fixture-user',loginSession:'fixture-old',familyId:'fixture-family'};
async function fixture(t:any,fetch:any=async()=>({ok:true,json:async()=>({error:0,userid:'fixture-user',loginsession:'fixture-new'})}),extra:any={}) {
 const dir=await mkdtemp(join(tmpdir(),'broadlink-session-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'session.json');await writeFile(path,JSON.stringify(original),{mode:0o600});
 const manager=new SessionManager({sessionFile:path,email:'fixture@example.invalid',password:'fixture-password',fetch,...extra});return {dir,path,manager};
}
test('encrypted login exact protocol, same-user family preservation and protected atomic session file',async t=>{
 let seen=false;const f=await fixture(t,async(url:any,init:any)=>{
  assert.equal(url,'https://app-service-deu-6dc239d5.ibroadlink.com/account/login');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const headers=new Headers(init.headers);assert.equal(headers.get('content-type'),'application/x-java-serialized-object');assert.equal(headers.get('email'),'fixture@example.invalid');assert.equal(headers.get('lid'),'5eda600025ae5057181daaa2124f79b7');assert.equal(headers.get('licenseid'),headers.get('lid'));
  const encoded=encodeEmailLogin('fixture@example.invalid','fixture-password',Number(headers.get('timestamp')));assert.equal(headers.get('token'),encoded.headers.token);assert.deepEqual(Buffer.from(init.body),encoded.body);seen=true;
  return{ok:true,json:async()=>({error:0,userid:'fixture-user',loginsession:'fixture-new'})};
 });
 assert.deepEqual(await f.manager.getSession(),original);assert.deepEqual(await f.manager.renew(),{...original,loginSession:'fixture-new'});assert.ok(seen);assert.deepEqual(JSON.parse(await readFile(f.path,'utf8')),{...original,loginSession:'fixture-new'});assert.deepEqual(await readdir(f.dir),['session.json']);if(process.platform!=='win32')assert.equal((await stat(f.path)).mode&0o777,0o600);
});
test('getSession always rereads external updates; no credentials needed for valid current session',async t=>{
 const f=await fixture(t,undefined,{email:undefined,password:undefined});assert.deepEqual(await f.manager.getSession(),original);await writeFile(f.path,JSON.stringify({...original,loginSession:'external'}));assert.equal((await f.manager.getSession()).loginSession,'external');await assert.rejects(f.manager.renew(),/email and password/);
});
test('login errors, malformed results and changed user never overwrite valid old session',async t=>{
 for(const result of [{error:-1006,msg:'PRIVATE'}, {userid:'fixture-user',loginsession:'x'},{error:'0',userid:'fixture-user',loginsession:'x'},{error:0,userid:'different-user',loginsession:'x'},{error:0,userid:'fixture-user',loginsession:''},null]){
  const f=await fixture(t,async()=>({ok:true,json:async()=>result}));await assert.rejects(f.manager.renew(),e=>e instanceof Error&&!e.message.includes('PRIVATE'));assert.deepEqual(JSON.parse(await readFile(f.path,'utf8')),original);assert.deepEqual(await readdir(f.dir),['session.json']);
 }
});
test('failed transport and invalid JSON are sanitized and preserve old file',async t=>{
 for(const fetch of [async()=>{throw Error('PRIVATE PASSWORD');},async()=>({ok:false,json:async()=>({})}),async()=>({ok:true,json:async()=>{throw Error('PRIVATE BODY');}})]){
  const f=await fixture(t,fetch);await assert.rejects(f.manager.renew(),e=>e instanceof Error&&!e.message.includes('PRIVATE'));assert.deepEqual(await f.manager.getSession(),original);
 }
});
test('deadline covers fetch and response body and aborts requests',async t=>{
 for(const body of [false,true]){
  let signal:AbortSignal|undefined;const f=await fixture(t,async(_u:any,options:any)=>{signal=options.signal;if(!body)return new Promise(()=>{});return{ok:true,json:()=>new Promise(()=>{})};},{timeoutMs:20});
  await assert.rejects(f.manager.renew(),/timed out/);assert.equal(signal?.aborted,true);assert.deepEqual(await f.manager.getSession(),original);
 }
});
test('concurrent renewals share a single request and clear singleflight after completion',async t=>{
 let calls=0;let release!:()=>void;const f=await fixture(t,async()=>{calls++;await new Promise<void>(r=>{release=r;});return{ok:true,json:async()=>({error:0,userid:'fixture-user',loginsession:'next'})};});
 const pending=[f.manager.renew(),f.manager.renew(),f.manager.renew()];while(!release)await new Promise(setImmediate);assert.equal(calls,1);release();const sessions=await Promise.all(pending);assert.deepEqual(sessions[0],sessions[1]);
 const again=f.manager.renew();while(calls<2)await new Promise(setImmediate);release();await again;assert.equal(calls,2);assert.deepEqual(await readdir(f.dir),['session.json']);
});
test('configuration rejects partial credentials and malformed timeout/path',()=>{
 for(const options of [{sessionFile:'relative.json'},{sessionFile:'/fixture',email:'fixture@example.invalid'},{sessionFile:'/fixture',password:'password'},{sessionFile:'/fixture',email:'',password:'p'},{sessionFile:'/fixture',timeoutMs:0},{sessionFile:'/fixture',timeoutMs:Infinity}])assert.throws(()=>new SessionManager(options));
});
test('missing or malformed bootstrap session fails without any login',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return{};});for(const value of [{},null,{...original,familyId:' '},{...original,userId:'u\n'}]){
 await writeFile(f.path,JSON.stringify(value));await assert.rejects(f.manager.getSession());await assert.rejects(f.manager.renew());}await rm(f.path);await assert.rejects(f.manager.getSession(),/session file/i);await assert.rejects(f.manager.renew());assert.equal(calls,0);
});

test('external session change during login is preserved',async t=>{
 let release!:()=>void;const f=await fixture(t,async()=>{await new Promise<void>(r=>{release=r;});return{ok:true,json:async()=>({error:0,userid:'fixture-user',loginsession:'from-login'})};});
 const pending=f.manager.renew();while(!release)await new Promise(setImmediate);await writeFile(f.path,JSON.stringify({...original,loginSession:'external-latest'}));release();await assert.rejects(pending,/changed during login/);assert.equal((await f.manager.getSession()).loginSession,'external-latest');assert.deepEqual(await readdir(f.dir),['session.json']);
});

test('blank optional Homebridge UI credentials use existing session',async t=>{
 for(const credentials of [{email:'',password:''},{email:'   ',password:''},{email:undefined,password:''},{email:'',password:undefined}]) {
  const f=await fixture(t,async()=>{assert.fail('blank optional credentials must not login');},credentials);
  assert.deepEqual(await f.manager.getSession(),original);await assert.rejects(f.manager.renew(),/email and password/);
 }
});
test('nonempty passwords are preserved verbatim and partial credential pairs reject',async t=>{
 const f=await fixture(t,async(_url:any,init:any)=>{
  const headers=new Headers(init.headers);const expected=encodeEmailLogin('fixture@example.invalid','   ',Number(headers.get('timestamp')));assert.deepEqual(Buffer.from(init.body),expected.body);
  return{ok:true,json:async()=>({error:0,userid:'fixture-user',loginsession:'new'})};
 },{password:'   '});await f.manager.renew();
 for(const credentials of [{email:'',password:'p'},{email:'   ',password:'   '},{email:'fixture@example.invalid',password:''}])assert.throws(()=>new SessionManager({sessionFile:f.path,...credentials}));
});
