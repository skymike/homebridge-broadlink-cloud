/* Remote names are untrusted text. Never render account data with innerHTML. */
(async()=>{
 const hb=window.homebridge,$=id=>document.getElementById(id);
 let blocks=await hb.getPluginConfig();if(!blocks.length)blocks=[{platform:'BroadlinkCloud',name:'BroadLink Cloud'}];
 let cfg=blocks[0],devices=[],commands=[],pendingAccount=false,loadedRemote='',busy=false,pendingCredentials;
 const tell=(text,error=false)=>{$('notice').textContent=text;$('notice').dataset.error=String(error);};
 const option=(value,label)=>{const o=document.createElement('option');o.value=value;o.textContent=label;return o;};
 const fill=(select,values,blank)=>{select.replaceChildren();if(blank)select.append(option('',blank));for(const v of values)select.append(option(v.id??v.name,v.name));};
 const work=fn=>async()=>{if(busy)return;busy=true;hb.showSpinner();try{await fn();}catch(e){tell(e.message||'The request failed. Please try again.',true);}finally{busy=false;hb.hideSpinner();hb.fixScrollHeight?.();}};
 const buttonId=(remoteId,command)=>'remote:'+encodeURIComponent(JSON.stringify([remoteId,command]));
 const upsertButton=(name,remoteId,hubId,command)=>{cfg.buttons??=[];const i=cfg.buttons.findIndex(b=>b.remoteId===remoteId&&b.command===command);const item={id:i<0?buttonId(remoteId,command):cfg.buttons[i].id,name,remoteId,hubId,command};if(i<0)cfg.buttons.push(item);else cfg.buttons[i]={...cfg.buttons[i],...item};};
 const inferredFan=()=>{
  const off=commands.find(c=>/^(fanoff|off)$/i.test(c.name))?.name;
  const speeds=commands.filter(c=>/^(?:wind_speed)?[1-9]\d*$/.test(c.name)).sort((a,b)=>Number(a.name.replace('wind_speed',''))-Number(b.name.replace('wind_speed',''))).map(c=>c.name);
  const levels=speeds.map(n=>Number(n.replace('wind_speed','')));
  if(!off||!speeds.length||levels.some((n,i)=>n!==i+1))return;
  const lightToggle=commands.find(c=>/^lighton\/off$/i.test(c.name))?.name;
  return {off,speeds,...(lightToggle?{lightToggle}:{})};
 };
 const update=async()=>{blocks[0]=cfg;await hb.updatePluginConfig(blocks);};
 const configured=()=>{
  $('configured').replaceChildren();let count=0;
  for(const [key,label] of [['fans','Fan'],['buttons','Button'],['airConditioners','AC'],['acPresets','AC preset']])for(const [index,item]of(cfg[key]??[]).entries()){
   count++;const row=document.createElement('div');row.className='mapping-row';const text=document.createElement('span');text.textContent=label+': '+(item.name||item.remoteId||item.id);const remove=document.createElement('button');remove.className='btn btn-sm btn-outline-danger';remove.textContent='Remove';remove.onclick=work(async()=>{cfg[key].splice(index,1);await update();configured();tell('Mapping removed from the draft. Save to apply.');});row.append(text,remove);$('configured').append(row);
  }
  if(!count)$('configured').textContent='No devices configured yet.';
 };
 const invalidate=()=>{loadedRemote='';$('remote-controls').hidden=true;};
 const showRemotes=()=>{invalidate();fill($('remote'),devices.filter(d=>d.hubId===$('hub').value),'Choose a remote');};
 const showDevices=result=>{
  devices=result.devices;invalidate();$('mapping').hidden=false;
  const hubIds=new Set(devices.map(d=>d.hubId).filter(Boolean));fill($('hub'),devices.filter(d=>hubIds.has(d.id)),'Choose an RM hub');showRemotes();
  if(!hubIds.size)tell('No remotes linked to a hub were found. Add your RM hub and remotes in BroadLink first.',true);
  else tell('Discovery complete. Choose a hub and remote.');
 };
 $('existing').onclick=work(async()=>{invalidate();$('mapping').hidden=true;const result=await hb.request('/discover',{});pendingAccount=false;pendingCredentials=undefined;$('family-section').hidden=true;showDevices(result);});
 $('email').value=cfg.email??'';
 $('login').onclick=work(async()=>{invalidate();$('mapping').hidden=true;const credentials={email:$('email').value.trim(),password:$('password').value};const result=await hb.request('/login',credentials);pendingCredentials=credentials;pendingAccount=true;fill($('family'),result.families);$('family-section').hidden=false;tell('Choose your BroadLink home, discover it, then save the selected account.');});
 $('family').onchange=()=>{invalidate();$('mapping').hidden=true;pendingAccount=true;};
 $('discover').onclick=work(async()=>{invalidate();$('mapping').hidden=true;showDevices(await hb.request('/discover',{familyId:$('family').value}));});
 $('save-account').onclick=work(async()=>{
  if(!pendingCredentials)throw Error('Sign in before saving an account.');const result=await hb.request('/save-session',{familyId:$('family').value});cfg={...cfg,sessionFile:result.sessionFile,...pendingCredentials};await update();await hb.savePluginConfig();pendingAccount=false;pendingCredentials=undefined;$('password').value='';$('family-section').hidden=true;tell('Account saved. You can now configure devices.');
 });
 $('hub').onchange=showRemotes;$('remote').onchange=invalidate;
 const addSpeed=selected=>{const row=document.createElement('div');row.className='speed-row';const select=document.createElement('select');select.className='form-select';select.setAttribute('aria-label','Fan speed command');fill(select,commands,'Choose speed command');if(selected)select.value=selected;const remove=document.createElement('button');remove.className='btn btn-sm btn-outline-secondary';remove.textContent='Remove';remove.onclick=()=>row.remove();row.append(select,remove);$('speeds').append(row);};
 $('add-speed').onclick=()=>addSpeed();
 const showKind=()=>{for(const type of ['remote','fan','button','ac'])$(type+'-fields').hidden=$('kind').value!==type;};$('kind').onchange=showKind;
 $('load-remote').onclick=work(async()=>{
  const remoteId=$('remote').value;if(!remoteId)throw Error('Choose a remote first.');
  const result=await hb.request('/commands',{remoteId});loadedRemote=remoteId;commands=result.commands.filter(c=>c.supported);
  $('ac-option').disabled=!result.supportedAc;const existing=(cfg.fans??[]).find(f=>f.remoteId===remoteId);
  $('device-name').value=existing?.name??devices.find(d=>d.id===remoteId)?.name??'BroadLink Remote';
  fill($('off-command'),commands,'Choose Off command');fill($('light-command'),commands,'No light control');fill($('button-command'),commands,'Choose command');$('speeds').replaceChildren();
  const names=new Set(commands.map(c=>c.name));const automaticOff=commands.find(c=>c.name.toLowerCase()==='fanoff')?.name;
  $('off-command').value=existing?.commands?.off??automaticOff??'';$('light-command').value=existing?.commands?.lightToggle??(existing?.exposeLightToggle?commands.find(c=>c.name.toLowerCase()==='lighton/off')?.name:'')??'';
  const speeds=existing?.commands?.speeds??commands.filter(c=>/^[1-9]\d*$/.test(c.name)).sort((a,b)=>Number(a.name)-Number(b.name)).map(c=>c.name);for(const speed of speeds)addSpeed(speed);if(!speeds.length)addSpeed();
  $('kind').value=result.supportedAc?'ac':'remote';showKind();$('remote-controls').hidden=false;
  $('remote-fields').textContent=`Imports all ${commands.length} supported commands as named momentary controls${inferredFan()?' and adds fan power/speed controls':''}. Existing mappings are retained. Review the detected commands before saving: ${commands.map(c=>c.name).join(', ')}.`;
  $('command-note').textContent=result.supportedAc?'Verified TCL profile available.':commands.length?`${commands.length} single-code commands available. Unsupported sequences and duplicate names cannot be mapped.`:'No usable learned commands found. This remote may require a device-specific profile.';
 });
 $('add').onclick=work(async()=>{
  if(pendingAccount)throw Error('Save the selected account before adding mappings.');
  if(!loadedRemote||loadedRemote!==$('remote').value)throw Error('Load the selected remote first.');
  const name=$('device-name').value.trim();if(!name)throw Error('Enter an Apple Home name.');
  const remoteId=loadedRemote,hubId=$('hub').value;const valid=new Set(commands.map(c=>c.name));const kind=$('kind').value;
  if(kind==='remote'){
   if(!commands.length)throw Error('This remote has no supported commands to import.');
   const inferred=inferredFan();cfg.fans??=[];
   if(inferred&&!cfg.fans.some(f=>f.remoteId===remoteId))cfg.fans.push({name,remoteId,hubId,exposeLightToggle:!!inferred.lightToggle,commands:inferred});
   for(const {name:command} of commands){const current=(cfg.buttons??[]).find(b=>b.remoteId===remoteId&&b.command===command);upsertButton(current?.name??(name+' '+command),remoteId,hubId,command);}
  }else if(kind==='fan'){
   const off=$('off-command').value,speeds=[...$('speeds').querySelectorAll('select')].map(s=>s.value),lightToggle=$('light-command').value;
   if(!valid.has(off)||!speeds.length||speeds.some(s=>!valid.has(s))||new Set(speeds).size!==speeds.length||speeds.includes(off)||(lightToggle&&(!valid.has(lightToggle)||lightToggle===off||speeds.includes(lightToggle))))throw Error('Choose distinct Off, speed and optional light commands. Order speeds from lowest to highest.');
   const item={name,remoteId,hubId,exposeLightToggle:!!lightToggle,commands:{off,speeds,...(lightToggle?{lightToggle}:{})}};cfg.fans??=[];const i=cfg.fans.findIndex(f=>f.remoteId===remoteId);if(i<0)cfg.fans.push(item);else cfg.fans[i]={...cfg.fans[i],...item};
  }else if(kind==='button'){
   const command=$('button-command').value;if(!valid.has(command))throw Error('Choose a supported single-code command.');upsertButton(name,remoteId,hubId,command);
  }else{
   if($('ac-option').disabled)throw Error('This AC profile is not supported.');if((cfg.acPresets??[]).some(a=>a.remoteId===remoteId))throw Error('Remove the standalone presets for this AC before adding its thermostat.');cfg.airConditioners??=[];const item={name,remoteId,hubId},i=cfg.airConditioners.findIndex(a=>a.remoteId===remoteId);if(i<0)cfg.airConditioners.push(item);else cfg.airConditioners[i]={...cfg.airConditioners[i],...item};
  }
  await update();configured();tell('Mapping added to the draft. Review and save below.');
 });
 $('save').onclick=work(async()=>{if(pendingAccount)throw Error('Save the selected account first.');await update();await hb.savePluginConfig();tell('Mappings saved. Restart Homebridge to apply.');});
 $('advanced').ontoggle=()=>{$('advanced').open?hb.showSchemaForm():hb.hideSchemaForm();};
 hb.addEventListener('configChanged',event=>{if(event.data?.length){blocks=event.data;cfg=blocks[0];configured();}});
 configured();hb.hideSpinner();
})().catch(()=>{document.getElementById('notice').textContent='Could not load settings. Close and reopen this panel.';window.homebridge.hideSpinner();});
