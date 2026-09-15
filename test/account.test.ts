import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loginAccount,listFamilies,saveBootstrapSession} from '../src/account.ts';
const account={userId:'fixture-user',loginSession:'fixture-token'};
const mock=(payload:unknown)=>async()=>({ok:true,json:async()=>payload}) as Response;

test('login returns only account credentials; family list uses APK empty POST and returns only id/name',async()=>{
 assert.deepEqual(await loginAccount('fixture@example.invalid','password',{fetch:mock({error:0,userid:account.userId,loginsession:account.loginSession,private:'PRIVATE'})}),account);
 const families=await listFamilies(account,{fetch:async(url,init)=>{
  assert.equal(url,'https://app-service-deu-6dc239d5.ibroadlink.com/appsync/group/member/getfamilylist');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
  assert.equal((init?.body as Uint8Array).byteLength,0);const h=new Headers(init?.headers);assert.equal(h.get('userid'),account.userId);assert.equal(h.get('loginsession'),account.loginSession);assert.equal(h.get('licenseid'),'5eda600025ae5057181daaa2124f79b7');assert.equal(h.get('familyid'),null);
  return {ok:true,json:async()=>({status:0,data:{familyList:[{familyId:'home',name:'Home',master:'PRIVATE',extend:'PRIVATE'}]}})} as Response;
 }});assert.deepEqual(families,[{id:'home',name:'Home'}]);
 assert.deepEqual(await listFamilies(account,{fetch:mock({status:0,data:{familyList:[]}})}),[]);
});

test('malformed login/family payloads and transport errors never expose private server text',async()=>{
 for(const payload of [null,{error:'0',userid:'u',loginsession:'s'},{error:0,userid:'u\n',loginsession:'s'},{error:1,msg:'PRIVATE'}])await assert.rejects(loginAccount('a@b','p',{fetch:mock(payload)}),e=>e instanceof Error&&!e.message.includes('PRIVATE'));
 for(const payload of [null,{status:'0',data:{familyList:[]}},{status:0,data:{familyList:[{familyId:'x',name:' '}] }},{status:0,data:{familyList:[{familyId:'x',name:'One'},{familyId:'x',name:'Two'}] }},{status:1,msg:'PRIVATE'}])await assert.rejects(listFamilies(account,{fetch:mock(payload)}),e=>e instanceof Error&&!e.message.includes('PRIVATE'));
 for(const operation of [loginAccount.bind(null,'a@b','p'),listFamilies.bind(null,account)]){
  await assert.rejects(operation({fetch:async()=>{throw Error('PRIVATE');}}),e=>e instanceof Error&&!e.message.includes('PRIVATE'));
  await assert.rejects(operation({fetch:async()=>({ok:true,json:async()=>{throw Error('PRIVATE');}}) as unknown as Response}),e=>e instanceof Error&&!e.message.includes('PRIVATE'));
 }
});

test('live EU familyid wire spelling is sanitized; conflicting aliases and duplicate IDs reject',async()=>{
 const family={familyid:'fixture-home',userid:'fixture-owner',name:'Fixture Home',icon:'fixture-icon',extend:'PRIVATE'};
 assert.deepEqual(await listFamilies(account,{fetch:mock({status:0,data:{familyList:[family]}})}),[{id:'fixture-home',name:'Fixture Home'}]);
 assert.deepEqual(await listFamilies(account,{fetch:mock({status:0,data:{familyList:[{...family,familyId:'fixture-home'}]}})}),[{id:'fixture-home',name:'Fixture Home'}]);
 for(const familyList of [[{...family,familyId:'other'}],[family,{familyId:'fixture-home',name:'Duplicate'}],[{...family,familyid:''}]])await assert.rejects(listFamilies(account,{fetch:mock({status:0,data:{familyList}})}),/Invalid BroadLink family response/);
});

test('both account operations time out across fetch and full response body',async()=>{
 for(const operation of [loginAccount.bind(null,'a@b','p'),listFamilies.bind(null,account)])for(const body of [false,true]){
  let signal:AbortSignal|undefined;
  await assert.rejects(operation({timeoutMs:10,fetch:async(_url,init)=>{signal=init?.signal??undefined;if(!body)return new Promise(()=>{});return{ok:true,json:()=>new Promise(()=>{})} as Response;}}),/timed out/);assert.equal(signal?.aborted,true);
 }
});

test('only explicit save replaces a session; writer validates, atomically replaces and removes temporary files',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'broadlink-account-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'session.json');await writeFile(path,'existing');
 const signedIn=await loginAccount('a@b','p',{fetch:mock({error:0,userid:account.userId,loginsession:account.loginSession})});
 await listFamilies(signedIn,{fetch:mock({status:0,data:{familyList:[]}})});assert.equal(await readFile(path,'utf8'),'existing');
 await assert.rejects(saveBootstrapSession(path,{...account,familyId:''}));assert.equal(await readFile(path,'utf8'),'existing');
 await saveBootstrapSession(path,{...account,familyId:'chosen'});assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{...account,familyId:'chosen'});assert.deepEqual(await readdir(dir),['session.json']);if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
 await assert.rejects(saveBootstrapSession('relative.json',{...account,familyId:'chosen'}),/absolute/);
 const blocked=join(dir,'directory');await mkdir(blocked);await assert.rejects(saveBootstrapSession(blocked,{...account,familyId:'chosen'}),/securely save/);assert.deepEqual((await readdir(dir)).sort(),['directory','session.json']);
});
