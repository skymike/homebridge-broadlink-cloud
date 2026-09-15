import test from 'node:test';
import assert from 'node:assert/strict';
import {SetupService} from '../src/setup.ts';
const session={userId:'USER_SECRET',loginSession:'SESSION_SECRET',familyId:'family'};
const endpoints=[{endpointId:'hub',friendlyName:'RM MAX',cookie:'COOKIE_SECRET',devSession:'KEY_SECRET'},{endpointId:'remote',friendlyName:'Fan',gatewayId:'hub',cookie:'PRIVATE'}];
function fixture(overrides:any={}){
 let saves=0;const deps:any={getConfig:async()=>({platform:'BroadlinkCloud',sessionFile:'/safe/existing.json'}),readSession:async()=>session,loginAccount:async()=>session,listFamilies:async()=>[{id:'family',name:'Home'}],saveSession:async()=>{saves++;},createClient:()=>({listDevices:async()=>endpoints,getRemote:async()=>({endpointId:'remote',description:{},irData:[{name:'High',codeList:[{code:'aa'}]},{name:'Sequence',codeList:[{code:'aa'},{code:'bb'}]}]})})};
 Object.assign(deps,overrides);return{service:new SetupService('/safe',deps),deps,saves:()=>saves};
}
test('saved account discovery and commands expose metadata only',async()=>{
 const f=fixture();const d=await f.service.discover({});assert.equal(d.devices.length,2);
 assert.ok(!JSON.stringify(d).includes('SECRET'));assert.ok(!JSON.stringify(d).includes('cookie'));
 const commands=await f.service.commands({remoteId:'remote'});assert.deepEqual(commands.commands,[{name:'High',supported:true},{name:'Sequence',supported:false}]);assert.ok(!JSON.stringify(commands).includes('aa'));
 await assert.rejects(f.service.commands({remoteId:'unseen'}));assert.equal(f.saves(),0);
});
test('login and selected family discovery do not persist until explicit commit',async()=>{
 const f=fixture();assert.deepEqual(await f.service.login({email:'a@b.test',password:'PASSWORD_SECRET'}),{families:[{id:'family',name:'Home'}]});
 await assert.rejects(f.service.discover({familyId:'unknown'}));await f.service.discover({familyId:'family'});assert.equal(f.saves(),0);
 assert.deepEqual(await f.service.saveSession({familyId:'family'}),{sessionFile:'/safe/existing.json'});assert.equal(f.saves(),1);
});
test('discovery failures and login failures never expose upstream secret payloads',async()=>{
 const f=fixture({loginAccount:async()=>{throw Error('PASSWORD_SECRET')}});await assert.rejects(f.service.login({email:'a@b.test',password:'x'}),e=>!String(e).includes('SECRET'));
 const broken=fixture({createClient:()=>({listDevices:async()=>{throw Error('COOKIE_SECRET')}})});await assert.rejects(broken.service.discover({}),e=>!String(e).includes('SECRET'));
});
test('new account cannot replace active configured account during setup',async()=>{
 const f=fixture({getConfig:async()=>({fans:[{remoteId:'old'}]}),loginAccount:async()=>({userId:'other',loginSession:'new'})});
 await f.service.login({email:'a@b.test',password:'x'});await f.service.discover({familyId:'family'});await assert.rejects(f.service.saveSession({familyId:'family'}));assert.equal(f.saves(),0);
});
