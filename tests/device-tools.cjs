const assert=require('assert/strict');
const fs=require('fs'),path=require('path');

module.exports=async function deviceToolsTests(browser,origin,errors,getLogs){
 const token='a'.repeat(64),requests=[],pages=[];
 let responseMode='success';
 const apk={name:'测试应用 1.apk',mimeType:'application/vnd.android.package-archive',buffer:Buffer.from([0x50,0x4b,3,4,0,1,255,127])};
 async function uploadRoute(route){
  const request=route.request(),url=new URL(request.url());
  requests.push({method:request.method(),path:url.pathname,name:url.searchParams.get('name'),url:request.url(),headers:request.headers(),body:request.postDataBuffer()});
  if(responseMode==='unknown')return route.fulfill({status:200,contentType:'application/json',body:''});
  if(responseMode==='error')return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:'安装失败',detail:'INSTALL_FAILED_UPDATE_INCOMPATIBLE'})});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,message:url.pathname==='/api/install'?'测试安装完成':'测试文件已保存',path:url.pathname==='/api/files'?'/sdcard/Download/uficpy/资料 1.txt':undefined,sha256:'b'.repeat(64)})});
 }
 async function page(readOnly=false){
  const p=await browser.newPage({viewport:{width:1280,height:800}});pages.push(p);p.setDefaultTimeout(10000);
  p.on('pageerror',error=>errors.push('device-tools: '+error.message));
  await p.route(/\/api\/(?:install|files)\?/,uploadRoute);
  if(readOnly)await p.route('**/api/client',async route=>{
   const response=await route.fetch(),data=await response.json();
   await route.fulfill({response,json:{...data,read_only:true}});
  });
  await p.goto(origin+'/#token='+token);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('画面已显示'),null,{timeout:20000});
  await p.locator('#device-tools').click();return p;
 }
 async function drop(p,selector,files){
  await p.locator(selector).evaluate((element,files)=>{
   const dataTransfer=new DataTransfer();
   for(const file of files)dataTransfer.items.add(new File([new Uint8Array(file.bytes)],file.name,{type:file.type}));
   element.dispatchEvent(new DragEvent('drop',{dataTransfer,bubbles:true,cancelable:true}));
  },files);
 }
 async function control(p,selector,hex){
  const start=getLogs().length;await p.locator(selector).click();
  const deadline=Date.now()+3000;
  while(Date.now()<deadline&&!getLogs().slice(start).includes('TEST_CONTROL '+hex))await p.waitForTimeout(20);
  assert.ok(getLogs().slice(start).includes('TEST_CONTROL '+hex),'fixture received control '+hex);
 }
 try{
  const p=await page();
  assert.equal(await p.locator('#tools-upload').isDisabled(),true);
  await p.locator('#tools-file').setInputFiles(apk);
  assert.match(await p.locator('#tools-transfer-status').innerText(),/点击下方按钮才会上传/);
  await p.waitForTimeout(150);assert.equal(requests.length,0,'selecting an APK never installs it');
  await p.locator('#tools-upload').click();
  await p.waitForFunction(()=>document.getElementById('tools-transfer-status').textContent.includes('测试安装完成'));
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/install');assert.equal(requests[0].method,'POST');
  assert.equal(requests[0].name,apk.name);assert.equal(requests[0].headers.authorization,'Bearer '+token);
  assert.equal(requests[0].headers['content-type'],'application/vnd.android.package-archive');
  assert.deepEqual(requests[0].body,apk.buffer);assert.ok(!requests[0].url.includes(token));

  await p.locator('#tools-close').click();
  const file={name:'资料 1.txt',type:'text/plain',bytes:[0,13,10,65,255]};
  await drop(p,'#stage',[file]);
  assert.equal(await p.locator('#tools-dialog').isVisible(),true);
  assert.equal(await p.locator('#tools-upload-kind').inputValue(),'file');
  assert.match(await p.locator('#tools-file-info').innerText(),/资料 1\.txt/);
  await p.waitForTimeout(150);assert.equal(requests.length,1,'dropping a file only selects it');
  await p.locator('#tools-upload').click();
  await p.waitForFunction(()=>document.getElementById('tools-transfer-status').textContent.includes('测试文件已保存'));
  assert.equal(requests.length,2);assert.equal(requests[1].path,'/api/files');assert.equal(requests[1].method,'POST');
  assert.equal(requests[1].name,file.name);assert.equal(requests[1].headers.authorization,'Bearer '+token);
  assert.equal(requests[1].headers['content-type'],'application/octet-stream');assert.deepEqual(requests[1].body,Buffer.from(file.bytes));
  assert.match(await p.locator('#tools-transfer-status').innerText(),/\/sdcard\/Download\/uficpy\/资料 1\.txt/);

  await p.selectOption('#tools-upload-kind','install');
  await p.locator('#tools-file').setInputFiles({name:'bundle.xapk',mimeType:'application/octet-stream',buffer:apk.buffer});
  await p.locator('#tools-upload').click();assert.match(await p.locator('#tools-transfer-status').innerText(),/请选择单个 \.apk/);
  assert.equal(requests.length,2,'unsupported bundles never reach the server');
  await p.locator('#tools-file').setInputFiles(apk);
  for(const [mode,message] of [['error','INSTALL_FAILED_UPDATE_INCOMPATIBLE'],['unknown','安装响应不完整']]){
   responseMode=mode;const before=requests.length;await p.locator('#tools-upload').click();
   await p.waitForFunction(message=>document.getElementById('tools-transfer-status').textContent.includes(message),message);
   assert.equal(await p.locator('#tools-upload').isEnabled(),true);await p.waitForTimeout(350);
   assert.equal(requests.length,before+1,'failed or ambiguous installs are never retried automatically');
  }
  responseMode='success';
  console.log('PASS: APK/file selection and drag require confirmation; raw Bearer uploads preserve bytes; install failures are not replayed');

  await p.locator('#tools-tab-controls').click();
  for(const [name,hex] of [['screen-off','0a00'],['screen-on','0a01'],['rotate','0b'],['notifications','05'],['settings','06'],['collapse','07']])await control(p,`[data-control="${name}"]`,hex);
  await p.locator('#tools-package').fill('com.android.settings');
  const app=Buffer.from('com.android.settings');await control(p,'#tools-launch',Buffer.concat([Buffer.from([16,app.length]),app]).toString('hex'));
  const beforeInvalid=getLogs().length;await p.locator('#tools-package').fill('com.android.settings; reboot');await p.locator('#tools-launch').click();
  assert.match(await p.locator('#tools-control-status').innerText(),/请输入完整应用包名/);
  await p.waitForTimeout(150);assert.ok(!getLogs().slice(beforeInvalid).includes('TEST_CONTROL'),'invalid package names never send a control command');
  console.log('PASS: screen power, rotation, panels and app launch reach the real control fixture; invalid package names are rejected');

  await p.locator('#tools-tab-media').click();
  assert.equal(await p.locator('#tools-record-download').isVisible(),false);
  await p.locator('#tools-record-start').click();
  assert.equal(await p.locator('#tools-record-start').isDisabled(),true);assert.equal(await p.locator('#tools-record-stop').isEnabled(),true);
  await p.waitForFunction(()=>document.getElementById('tools-record-status').textContent.includes('正在录制'),null,{timeout:5000});
  await p.waitForTimeout(200);await p.locator('#tools-record-stop').click();
  assert.equal(await p.locator('#tools-record-download').isVisible(),true);assert.equal(await p.locator('#tools-record-stop').isDisabled(),true);
  assert.match(await p.locator('#tools-record-status').innerText(),/片段已保留/);
  const recorded=await p.locator('#tools-record-download').evaluate(async link=>{
   const blob=await fetch(link.href).then(response=>response.blob()),bytes=new Uint8Array(await blob.arrayBuffer());
   return {size:blob.size,type:blob.type,box:String.fromCharCode(...bytes.subarray(4,8)),name:link.download};
  });
  assert.ok(recorded.size>1000);assert.equal(recorded.type,'video/mp4');assert.equal(recorded.box,'ftyp');assert.match(recorded.name,/^uficpy-\d+\.mp4$/);
  const downloaded=p.waitForEvent('download');await p.locator('#tools-record-download').click();
  assert.equal((await downloaded).suggestedFilename(),recorded.name);
  console.log('PASS: received H.264 records from a real keyframe and exposes a downloadable MP4');

  await p.setViewportSize({width:390,height:844});
  for(const name of ['files','controls','media']){
   await p.locator('#tools-tab-'+name).click();
   if(name==='files')await p.locator('#tools-file').setInputFiles({name:'a'.repeat(160)+'.apk',mimeType:apk.mimeType,buffer:apk.buffer});
   const dimensions=await p.evaluate(()=>{
    const dialog=document.getElementById('tools-dialog'),rect=dialog.getBoundingClientRect();
    return {documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth,left:rect.left,right:rect.right};
   });
   assert.ok(dimensions.documentWidth<=dimensions.viewport,`${name}: page does not scroll horizontally`);
   assert.ok(dimensions.scrollWidth<=dimensions.clientWidth+1,`${name}: dialog does not scroll horizontally (${JSON.stringify(dimensions)})`);
   assert.ok(dimensions.left>=0&&dimensions.right<=dimensions.viewport,`${name}: dialog fits phone viewport`);
   if(process.env.UFICPY_SCREENSHOT_DIR){fs.mkdirSync(process.env.UFICPY_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:path.join(process.env.UFICPY_SCREENSHOT_DIR,'tools-'+name+'-mobile.png')});}
  }

  const readOnly=await page(true),beforeReadOnly=requests.length;
  assert.equal(await readOnly.locator('#tools-readonly').isVisible(),true);
  for(const selector of ['#tools-file','#tools-upload-kind','#tools-upload'])assert.equal(await readOnly.locator(selector).isDisabled(),true);
  await drop(readOnly,'#tools-drop',[{name:apk.name,type:apk.mimeType,bytes:[...apk.buffer]}]);
  assert.equal(await readOnly.locator('#tools-upload').isDisabled(),true);
  await readOnly.locator('#tools-tab-controls').click();
  assert.ok((await readOnly.locator('[data-control],[data-mutate]').evaluateAll(elements=>elements.every(element=>element.disabled))));
  await readOnly.locator('#tools-tab-media').click();assert.equal(await readOnly.locator('#tools-record-start').isEnabled(),true,'view-only users can record their received video');
  await readOnly.waitForTimeout(150);assert.equal(requests.length,beforeReadOnly);
  console.log('PASS: read-only mode disables mutations; all tool tabs fit a 390px viewport, including long filenames');
 }finally{for(const page of pages)await page.close({runBeforeUnload:false});}
};
