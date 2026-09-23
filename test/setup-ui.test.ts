import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const html=await readFile(new URL('../homebridge-ui/public/index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../homebridge-ui/public/app.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function fixture(initial:any=[{platform:'BroadlinkCloud',name:'Existing',fans:[{name:'Old Fan',remoteId:'old',hubId:'hub'}],airConditioners:[{name:'AC',remoteId:'ac',hubId:'hub'}],email:'old@example.test',password:'PRIVATE_PASSWORD'}]){
 const dom=new JSDOM(html,{url:'http://localhost/',runScripts:'outside-only'});let config=structuredClone(initial),saved=0;const requests:any[]=[];
 const hb={getPluginConfig:async()=>structuredClone(config),updatePluginConfig:async(c:any)=>{config=structuredClone(c)},savePluginConfig:async()=>{saved++},showSpinner(){},hideSpinner(){},fixScrollHeight(){},showSchemaForm(){},hideSchemaForm(){},addEventListener(){},request:async(path:string,body:any)=>{requests.push({path,body});if(path==='/login')return{families:[{id:'family',name:'My Home'}]};if(path==='/save-session')return{sessionFile:'/safe/session.json'};if(path==='/discover')return{devices:[{id:'hub',name:'RM MAX'},{id:'remote',hubId:'hub',name:'<img src=x onerror=alert(1)>'}]};if(path==='/commands')return{supportedAc:false,commands:['Stop','Slow','Fast','Light'].map(name=>({name,supported:true}))};throw Error('unexpected request');}};
 dom.window.homebridge=hb;dom.window.eval(app);await tick();const $=(id:string)=>dom.window.document.getElementById(id) as any;
 const click=async(id:string)=>{$(id).click();await tick()};const select=(id:string,value:string)=>{$(id).value=value;$(id).dispatchEvent(new dom.window.Event('change'));};
 const discover=async()=>{await click('existing');select('hub','hub');select('remote','remote');await click('load-remote')};return{dom,hb,$,click,select,discover,config:()=>config,saved:()=>saved,requests};
}
test('guided discovery safely displays names and adds fan mappings without losing existing configuration',async()=>{
 const f=await fixture();await f.discover();assert.equal(f.dom.window.document.querySelectorAll('img').length,0);
 f.select('kind','fan');f.$('device-name').value='New Fan';f.$('off-command').value='Stop';f.$('speeds').querySelector('select').value='Slow';await f.click('add-speed');f.$('speeds').querySelectorAll('select')[1].value='Fast';f.$('light-command').value='Light';await f.click('add');await f.click('save');
 const cfg=f.config()[0];assert.equal(cfg.fans.length,2);assert.deepEqual(cfg.fans[1].commands,{off:'Stop',speeds:['Slow','Fast'],lightToggle:'Light'});assert.equal(cfg.airConditioners[0].name,'AC');assert.equal(cfg.password,'PRIVATE_PASSWORD');assert.equal(f.saved(),1);assert.ok(!f.requests.some(r=>r.path.includes('control')));f.dom.window.close();
});
test('generic command mapping stays momentary and editing same command retains its id',async()=>{
 const f=await fixture();await f.discover();f.select('kind','button');f.$('device-name').value='Light toggle';f.$('button-command').value='Light';await f.click('add');const id=f.config()[0].buttons[0].id;
 f.$('device-name').value='New name';await f.click('add');assert.equal(f.config()[0].buttons.length,1);assert.equal(f.config()[0].buttons[0].id,id);assert.equal(f.config()[0].buttons[0].name,'New name');f.dom.window.close();
});
test('fresh account requires explicit save after family selection and preserves selected credentials',async()=>{
 const f=await fixture([]);f.$('email').value='new@example.test';f.$('password').value='NEW_PASSWORD';await f.click('login');await f.click('discover');assert.equal(f.saved(),0);await f.click('save');assert.equal(f.saved(),0);
 await f.click('save-account');assert.equal(f.saved(),1);assert.equal(f.config()[0].password,'NEW_PASSWORD');assert.equal(f.$('password').value,'');assert.equal(f.config()[0].sessionFile,'/safe/session.json');f.dom.window.close();
});

test('failed saved-account discovery cannot unblock mappings from an unsaved account',async()=>{
 const f=await fixture();f.$('email').value='new@example.test';f.$('password').value='new';await f.click('login');await f.click('discover');f.select('hub','hub');f.select('remote','remote');await f.click('load-remote');
 const request=f.hb.request;f.hb.request=async(path:string,body:any)=>{if(path==='/discover')throw Error('expired');return request(path,body)};
 await f.click('existing');assert.equal(f.$('remote-controls').hidden,true);assert.equal(f.$('mapping').hidden,true);await f.click('add');await f.click('save');assert.equal(f.config()[0].buttons,undefined);assert.equal(f.saved(),0);f.dom.window.close();
});

test('HTTP browser without randomUUID can add individual commands',async()=>{
 const f=await fixture();Object.defineProperty(f.dom.window.crypto,'randomUUID',{value:undefined});await f.discover();f.select('kind','button');f.$('button-command').value='Light';await f.click('add');assert.equal(f.config()[0].buttons.length,1);assert.ok(f.config()[0].buttons[0].id);f.dom.window.close();
});
test('whole remote is default and imports all commands once without randomUUID',async()=>{
 const f=await fixture();Object.defineProperty(f.dom.window.crypto,'randomUUID',{value:undefined});await f.discover();assert.equal(f.$('kind').value,'remote');await f.click('add');assert.equal(f.config()[0].buttons.length,4);const ids=f.config()[0].buttons.map(b=>b.id);await f.click('add');assert.deepEqual(f.config()[0].buttons.map(b=>b.id),ids);await f.click('save');assert.equal(f.saved(),1);f.dom.window.close();
});
test('whole bedroom fan remote imports speed control and every command',async()=>{
 const f=await fixture();const request=f.hb.request;f.hb.request=async(path,body)=>path==='/commands'?{supportedAc:false,commands:['on','wind_speed1','wind_speed2','wind_speed3','off'].map(name=>({name,supported:true}))}:request(path,body);
 await f.discover();await f.click('add');const cfg=f.config()[0];assert.equal(cfg.fans.length,2);assert.deepEqual(cfg.fans[1].commands,{off:'off',speeds:['wind_speed1','wind_speed2','wind_speed3']});assert.equal(cfg.buttons.length,5);assert.equal(cfg.airConditioners.length,1);assert.ok(!f.requests.some(r=>r.path.includes('control')));f.dom.window.close();
});
test('whole remote with no supported commands cannot be added',async()=>{
 const f=await fixture();const request=f.hb.request;f.hb.request=async(path,body)=>path==='/commands'?{supportedAc:false,commands:[]}:request(path,body);await f.discover();await f.click('add');assert.equal(f.config()[0].buttons,undefined);assert.equal(f.$('notice').dataset.error,'true');f.dom.window.close();
});
