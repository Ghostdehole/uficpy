const fs=require('fs'),path=require('path'),assert=require('assert/strict');

// Exercise the public settings and install buttons. No fixture invokes Root or
// contacts a release host: UFI's command bridge returns explicit shell outcomes.
module.exports=async function downloadTests(browser,origin,errors,root){
 const source=fs.readFileSync(path.join(root,'uficpy_plugin.js'),'utf8');
 const version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
 const repository='Ghostdehole/uficpy',base='https://download.doevt.top/uficpy';
 const manifest={schema:1,version,scrcpy_version:'5.0.1',repository,tag:'v'+version+'-test',assets:{arm64:{name:'uficpy-arm64.tar.gz',sha256:'b'.repeat(64),size:1000000}}};
 const githubManifest=`https://github.com/${repository}/releases/latest/download/release.json`,mirrorManifest=base+'/release.json';
 const githubAsset=`https://github.com/${repository}/releases/download/${manifest.tag}/uficpy-arm64.tar.gz`,mirrorAsset=base+'/releases/'+manifest.tag+'/uficpy-arm64.tar.gz';
 const settings=(policy='github-first',mirror=base)=>({uficpy_repository:repository,uficpy_mirror_base:mirror,uficpy_download_policy:policy});

 async function initialize(p,initial){
  await p.evaluate(({initial,manifest})=>{
   if(initial)for(const [key,value]of Object.entries(initial))localStorage.setItem(key,value);
   window.UFI_DATA={loginfo:'ok'};window.testCommands=[];window.testToasts=[];window.testPlans={};window.testFailure=null;
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
  },{initial,manifest});
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
 await expectStopped(stale,[githubManifest,githubAsset,mirrorAsset]);await stale.close();
 const only=await page(settings('mirror-only'));await plans(only,{[mirrorManifest]:'download-error'});await click(only,'安装 / 更新');
 await expectStopped(only,[mirrorManifest]);await only.close();
 const onlyAsset=await page(settings('mirror-only'));await plans(onlyAsset,{[mirrorAsset]:'download-error'});await click(onlyAsset,'安装 / 更新');
 await expectStopped(onlyAsset,[mirrorManifest,mirrorAsset]);await onlyAsset.close();
 console.log('PASS: default GitHub, mirror-first/only, manifest failover and asset failover pinned to the selected release');

 for(const response of [{raw:''},{raw:'<html>not a manifest</html>'},{manifest:{...manifest,repository:'someone/else'}},{manifest:{...manifest,tag:'../escape'}},{manifest:{...manifest,assets:{arm64:{...manifest.assets.arm64,sha256:'invalid'}}}},{manifest:{...manifest,assets:{arm64:{...manifest.assets.arm64,size:0}}}}]){
  const p=await page(settings());await plans(p,{[githubManifest]:response});await click(p,'安装 / 更新');
  await expectStopped(p,[githubManifest]);await p.close();
 }
 for(const stage of ['manifest','prepare','download','verify','install']){
  const p=await page(settings());
  if(stage==='manifest')await plans(p,{[githubManifest]:'bridge-error'});
  else if(stage==='download')await plans(p,{[githubAsset]:'bridge-error'});
  else await failure(p,stage==='prepare'?'uname -m':stage==='verify'?'sha256sum -c checksum':'sh extracted/install.sh','bridge-error');
  await click(p,'安装 / 更新');
  assert.deepEqual(await requests(p),['manifest','prepare'].includes(stage)?[githubManifest]:[githubManifest,githubAsset]);
  assert.equal((await installs(p)).length,stage==='install'?1:0,'uncertain bridge response never replays an installation');
  const all=await commands(p),uncertainIndex=all.findIndex(c=>stage==='manifest'?c.url===githubManifest:stage==='download'?c.url===githubAsset:c.cmd.includes(stage==='prepare'?'uname -m':stage==='verify'?'sha256sum -c checksum':'sh extracted/install.sh'));
  assert.equal(all.length,uncertainIndex+1,'uncertain operation must not race cleanup or further Root commands');
  await p.close();
 }
 for(const outcome of ['digest-error','command-error']){
  const p=await page(settings());await failure(p,'sha256sum -c checksum',outcome);await click(p,'安装 / 更新');
  await expectStopped(p,[githubManifest,githubAsset]);await p.close();
 }
 const setup=await page(settings());await failure(setup,'uname -m','command-error');await click(setup,'安装 / 更新');
 await expectStopped(setup,[githubManifest]);await setup.close();
 const badStored=await page(settings('mirror-only',base+'\n/injected'));await click(badStored,'安装 / 更新');
 await expectStopped(badStored,[]);await badStored.close();
 console.log('PASS: malformed/untrusted manifests, unavailable versions, verification failure and uncertain command responses cannot install or trigger unsafe retries');
};
