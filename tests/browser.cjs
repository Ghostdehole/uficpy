const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright':'playwright');
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'uficpy-browser-')),token='a'.repeat(64);
(async()=>{
 let browser,server,logs='';
 try{
  for(const file of ['scrcpy-server.jar','version.txt'])fs.copyFileSync(path.join(root,file),path.join(tmp,file));
  fs.copyFileSync(path.join(root,'tests/mock-app-process.py'),path.join(tmp,'app_process'));
  fs.chmodSync(path.join(tmp,'app_process'),0o700); // Web uploads may not preserve executable bits.
  fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify({max_size:1280,max_fps:30,bit_rate:4000000,no_audio:true,port:19528,listen:'0.0.0.0',token,allow_volume_keys:true}));
  server=cp.spawn(path.join(root,'fixture-server'),['-test.run','^TestBrowserFixtureServer$'],{cwd:root,env:{...process.env,PATH:tmp+':'+process.env.PATH,UFICPY_TEST_H264:path.join(root,'tests/fixtures/sample.h264'),UFICPY_BROWSER_FIXTURE:tmp}});
  server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
  for(let i=0;i<50;i++){if(fs.existsSync(path.join(tmp,'uficpy.ready')))break;await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:process.env.UFICPY_CHROME?undefined:'chrome',executablePath:process.env.UFICPY_CHROME||undefined,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP device.test 127.0.0.1']});
  const errors=[];
  
  const a=await browser.newPage();a.on('pageerror',e=>errors.push(e.message));
  await a.goto('http://127.0.0.1:19528/#token='+token);
  await a.locator('#preferences-panel > summary').click();await a.selectOption('#mode','mse');
  await a.waitForFunction(()=>document.getElementById('status').textContent.includes('画面已显示'),null,{timeout:20000});
  assert.match(await a.locator('#status').innerText(),/mse/);await a.locator('#preferences-panel > summary').click();
  await a.waitForFunction(()=>document.getElementById('stats').textContent.includes('160×96'));
  assert.match(await a.locator('#stats').textContent(),/FPS/);
  await a.locator('#stage').click();await a.waitForTimeout(300);assert.match(logs,/TEST_CONTROL 02/);
  assert.equal(await a.locator('#volume').isVisible(),false);
  await a.locator('#preferences-panel > summary').click();await a.locator('#advanced-controls > summary').click();await a.locator('#dangerous-controls > summary').click();
  assert.equal(await a.locator('#unlock-volume').isDisabled(),true);
  await a.locator('#volume-confirmation').fill('我已确认设备音量键行为');await a.locator('#unlock-volume').click();
  assert.equal(await a.locator('#volume').isVisible(),true);await a.locator('[data-key="24"]').click();
  await a.locator('#preferences-panel > summary').click();assert.equal(await a.locator('#volume').isVisible(),false);
  await a.locator('#stage').click();await a.keyboard.down('ArrowDown');await a.evaluate(()=>window.dispatchEvent(new Event('blur')));await a.keyboard.up('ArrowDown');
  await a.mouse.wheel(0,100);await a.waitForTimeout(150);
  assert.match(logs,/TEST_CONTROL 000000000014/);assert.match(logs,/TEST_CONTROL 000100000014/);assert.match(logs,/TEST_CONTROL 03/);assert.match(logs,/TEST_CONTROL 000000000018/);
  const rect=await a.locator('#stage').boundingBox(),cdp=await a.context().newCDPSession(a);
  const touchLogStart=logs.length;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2-10,y:rect.y+rect.height/2,id:7},{x:rect.x+rect.width/2+10,y:rect.y+rect.height/2,id:42}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x+rect.width/2-20,y:rect.y+rect.height/2,id:7},{x:rect.x+rect.width/2+20,y:rect.y+rect.height/2,id:42}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await a.waitForTimeout(100);const touchHex=[...logs.slice(touchLogStart).matchAll(/TEST_CONTROL ([0-9a-f]+)/g)].map(m=>m[1]).join(''),touchBytes=Buffer.from(touchHex,'hex'),touchPackets=[];for(let at=0;at<touchBytes.length;at+=32){assert.equal(touchBytes[at],2);touchPackets.push(touchBytes.subarray(at,at+32));}const downs=touchPackets.filter(p=>p[1]===0),ups=touchPackets.filter(p=>p[1]===1);assert.equal(downs.length,2);assert.equal(ups.length,2);assert.notEqual(downs[0].readBigUInt64BE(2),downs[1].readBigUInt64BE(2));
  await a.locator('#text').click();await a.locator('#paste-text').fill('你好');await a.locator('#text-form button:last-child').click();await a.waitForTimeout(150);assert.match(logs,/TEST_CONTROL 09/);
  console.log('PASS: deep volume gate, relock, keyboard focus release, wheel, real CDP multi-touch, Unicode text');
  const b=await browser.newPage();b.on('pageerror',e=>errors.push(e.message));
  await b.goto('http://127.0.0.1:19528/#token='+token);
  await b.waitForFunction(()=>document.getElementById('status').textContent.includes('画面已显示'),null,{timeout:20000});
  assert.match(await b.locator('#status').innerText(),/webcodecs/);
  console.log('PASS: HTTP localhost MSE, WebCodecs, late join, pointer control');
  if(process.env.UFICPY_SCREENSHOT_DIR){fs.mkdirSync(process.env.UFICPY_SCREENSHOT_DIR,{recursive:true});await a.screenshot({path:path.join(process.env.UFICPY_SCREENSHOT_DIR,'player-desktop.png')});await a.setViewportSize({width:390,height:844});await a.screenshot({path:path.join(process.env.UFICPY_SCREENSHOT_DIR,'player-mobile.png')});}
  await require('./plugin.cjs')(browser,'http://127.0.0.1:19528',errors,root);
  await a.close();await b.close();
  await new Promise(r=>setTimeout(r,2700));
  const health=await fetch('http://127.0.0.1:19528/healthz',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
  assert.equal(health.clients,0);assert.equal(health.capture,'idle');assert.deepEqual(errors,[]);
  console.log('PASS: all viewers closed -> capture idle; no uncaught page errors');
 }catch(e){console.error(logs);throw e;}
 finally{if(browser)await browser.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
