const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert/strict');

// Exercise the public settings and install buttons. No fixture invokes Root or
// contacts a release host: UFI's command bridge returns explicit shell outcomes.
module.exports=async function downloadTests(browser,origin,errors,root){
 const source=fs.readFileSync(path.join(root,'uficpy_plugin.js'),'utf8');
 const version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
 const repository='Ghostdehole/uficpy',base='https://download.doevt.top/uficpy';
 const manifest={schema:1,version,scrcpy_version:'5.0.1',repository,tag:'v'+version+'-test',assets:{arm64:{name:'uficpy-arm64.tar.gz',sha256:'b'.repeat(64),size:1000000},armv7:{name:'uficpy-armv7.tar.gz',sha256:'c'.repeat(64),size:900000}}};
 const githubManifest=`https://github.com/${repository}/releases/latest/download/release.json`,mirrorManifest=base+'/release.json';
 const githubAsset=`https://github.com/${repository}/releases/download/${manifest.tag}/uficpy-arm64.tar.gz`,mirrorAsset=base+'/releases/'+manifest.tag+'/uficpy-arm64.tar.gz';
 const settings=(policy='github-first',mirror=base)=>({uficpy_repository:repository,uficpy_mirror_base:mirror,uficpy_download_policy:policy});
 const deviceFacts=(uname='aarch64',abilist64='arm64-v8a',abilist='arm64-v8a,armeabi-v7a',abi='arm64-v8a')=>`UFICPY_DEVICE_UNAME=${uname}\nUFICPY_DEVICE_ABILIST64=${abilist64}\nUFICPY_DEVICE_ABILIST=${abilist}\nUFICPY_DEVICE_ABI=${abi}`;

 async function initialize(p,initial){
  await p.evaluate(({initial,manifest,device})=>{
   if(initial)for(const [key,value]of Object.entries(initial))localStorage.setItem(key,value);
   window.UFI_DATA={loginfo:'ok'};window.testCommands=[];window.testToasts=[];window.testPlans={};window.testFailure=null;window.testDevice=device;
   window.runShellWithRoot=async(cmd,timeout)=>{
    const url=cmd.match(/https:\/\/[A-Za-z0-9./_%-]+/)?.[0];
    window.testCommands.push({cmd,timeout,url});
    let outcome=url?window.testPlans[url]:null;
    if(Array.isArray(outcome))outcome=outcome.shift();
    if(window.testFailure&&cmd.includes(window.testFailure.on))outcome=window.testFailure.outcome;
    if(outcome==='bridge-error')return {success:false,content:'Unexpected end of JSON input'};
    if(outcome==='download-error')return {success:true,content:'curl: (28) Connection timed out\nUFICPY_DOWNLOAD_FAILED\nUFICPY_COMMAND_FAILED\n'};
    if(outcome==='command-error')return {success:true,content:'command failed\nUFICPY_COMMAND_FAILED\n'};
    if(outcome==='digest-error')return {success:true,content:'package.tar.gz: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match\nUFICPY_COMMAND_FAILED\n'};
    let content='done';
    if(outcome&&Object.hasOwn(outcome,'raw'))content=outcome.raw;
    else if(cmd.includes('UFICPY_DEVICE_UNAME'))content=window.testDevice;
    else if(url?.endsWith('/release.json'))content=JSON.stringify(outcome?.manifest||manifest);
    else if(cmd.includes('service.sh status'))content='missing';
    return {success:true,content:content+'\nUFICPY_OK\n'};
   };
   window.createToast=text=>window.testToasts.push(text);
   window.createModal=({name,title,content,onClose})=>{
    const el=document.createElement('div');el.id=name;el.innerHTML='<h3>'+title+'</h3>'+content;
    const close=document.createElement('button');close.id=name+'_close';close.textContent='关闭';close.onclick=()=>{if(onClose())el.remove();};el.appendChild(close);
    document.querySelector('#BG_OVERLAY .container').appendChild(el);return {el,id:'#'+name};
   };
   window.showModal=id=>document.querySelector(id).style.display='block';
   window.closeModal=id=>document.querySelector(id).style.display='none';
   window.collapseGen=(a,b)=>{const el=document.querySelector(b);el.dataset.name='open';el.style.height='auto';};
  },{initial,manifest,device:deviceFacts()});
  await p.addScriptTag({content:source});
  await p.waitForFunction(()=>document.querySelector('#uficpy_status')?.textContent.includes('未安装')&&!document.querySelector('#uficpy_actions button').disabled);
  await p.locator('#uficpy_advanced').evaluate(el=>el.parentElement.open=true);
  await p.evaluate(()=>testCommands=[]);
 }
 async function page(initial){
  const p=await browser.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push('download: '+e.message));
  await p.route('**/ufi-download-test',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div class="functions-container"></div><div id="BG_OVERLAY"><div class="container"></div></div></body></html>'}));
  await p.goto(origin+'/ufi-download-test');await initialize(p,initial);return p;
 }
 const click=async(p,name)=>{await p.getByRole('button',{name,exact:true}).click();await p.waitForFunction(()=>!document.querySelector('#uficpy_actions button').disabled);};
 const plans=async(p,value)=>p.evaluate(value=>{window.testPlans=value;},value);
 const profile=async(p,value)=>p.evaluate(value=>{window.testDevice=value;},value);
 const commands=async p=>p.evaluate(()=>testCommands);
 const requests=async p=>{
  const outgoing=(await commands(p)).filter(c=>c.url);
  for(const {cmd}of outgoing){assert.match(cmd,/--globoff/);assert.match(cmd,/--proto /);assert.match(cmd,/--proto-redir /);assert.ok(!/\s(?:-k|--insecure)\s/.test(cmd));}
  return outgoing.map(c=>c.url);
 };
 const installs=async p=>(await commands(p)).filter(c=>c.cmd.includes('sh extracted/install.sh'));
 const failure=async(p,on,outcome)=>p.evaluate(value=>{window.testFailure=value;},{on,outcome});
 async function expectStopped(p,expected){
  assert.deepEqual(await requests(p),expected);
  assert.equal((await installs(p)).length,0,'rejected source or package must never run the installer');
  assert.ok((await p.locator('#uficpy_error').innerText()).trim(),'failure must be visible');
 }

 // Source preferences survive a page reload and never invoke a Root command.
 const prefs=await page();await click(prefs,'发布源');
 assert.equal(await prefs.locator('#uficpy_download_policy').inputValue(),'github-first');
 await prefs.locator('#uficpy_source_repository').fill('  Ghostdehole/uficpy  ');
 await prefs.locator('#uficpy_mirror_base').fill('  HTTPS://DOWNLOAD.DOEVT.TOP/uficpy///  ');
 await prefs.locator('#uficpy_download_policy').selectOption('mirror-first');
 await prefs.locator('#uficpy_source_save').click();await prefs.waitForFunction(()=>!document.getElementById('uficpy_sources'));
 assert.deepEqual(await prefs.evaluate(()=>Object.fromEntries(['uficpy_repository','uficpy_mirror_base','uficpy_download_policy'].map(key=>[key,localStorage.getItem(key)]))),settings('mirror-first'));
 assert.equal((await commands(prefs)).length,0);
 await prefs.reload();await initialize(prefs);await click(prefs,'发布源');
 assert.equal(await prefs.locator('#uficpy_mirror_base').inputValue(),base);
 assert.equal(await prefs.locator('#uficpy_download_policy').inputValue(),'mirror-first');
 for(const value of ['http://download.doevt.top/uficpy','ftp://download.doevt.top/uficpy','https://user:pass@download.doevt.top/uficpy',base+'?token=secret',base+'#fragment',base+'\u0001']){
  await prefs.locator('#uficpy_mirror_base').fill(value);await prefs.locator('#uficpy_source_save').click();
  assert.equal(await prefs.locator('#uficpy_sources').count(),1,'invalid source keeps the settings open: '+JSON.stringify(value));
  assert.ok((await prefs.locator('#uficpy_source_error').innerText()).trim());
  assert.equal(await prefs.evaluate(()=>localStorage.getItem('uficpy_mirror_base')),base,'invalid source cannot overwrite stored preferences');
 }
 await prefs.locator('#uficpy_mirror_base').fill('');await prefs.locator('#uficpy_download_policy').selectOption('mirror-only');await prefs.locator('#uficpy_source_save').click();
 assert.ok((await prefs.locator('#uficpy_source_error').innerText()).trim());
 await prefs.locator('#uficpy_download_policy').selectOption('mirror-first');await prefs.locator('#uficpy_source_save').click();
 await prefs.waitForFunction(()=>!document.getElementById('uficpy_sources'));
 assert.equal(await prefs.evaluate(()=>localStorage.getItem('uficpy_download_policy')),'github-first');
 await prefs.close();
 console.log('PASS: download source preferences persist; HTTPS normalization, credentials/query/fragment/control rejection and empty-mirror policies');

 // Architecture comes from the device bridge, never the browser or hostname.
 for(const [facts,arch] of [
  [deviceFacts(),'arm64'],
  [deviceFacts('arm64','','',''),'arm64'],
  [deviceFacts('armv8l','','armeabi-v7a,armeabi','armeabi-v7a'),'arm64'],
  [deviceFacts('armv7l','','armeabi-v7a,armeabi','armeabi-v7a'),'armv7'],
  [deviceFacts('armv7','','','armeabi-v7a'),'armv7'],
  [deviceFacts('armv7l','arm64-v8a','armeabi-v7a','armeabi-v7a'),'arm64'],
  [deviceFacts('armv7l','','armeabi-v7a,arm64-v8a','armeabi-v7a'),'arm64'],
  [deviceFacts('armv7l','','','arm64-v8a'),'arm64'],
  [deviceFacts('armv7l','','not-arm64-v8a','armeabi-v7a'),'armv7'],
  [deviceFacts('  armv8l  ','','','').replaceAll('\n','\r\n'),'arm64'],
  [deviceFacts(' ARMV7L ','',' armeabi-v7a,armeabi ',' armeabi-v7a ').replaceAll('\n','\r\n'),'armv7']
 ]){
  const p=await page(settings('mirror-only'));await profile(p,facts);await click(p,'安装 / 更新');
  const asset=manifest.assets[arch];
  assert.deepEqual(await requests(p),[mirrorManifest,`${base}/releases/${manifest.tag}/${asset.name}`],facts);
  const all=await commands(p),check=all.find(c=>c.cmd.includes('sha256sum -c checksum'));
  assert.ok(check?.cmd.includes(asset.sha256),'selected architecture must use its own digest');
  assert.ok(check?.cmd.includes(String(asset.size)),'selected architecture must use its own size');
  assert.equal((await installs(p)).length,1);assert.ok(all[0].cmd.includes('UFICPY_DEVICE_UNAME'),'probe must run before network requests');
  await p.close();
 }
 for(const facts of [deviceFacts('x86_64','','x86_64','x86_64'),deviceFacts('i686','','x86','x86'),deviceFacts('mips','arm64-v8a','arm64-v8a','arm64-v8a'),deviceFacts('','','',''),'','UFICPY_DEVICE_UNAME=armv7l']){
  const p=await page(settings());await profile(p,facts);await click(p,'安装 / 更新');
  await expectStopped(p,[]);
  assert.ok(!(await commands(p)).some(c=>c.cmd.includes('mkdir ')||c.cmd.includes('sh extracted/install.sh')),'unsupported or incomplete profile cannot prepare an install');
  await p.close();
 }
 const diagnostic=await page();await profile(diagnostic,deviceFacts('armv7l','','armeabi-v7a,armeabi','armeabi-v7a'));await click(diagnostic,'设备架构');
 assert.match(await diagnostic.locator('#uficpy_detail').innerText(),/armv7l/);
 assert.match(await diagnostic.locator('#uficpy_detail').innerText(),/armeabi-v7a/);
 const diagnosticCommands=await commands(diagnostic);assert.equal(diagnosticCommands.length,1);assert.ok(diagnosticCommands[0].cmd.includes('UFICPY_DEVICE_UNAME'));
 assert.ok(!/\b(?:mkdir|rm|curl|install\.sh|service\.sh)\b/.test(diagnosticCommands[0].cmd),'architecture diagnosis is available without installing or altering a backend');
 // Execute the generated read-only shell against fake Android tools as well.
 const deviceBin=fs.mkdtempSync(path.join(os.tmpdir(),'uficpy-device-'));
 try{
  fs.symlinkSync('/bin/sh',path.join(deviceBin,'sh'));
  fs.writeFileSync(path.join(deviceBin,'uname'),'#!/bin/sh\n[ "$1" = -m ] || exit 1\nprintf "%s\\n" armv7l\n',{mode:0o700});
  fs.writeFileSync(path.join(deviceBin,'getprop'),'#!/bin/sh\ncase "$1" in\nro.product.cpu.abilist64) printf "\\n";;\nro.product.cpu.abilist) printf "armeabi-v7a,armeabi\\n";;\nro.product.cpu.abi) printf "armeabi-v7a\\n";;\n*) exit 1;;\nesac\n',{mode:0o700});
  const command=diagnosticCommands[0].cmd.replace('[ "$(id -u)" = 0 ]','true');
  const run=()=>cp.spawnSync('/bin/sh',['-c',command],{encoding:'utf8',env:{...process.env,PATH:deviceBin}});
  const android=run();assert.equal(android.status,0,android.stderr);assert.match(android.stdout,/UFICPY_OK/);
  assert.equal(android.stdout.replace(/\s*UFICPY_OK\s*$/,'').trim(),deviceFacts('armv7l','','armeabi-v7a,armeabi','armeabi-v7a'));
  fs.unlinkSync(path.join(deviceBin,'getprop'));
  const unavailable=run();assert.equal(unavailable.status,0,unavailable.stderr);assert.match(unavailable.stdout,/UFICPY_OK/);
  assert.equal(unavailable.stdout.replace(/\s*UFICPY_OK\s*$/,'').trim(),deviceFacts('armv7l','','',''));
 }finally{fs.rmSync(deviceBin,{recursive:true,force:true});}
 await diagnostic.close();
 const unsupportedDiagnostic=await page();await profile(unsupportedDiagnostic,deviceFacts('x86_64','','x86_64','x86_64'));await click(unsupportedDiagnostic,'设备架构');
 assert.match(await unsupportedDiagnostic.locator('#uficpy_detail').innerText(),/x86_64/);assert.equal((await commands(unsupportedDiagnostic)).length,1);await unsupportedDiagnostic.close();
 const oldRelease=await page(settings());await profile(oldRelease,deviceFacts('armv7l','','armeabi-v7a','armeabi-v7a'));
 await plans(oldRelease,{[githubManifest]:{manifest:{...manifest,assets:{arm64:manifest.assets.arm64}}}});await click(oldRelease,'安装 / 更新');
 await expectStopped(oldRelease,[githubManifest]);assert.match(await oldRelease.locator('#uficpy_error').innerText(),/ARMv7|armv7/);await oldRelease.close();
 const wrongArch=await page(settings());await profile(wrongArch,deviceFacts('armv7l','','armeabi-v7a','armeabi-v7a'));
 await plans(wrongArch,{[githubManifest]:{manifest:{...manifest,assets:{...manifest.assets,armv7:manifest.assets.arm64}}}});await click(wrongArch,'安装 / 更新');
 await expectStopped(wrongArch,[githubManifest]);await wrongArch.close();
 const pinnedV7=await page(settings()),githubV7=githubAsset.replace('uficpy-arm64','uficpy-armv7'),mirrorV7=mirrorAsset.replace('uficpy-arm64','uficpy-armv7');
 await profile(pinnedV7,deviceFacts('armv7l','','armeabi-v7a','armeabi-v7a'));await plans(pinnedV7,{[githubV7]:'download-error'});await click(pinnedV7,'安装 / 更新');
 assert.deepEqual(await requests(pinnedV7),[githubManifest,githubV7,mirrorV7],'fallback must preserve both release tag and architecture');assert.equal((await installs(pinnedV7)).length,1);await pinnedV7.close();
 console.log('PASS: ARMv7, ARMv8 compat and AArch64 selection, CRLF normalization, read-only diagnostics, unsupported/missing architecture rejection and pinned architecture failover');

 const legacy=await page();await click(legacy,'安装 / 更新');
 assert.deepEqual(await requests(legacy),[githubManifest,githubAsset]);assert.equal((await installs(legacy)).length,1);await legacy.close();
 for(const policy of ['mirror-first','mirror-only']){
  const p=await page(settings(policy));await click(p,'安装 / 更新');
  assert.deepEqual(await requests(p),[mirrorManifest,mirrorAsset]);assert.equal((await installs(p)).length,1);
  assert.ok((await commands(p)).every(c=>c.timeout<=90000));await p.close();
 }
 const fallback=await page(settings());await plans(fallback,{[githubManifest]:'download-error'});await click(fallback,'安装 / 更新');
 assert.deepEqual(await requests(fallback),[githubManifest,mirrorManifest,mirrorAsset]);assert.equal((await installs(fallback)).length,1);await fallback.close();
 const reverse=await page(settings('mirror-first'));await plans(reverse,{[mirrorManifest]:'download-error'});await click(reverse,'安装 / 更新');
 assert.deepEqual(await requests(reverse),[mirrorManifest,githubManifest,githubAsset]);assert.equal((await installs(reverse)).length,1);await reverse.close();
 const pinned=await page(settings());await plans(pinned,{[githubAsset]:'download-error'});await click(pinned,'安装 / 更新');
 assert.deepEqual(await requests(pinned),[githubManifest,githubAsset,mirrorAsset],'asset fallback retains selected tag and never fetches another latest manifest');
 assert.equal((await installs(pinned)).length,1);await pinned.close();
 const stale=await page(settings());await plans(stale,{[githubAsset]:'download-error',[mirrorAsset]:'download-error'});await click(stale,'安装 / 更新');
 await expectStopped(stale,[githubManifest,githubAsset,mirrorAsset,mirrorManifest]);
 assert.equal(await stale.locator('#uficpy_mirror_version').count(),0,'the same unavailable tag is not a different build to approve');await stale.close();
 const only=await page(settings('mirror-only'));await plans(only,{[mirrorManifest]:'download-error'});await click(only,'安装 / 更新');
 await expectStopped(only,[mirrorManifest]);await only.close();
 const onlyAsset=await page(settings('mirror-only'));await plans(onlyAsset,{[mirrorAsset]:'download-error'});await click(onlyAsset,'安装 / 更新');
 await expectStopped(onlyAsset,[mirrorManifest,mirrorAsset]);await onlyAsset.close();
 console.log('PASS: default GitHub, mirror-first/only, manifest failover and asset failover pinned to the selected release');

 // A stale mirror can offer its own build only after every copy of the selected
 // GitHub build has failed. The version strings deliberately match: the full
 // release tags, not just the public version, must be visible for approval.
 const mirrored={...manifest,tag:'v'+version+'-mirror-build.4.1',assets:{
  arm64:{...manifest.assets.arm64,sha256:'d'.repeat(64),size:810000},
  armv7:{...manifest.assets.armv7,sha256:'e'.repeat(64),size:710000}
 }};
 const recoveredAsset=arch=>`${base}/releases/${mirrored.tag}/${mirrored.assets[arch].name}`;
 const stalledRequests=arch=>[githubManifest,githubAsset.replace('arm64',arch),mirrorAsset.replace('arm64',arch),mirrorManifest];
 const recoveryPlans=(candidate={manifest:mirrored},arch='arm64')=>({
  [githubAsset.replace('arm64',arch)]:'download-error',
  [mirrorAsset.replace('arm64',arch)]:'download-error',
  [mirrorManifest]:candidate
 });
 const waitIdle=async p=>p.waitForFunction(()=>!document.querySelector('#uficpy_actions button').disabled);
 async function openRecovery(p,{arch='arm64',fresh=false}={}){
  if(fresh)p.once('dialog',dialog=>dialog.accept());
  await p.getByRole('button',{name:fresh?'全新安装':'安装 / 更新',exact:true}).click();
  await p.locator('#uficpy_mirror_version').waitFor({state:'visible'});
  const detail=await p.locator('#uficpy_mirror_version').innerText();
  assert.ok(detail.includes(manifest.tag),'confirmation identifies the originally selected full tag');
  assert.ok(detail.includes(mirrored.tag),'confirmation identifies the mirror full tag even when version matches');
  assert.deepEqual(await requests(p),stalledRequests(arch),'a different build must not download before approval');
  assert.equal((await installs(p)).length,0,'approval precedes any installer command');
 }
 async function expectUnchangedPolicy(p){
  assert.equal(await p.evaluate(()=>localStorage.getItem('uficpy_download_policy')),'github-first','one-time recovery cannot silently change the saved policy');
 }
 for(const [arch,fresh]of [['arm64',false],['armv7',true]]){
  const p=await page(settings());
  if(arch==='armv7')await profile(p,deviceFacts('armv7l','','armeabi-v7a','armeabi-v7a'));
  await plans(p,recoveryPlans({manifest:mirrored},arch));await openRecovery(p,{arch,fresh});
  await p.locator('#uficpy_mirror_accept').click();await waitIdle(p);
  assert.deepEqual(await requests(p),[...stalledRequests(arch),recoveredAsset(arch)],'approved recovery only downloads the mirror build, with no return to GitHub');
  const checks=(await commands(p)).filter(c=>c.cmd.includes('sha256sum -c checksum'));
  assert.equal(checks.length,1,'only the approved package proceeds to verification');
  assert.ok(checks[0].cmd.includes(mirrored.assets[arch].sha256),'approved build uses its own checksum');
  assert.ok(checks[0].cmd.includes(String(mirrored.assets[arch].size)),'approved build uses its own size');
  assert.ok(!checks[0].cmd.includes(manifest.assets[arch].sha256),'the unavailable build digest is not reused');
  const installed=await installs(p);assert.equal(installed.length,1);
  assert.equal(installed[0].cmd.includes('--fresh'),fresh,'recovery preserves the original install mode');
  assert.equal((await p.locator('#uficpy_error').innerText()).trim(),'');
  await expectUnchangedPolicy(p);await p.close();
 }
 for(const action of ['#uficpy_mirror_cancel','#uficpy_mirror_version_close']){
  const p=await page(settings());await plans(p,recoveryPlans());await openRecovery(p);
  await p.locator(action).click();await waitIdle(p);
  assert.deepEqual(await requests(p),stalledRequests('arm64'),'cancel and close do not download another build');
  assert.equal((await installs(p)).length,0,'cancel and close do not run an installer');
  await expectUnchangedPolicy(p);await p.close();
 }
 for(const candidate of [
  'download-error',
  {raw:''},
  {raw:'<html>not a manifest</html>'},
  {manifest:{...mirrored,schema:2}},
  {manifest:{...mirrored,repository:'someone/else'}},
  {manifest:{...mirrored,tag:'../escape'}},
  {manifest:{...mirrored,assets:{armv7:mirrored.assets.armv7}}},
  {manifest:{...mirrored,assets:{arm64:{...mirrored.assets.arm64,name:'uficpy-armv7.tar.gz'}}}},
  {manifest:{...mirrored,assets:{arm64:{...mirrored.assets.arm64,sha256:'invalid'}}}},
  {manifest:{...mirrored,assets:{arm64:{...mirrored.assets.arm64,size:0}}}},
  {manifest:{...manifest,assets:{...manifest.assets,arm64:{...manifest.assets.arm64,sha256:mirrored.assets.arm64.sha256}}}},
  {manifest:{...manifest,assets:{...manifest.assets,arm64:{...manifest.assets.arm64,size:mirrored.assets.arm64.size}}}}
 ]){
  const p=await page(settings());await plans(p,recoveryPlans(candidate));await click(p,'安装 / 更新');
  await expectStopped(p,stalledRequests('arm64'));
  assert.equal(await p.locator('#uficpy_mirror_version').count(),0,'invalid, unavailable or conflicting same-tag mirror metadata cannot be approved');
  await expectUnchangedPolicy(p);await p.close();
 }
 for(const outcome of ['download-error','command-error','bridge-error']){
  const p=await page(settings());await plans(p,{...recoveryPlans(),[recoveredAsset('arm64')]:outcome});await openRecovery(p);
  await p.locator('#uficpy_mirror_accept').click();await waitIdle(p);
  await expectStopped(p,[...stalledRequests('arm64'),recoveredAsset('arm64')]);
  if(outcome==='bridge-error'){
   const all=await commands(p),failed=all.findIndex(c=>c.url===recoveredAsset('arm64'));
   assert.equal(all.length,failed+1,'an uncertain recovery download cannot race cleanup or another shell operation');
  }
  await expectUnchangedPolicy(p);await p.close();
 }
 for(const stage of ['manifest','verify','install']){
  const p=await page(settings());await plans(p,recoveryPlans(stage==='manifest'?'bridge-error':{manifest:mirrored}));
  if(stage==='manifest')await click(p,'安装 / 更新');
  else{
   await openRecovery(p);await failure(p,stage==='verify'?'sha256sum -c checksum':'sh extracted/install.sh','bridge-error');
   await p.locator('#uficpy_mirror_accept').click();await waitIdle(p);
  }
  assert.deepEqual(await requests(p),stage==='manifest'?stalledRequests('arm64'):[...stalledRequests('arm64'),recoveredAsset('arm64')]);
  assert.equal((await installs(p)).length,stage==='install'?1:0,'uncertain recovery results never repeat the installer');
  const all=await commands(p),failed=all.findIndex(c=>stage==='manifest'?c.url===mirrorManifest:c.cmd.includes(stage==='verify'?'sha256sum -c checksum':'sh extracted/install.sh'));
  assert.equal(all.length,failed+1,'an uncertain recovery stage must be the final shell command');
  assert.ok((await p.locator('#uficpy_error').innerText()).trim());
  await expectUnchangedPolicy(p);await p.close();
 }
 for(const [step,outcome]of [['sha256sum -c checksum','digest-error'],['sha256sum -c checksum','command-error'],['sh extracted/install.sh','command-error']]){
  const p=await page(settings());await plans(p,recoveryPlans());await openRecovery(p);
  await failure(p,step,outcome);await p.locator('#uficpy_mirror_accept').click();await waitIdle(p);
  assert.deepEqual(await requests(p),[...stalledRequests('arm64'),recoveredAsset('arm64')],'recovery verification or installation failure cannot select another build');
  assert.equal((await installs(p)).length,step==='sh extracted/install.sh'?1:0);
  assert.ok((await p.locator('#uficpy_error').innerText()).trim());
  await p.close();
 }
 console.log('PASS: stale-mirror recovery requires explicit full-tag approval, preserves architecture/fresh mode and checksum, handles cancel/close, and never recurses or retries uncertain operations');

 for(const response of [{raw:''},{raw:'<html>not a manifest</html>'},{manifest:{...manifest,repository:'someone/else'}},{manifest:{...manifest,tag:'../escape'}},{manifest:{...manifest,assets:{arm64:{...manifest.assets.arm64,sha256:'invalid'}}}},{manifest:{...manifest,assets:{arm64:{...manifest.assets.arm64,size:0}}}}]){
  const p=await page(settings());await plans(p,{[githubManifest]:response});await click(p,'安装 / 更新');
  await expectStopped(p,[githubManifest]);await p.close();
 }
 for(const stage of ['profile','manifest','prepare','download','verify','install']){
  const p=await page(settings());
  if(stage==='manifest')await plans(p,{[githubManifest]:'bridge-error'});
  else if(stage==='download')await plans(p,{[githubAsset]:'bridge-error'});
  else await failure(p,stage==='profile'?'UFICPY_DEVICE_UNAME':stage==='prepare'?'umask 077':stage==='verify'?'sha256sum -c checksum':'sh extracted/install.sh','bridge-error');
  await click(p,'安装 / 更新');
  assert.deepEqual(await requests(p),stage==='profile'?[]:['manifest','prepare'].includes(stage)?[githubManifest]:[githubManifest,githubAsset]);
  assert.equal((await installs(p)).length,stage==='install'?1:0,'uncertain bridge response never replays an installation');
  const all=await commands(p),uncertainIndex=all.findIndex(c=>stage==='manifest'?c.url===githubManifest:stage==='download'?c.url===githubAsset:c.cmd.includes(stage==='profile'?'UFICPY_DEVICE_UNAME':stage==='prepare'?'umask 077':stage==='verify'?'sha256sum -c checksum':'sh extracted/install.sh'));
  assert.equal(all.length,uncertainIndex+1,'uncertain operation must not race cleanup or further Root commands');
  await p.close();
 }
 for(const outcome of ['digest-error','command-error']){
  const p=await page(settings());await failure(p,'sha256sum -c checksum',outcome);await click(p,'安装 / 更新');
  await expectStopped(p,[githubManifest,githubAsset]);await p.close();
 }
 const setup=await page(settings());await failure(setup,'umask 077','command-error');await click(setup,'安装 / 更新');
 await expectStopped(setup,[githubManifest]);await setup.close();
 const badStored=await page(settings('mirror-only',base+'\n/injected'));await click(badStored,'安装 / 更新');
 await expectStopped(badStored,[]);await badStored.close();
 console.log('PASS: malformed/untrusted manifests, unavailable versions, verification failure and uncertain command responses cannot install or trigger unsafe retries');
};
