import {readFile} from 'node:fs/promises';
import {HomebridgePluginUiServer,RequestError} from '@homebridge/plugin-ui-utils';
import {SetupService,SetupError} from '../dist/setup.js';
class UiServer extends HomebridgePluginUiServer {
 constructor(){
  super();
  let busy=false;
  const service=new SetupService(this.homebridgeStoragePath,{
   getConfig:async()=>{const config=JSON.parse(await readFile(this.homebridgeConfigPath,'utf8'));return(config.platforms??[]).find(p=>p.platform==='BroadlinkCloud')??{};},
  });
  for(const [route,method] of [['/login','login'],['/discover','discover'],['/commands','commands'],['/save-session','saveSession']]){
   this.onRequest(route,async payload=>{if(busy)throw new RequestError('Another setup request is in progress.',{status:409});busy=true;try{return await service[method](payload);}catch(error){throw new RequestError(error instanceof SetupError?error.message:'Setup request failed. Check Homebridge storage and try again.',{status:400});}finally{busy=false;}});
  }
  this.ready();
 }
}
new UiServer();
