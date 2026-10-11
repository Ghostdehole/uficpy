const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert/strict');

module.exports=async function pluginTests(browser,origin,errors,root){
 const token='a'.repeat(64),config={...JSON.parse(fs.readFileSync(path.join(root,'config.json'))),token,port:19528};
 const source=fs.readFileSync(path.join(root,'uficpy_plugin.js'),'utf8');
 const version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
 const marker=/<!--\s*\[KANO_PLUGIN_START\]\s*(.*?)\s*-->([\s\S]*?)<!--\s*\[KANO_PLUGIN_END\]\s*\1\s*-->/g;
 const blocks=[...source.matchAll(marker)];
 assert.equal(blocks.length,1);assert.equal(blocks[0][1],'uficpy_plugin.js');
 const pluginSource=blocks[0][2].trim();
 assert.doesNotThrow(()=>new Function(source));assert.doesNotThrow(()=>new Function(pluginSource));
 if(process.env.UFICPY_UFI_MAIN){
  const host=fs.readFileSync(process.env.UFICPY_UFI_MAIN,'utf8');
  const begin=host.indexOf('const handlePluginFileUpload ='),end=host.indexOf('const exportPlugin =',begin);
  assert.ok(begin>=0&&end>begin);
  const probe=await browser.newPage();
  await probe.setContent('<textarea id="custom_head"></textarea>');
  const imports=await probe.evaluate(async({handler,source,pluginSource,version})=>{
   const plugins=[],results=[];
   const upload=new Function('t','createToast','plugins','renderPluginList',handler+';return handlePluginFileUpload;')(s=>s,()=>{},plugins,()=>{});
   for(const [name,content] of [
    ['uficpy_plugin.js',pluginSource.replace(`const version = '${version}'`,"const version = '0.0.1'")],
    [`uficpy_plugin-v${version}.js`,source],
    ['uficpy_plugin-v9.9.9.js',source.replace(`const version = '${version}'`,"const version = '9.9.9'")]
   ]){
    await upload({target:{files:[new File([content],name,{type:'text/javascript'})]}});
    results.push(plugins.map(item=>({...item})));
   }
   return results;
  },{handler:host.slice(begin,end),source,pluginSource,version});
  for(const snapshot of imports){assert.equal(snapshot.length,1);assert.equal(snapshot[0].name,'uficpy_plugin.js');assert.doesNotThrow(()=>new Function(snapshot[0].content));}
  assert.match(imports[0][0].content,/const version = '0\.0\.1'/);
  assert.equal(imports[1][0].content,pluginSource);
  assert.match(imports[2][0].content,/const version = '9\.9\.9'/);
  await probe.close();console.log('PASS: official UFI import handler replaces the fixed plugin identity across versioned filenames');
 }
 if(process.env.UFICPY_UFI_REQUESTS){
  const text=fs.readFileSync(process.env.UFICPY_UFI_REQUESTS,'utf8');
  const begin=text.indexOf('const runShellWithRoot ='),end=text.indexOf('const runShellWithUser =',begin);
  assert.ok(begin>=0&&end>begin);
  const probe=await browser.newPage();
  const results=await probe.evaluate(async source=>{
   const make=new Function('KANO_baseURL','common_headers','fetchWithTimeout',source+';return runShellWithRoot;');
   const results=[];for(const body of ['', '<html>login</html>', '{"result":"root"}'])results.push(await make('/api',{},async()=>new Response(body))('id -u'));
   return results;
  },text.slice(begin,end));
  assert.equal(results[0].success,false);assert.match(results[0].content,/Unexpected end of JSON input/);
  assert.equal(results[1].success,false);assert.deepEqual(results[2],{success:true,content:'root'});
  await probe.close();console.log('PASS: official runShellWithRoot reproduces empty-response JSON error in Chrome');
 }
 async function page(deniedStorage=false){
  const p=await browser.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push('plugin: '+e.message));
  await p.route('**/ufi-test',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div class="functions-container"></div><div id="BG_OVERLAY"><div class="container"></div></div></body></html>'}));
  await p.goto(origin+'/ufi-test');
  await p.evaluate(({config,deniedStorage,version})=>{
   window.UFI_DATA={};window.testCommands=[];window.testToasts=[];window.testConfig=JSON.stringify(config);window.testFailure=null;
   window.runShellWithRoot=async(cmd,timeout)=>{
    window.testCommands.push({cmd,timeout});
    if(window.testFailure&&(!window.testFailure.on||cmd.includes(window.testFailure.on))){const f=window.testFailure;if(f.throws)throw new SyntaxError(f.message);return {success:false,content:f.message};}
    let content='running';
    if(cmd.includes("config.json")&&cmd.includes("timeout 2s awk"))content=window.testConfig;
    else if(cmd.includes('grep -qxF'))content=window.testBootEnabled?'yes':'no';
    else if(cmd.includes('releases/latest/download/release.json'))content=JSON.stringify({schema:1,version,scrcpy_version:'5.0.1',tag:'v'+version+'-test',repository:'Ghostdehole/uficpy',assets:{arm64:{name:'uficpy-arm64.tar.gz',sha256:'b'.repeat(64),size:1000000}}});
    return {success:true,content:content+'\nUFICPY_OK\n'};
   };
   window.createToast=(text)=>window.testToasts.push(text);
   // UFI utils.js returns modal IDs as CSS selectors.
   window.createModal=({name,title,content,onClose})=>{
    const el=document.createElement('div');el.id=name;el.innerHTML='<h3>'+title+'</h3>'+content;
    const close=document.createElement('button');close.id=name+'_close';close.textContent='关闭';close.onclick=()=>{if(onClose())el.remove();};el.appendChild(close);
    document.querySelector('#BG_OVERLAY .container').appendChild(el);return {el,id:'#'+name};
   };
   window.showModal=id=>{const el=document.querySelector(id);if(!el)throw Error('Invalid modal selector: '+id);el.style.display='block';};
   window.closeModal=(id,time,cb)=>{document.querySelector(id).style.display='none';cb?.();};
   window.collapseGen=(a,b,storageName,cb)=>{
    const el=document.querySelector(b);el.dataset.name=storageName?(localStorage.getItem(storageName)||'open'):'open';el.style.height=el.dataset.name==='open'?'auto':'0';
    window.testCollapse=state=>{el.dataset.name=state;el.style.height=state==='open'?'auto':'0';cb(state);};
   };
   if(deniedStorage){Storage.prototype.getItem=Storage.prototype.setItem=Storage.prototype.removeItem=()=>{throw new DOMException('Storage denied','SecurityError');};}
  },{config,deniedStorage,version});
  // Optional compatibility run against UFI's utils.js.
  if(process.env.UFICPY_UFI_UTILS){
   await p.evaluate(()=>{window.t=s=>s;window.Chart={register(){}};});
   await p.addScriptTag({content:fs.readFileSync(process.env.UFICPY_UFI_UTILS,'utf8')});
   assert.deepEqual(errors,[], 'UFI utils.js must load with its host dependencies');
  }
  await p.addScriptTag({content:pluginSource});
  await p.waitForSelector('#uficpy_status');
  await p.locator('#uficpy_advanced').evaluate(el=>el.parentElement.open=true);
  return p;
 }
 const p=await page();
 assert.ok(!(await p.locator('#uficpy_CONTAINER').innerText()).includes('按需采集'),'main card has no technical slogan');
 assert.deepEqual(await p.locator('#uficpy_actions button').allTextContents(),['刷新状态','启动','停止','参数','新窗口']);
 assert.equal(await p.locator('#uficpy_CONTAINER').getByRole('button',{name:'危险功能',exact:true}).count(),0,'dangerous controls are absent from the main card');

 await p.waitForTimeout(250);assert.equal(await p.evaluate(()=>testCommands.length),0,'no Root call before UFI login');
 await p.evaluate(()=>UFI_DATA.loginfo='ok');
 await p.waitForFunction(()=>document.getElementById('uficpy_iframe').src.includes('#token='));
 const click=async label=>{await p.getByRole('button',{name:label,exact:true}).click();await p.waitForFunction(()=>!document.querySelector('#uficpy_actions button').disabled);};
 // Test both the documented failure return and a host version that rejects.
 for(const f of [{message:"Failed to execute 'json' on 'Response': Unexpected end of JSON input"},{message:'The string did not match the expected pattern.',throws:true}]){
  await p.evaluate(f=>{window.testFailure=f;window.testCommands=[];},f);
  await click('刷新状态');
  assert.match(await p.locator('#uficpy_error').innerText(),/读取服务状态：UFI-TOOLS 命令接口返回异常/);
  assert.equal(await p.evaluate(()=>testCommands.length),1,'no automatic replay');
 }
 await p.evaluate(()=>{window.testCommands=[];});await click('重启');
 assert.equal(await p.evaluate(()=>testCommands.filter(x=>x.cmd.includes('service.sh restart')).length),1);
 await p.evaluate(()=>{window.testFailure=null;});
 for(const body of ['', '{"token":', '[]']){
  await p.evaluate(body=>window.testConfig=body,body);await click('参数');
  assert.match(await p.locator('#uficpy_error').innerText(),/config.json.*(为空|完整的 JSON|JSON 对象)/);
 }
 await p.evaluate(config=>{window.testConfig=JSON.stringify(config);localStorage.setItem('uficpy_player_base','http://[broken');},config);
 await click('刷新状态');assert.match(await p.locator('#uficpy_error').innerText(),/播放地址格式错误/);
 await p.evaluate(()=>localStorage.removeItem('uficpy_player_base'));
 await click('高级 JSON');await click('高级 JSON');
 assert.equal(await p.locator('#uficpy_json').count(),1,await p.locator('#uficpy_error').innerText());assert.equal(await p.locator('#uficpy_json_input').count(),1);
 const before=await p.locator('#uficpy_json_input').inputValue();
 await p.locator('#uficpy_import').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{bad')});
 await p.waitForFunction(()=>document.getElementById('uficpy_error').textContent.includes('导入配置'));
 assert.equal(await p.locator('#uficpy_json_input').inputValue(),before,'invalid import leaves editor intact');
 // Import and direct JSON editing both converge on the same save gate.
 const enabledConfig={...config,allow_volume_keys:true};
 await p.locator('#uficpy_import').setInputFiles({name:'enable-volume.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(enabledConfig))});
 await p.waitForFunction(()=>document.querySelector('#uficpy_json_input').value.includes('"allow_volume_keys": true'));
 await p.evaluate(()=>{window.testCommands=[];});
 await p.getByRole('button',{name:'校验、保存并重启',exact:true}).click();
 await p.waitForSelector('#uficpy_volume_confirm');
 assert.match(await p.locator('#uficpy_volume_confirm').innerText(),/恢复出厂设置.*数据丢失/);
 assert.equal(await p.locator('#uficpy_volume_accept').isDisabled(),true);
 assert.ok(!(await p.evaluate(()=>testCommands)).some(x=>x.cmd.includes('config.next.')),'opening confirmation never writes config');
 await p.locator('#uficpy_volume_phrase').fill('确认');
 assert.equal(await p.locator('#uficpy_volume_accept').isDisabled(),true);
 await p.locator('#uficpy_volume_confirm_close').click();
 await p.waitForFunction(()=>!document.querySelector('#uficpy_actions button').disabled);
 assert.ok(!(await p.evaluate(()=>testCommands)).some(x=>x.cmd.includes('config.next.')),'cancelling confirmation never writes config');
 assert.equal(await p.locator('#uficpy_json').count(),1,'cancel keeps the JSON editor open');
 await p.getByRole('button',{name:'校验、保存并重启',exact:true}).click();
 await p.locator('#uficpy_volume_phrase').fill('我已确认设备音量键行为');
 await p.locator('#uficpy_volume_accept').click();
 await p.waitForFunction(()=>!document.querySelector('#uficpy_actions button').disabled);
 assert.equal((await p.evaluate(()=>testCommands)).filter(x=>x.cmd.includes('config.next.')).length,1,'acknowledged change is written exactly once');
 await p.waitForFunction(()=>!document.getElementById('uficpy_json'));
 // Disabling an existing opt-in needs no typed acknowledgement.
 await p.evaluate(c=>{window.testConfig=JSON.stringify(c);window.testCommands=[];},enabledConfig);
 await click('高级 JSON');await click('危险功能');
 assert.equal(await p.locator('#uficpy_danger').count(),1);
 await click('关闭音量键');
 assert.equal(await p.locator('#uficpy_volume_confirm').count(),0);
 const disabledWrite=(await p.evaluate(()=>testCommands)).find(x=>x.cmd.includes('config.next.'));
 assert.ok(disabledWrite);assert.match(disabledWrite.cmd,/"allow_volume_keys": false/);
 await p.evaluate(c=>{window.testConfig=JSON.stringify(c);},config);
 assert.ok((await p.locator('#uficpy_json_input').inputValue()).includes('"allow_volume_keys": false'));
 // The dedicated deep-settings action has the same acknowledgement gate.
 await click('危险功能');await p.evaluate(()=>{window.testCommands=[];});
 await p.getByRole('button',{name:'继续设置音量键',exact:true}).click();
 await p.waitForSelector('#uficpy_volume_confirm');
 assert.ok(!(await p.evaluate(()=>testCommands)).some(x=>x.cmd.includes('config.next.')));
 await p.locator('#uficpy_volume_confirm_close').click();
 await p.waitForFunction(()=>!document.querySelector('#uficpy_actions button').disabled);
 assert.equal(await p.locator('#uficpy_danger').count(),1,'cancel preserves the settings panel');
 await p.locator('#uficpy_danger_close').click();
 await p.waitForFunction(()=>!document.getElementById('uficpy_danger'));
 await p.evaluate(()=>{window.testCommands=[];window.testFailure={on:'service.sh restart',message:'Unexpected end of JSON input'};});
 await click('校验、保存并重启');
 assert.match(await p.locator('#uficpy_error').innerText(),/运行结果未知/);
 assert.equal(await p.evaluate(()=>testCommands.filter(x=>x.cmd.includes('service.sh restart')).length),1);
 assert.ok(!(await p.evaluate(()=>testCommands)).some(x=>x.cmd.includes('cp /data/uficpy/config.previous.json')||x.cmd.includes('service.sh start')),'uncertain restart must not roll back configuration or start again');
 await p.evaluate(()=>window.testFailure=null);
 // Simulate close through the host API, then reopen a form.
 await p.evaluate(()=>document.getElementById('uficpy_json').remove());
 await click('参数');assert.equal(await p.locator('#uficpy_config [data-field="port"]').inputValue(),'19528');
 assert.equal(await p.locator('#uficpy_config [data-field="allow_volume_keys"]').count(),0,'normal settings cannot enable dangerous keys');
 await p.evaluate(()=>document.getElementById('uficpy_config').remove());
 // Exercise the actual generated shell only against a temporary local fixture.
 await p.evaluate(()=>{window.testCommands=[];window.testBootEnabled=false;});
 await click('开机自启');
 const enableBoot=(await p.evaluate(()=>testCommands)).find(x=>x.cmd.includes('mktemp /sdcard/ufi_tools_boot.sh.uficpy.XXXXXX'));
 await p.evaluate(()=>{window.testCommands=[];window.testBootEnabled=true;});
 await click('开机自启');
 const disableBoot=(await p.evaluate(()=>testCommands)).find(x=>x.cmd.includes('mktemp /sdcard/ufi_tools_boot.sh.uficpy.XXXXXX'));
 assert.ok(enableBoot&&disableBoot);
 const bootDir=fs.mkdtempSync(path.join(os.tmpdir(),'uficpy-boot-')),bootFile=path.join(bootDir,'boot.sh');
 const oldLine='(cd /data/uficpy && sh service.sh start)',ownLine='sh /data/uficpy/service.sh start # UFICPY_V2_AUTOSTART';
 const original='#!/system/bin/sh\necho other-plugin\n'+oldLine+'\n'+ownLine+'\n';
 const runBoot=(entry,env=process.env)=>cp.spawnSync('sh',['-c',entry.cmd.replaceAll('/sdcard/ufi_tools_boot.sh',bootFile).replace('[ "$(id -u)" = 0 ]','true')],{encoding:'utf8',env});
 try {
  fs.writeFileSync(bootFile,original);fs.chmodSync(bootFile,0o751);
  assert.match(runBoot(enableBoot).stdout,/UFICPY_OK/);
  assert.equal(fs.readFileSync(bootFile,'utf8'),'#!/system/bin/sh\necho other-plugin\n'+ownLine+'\n');
  assert.equal(fs.statSync(bootFile).mode&0o777,0o751,'atomic replacement preserves existing file mode');
  assert.match(runBoot(disableBoot).stdout,/UFICPY_OK/);
  assert.equal(fs.readFileSync(bootFile,'utf8'),'#!/system/bin/sh\necho other-plugin\n');
  fs.writeFileSync(bootFile,original);
  const bin=path.join(bootDir,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'awk'),'#!/bin/sh\nexit 42\n',{mode:0o755});
  assert.match(runBoot(enableBoot,{...process.env,PATH:bin+':'+process.env.PATH}).stdout,/UFICPY_COMMAND_FAILED/);
  assert.equal(fs.readFileSync(bootFile,'utf8'),original,'filter failure never truncates the original boot file');
  assert.deepEqual(fs.readdirSync(bootDir).sort(),['bin','boot.sh'],'failed staging leaves no temporary boot file');
 } finally { fs.rmSync(bootDir,{recursive:true,force:true}); }
 await click('安装 / 更新');
 const commands=await p.evaluate(()=>testCommands),download=commands.find(x=>x.cmd.includes('-o package.tar.gz')),check=commands.find(x=>x.cmd.includes('sha256sum -c checksum')),install=commands.find(x=>x.cmd.includes('sh extracted/install.sh'));
 assert.ok(download.cmd.includes('/releases/download/v'+version+'-test/uficpy-arm64.tar.gz'));assert.match(download.cmd,/--max-time 55/);
 assert.match(check.cmd,/tar -tzf/);assert.ok(install);assert.notEqual(check,install);
 assert.ok(commands.every(x=>x.timeout<=90000));assert.ok(!commands.some(x=>x.cmd.includes('cat /data/uficpy/config.json')));
 if(process.env.UFICPY_SCREENSHOT_DIR){fs.mkdirSync(process.env.UFICPY_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.UFICPY_SCREENSHOT_DIR,'install-command.txt'),check.cmd);}
 // The actual host switch is exercised by its input event when supplied.
 if(process.env.UFICPY_UFI_UTILS){
  await p.locator('#collapse_uficpy_btn input').uncheck();
 }else await p.evaluate(()=>testCollapse('close'));
 assert.equal(await p.locator('#uficpy_iframe').getAttribute('src'),'about:blank');
 await p.close();
 const denied=await page(true);await denied.evaluate(()=>UFI_DATA.loginfo='ok');
 await denied.waitForFunction(()=>document.getElementById('uficpy_status').textContent.includes('服务运行中'));
 await denied.close();
 console.log('PASS: UFI login readiness, host JSON/Safari errors, no command replay, config/URL/import errors, modal IDs, confirmed volume-key opt-in/import and disable, compact UI, atomic boot update/failure preservation, denied storage, staged install <=90s');
};
