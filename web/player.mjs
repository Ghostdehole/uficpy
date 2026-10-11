import {nals,annex,parsePacket,spsInfo,mapPoint} from './h264.mjs';
import {initSegment,fragment} from './mp4.mjs';
import {loadPreferences,savePreferences} from './preferences.mjs';
import {fetchClientOptions} from './client.mjs';
import {InputState,keyAllowed,keyPacket,keyboardKey,scrollPacket,textPacket} from './control.mjs';
const $=id=>document.getElementById(id),video=$('video'),canvas=$('canvas'),stage=$('stage'),ctx=canvas.getContext('2d',{alpha:false});
let token=new URLSearchParams(location.hash.slice(1)).get('token')||'',ws,decoder,media,source,url;
let sps,pps,info,needKey=true,mode='',generation=0,queue=[],queueBytes=0,pending,base,sequence=1,retryTimer,watchdog;
let frames=0,packets=0,bytes=0,ready=false,failures=0,forceMSE=false,disposed=false,volumeUnlocked=false;
const prefs=loadPreferences();let permissions={read_only:true,allow_volume_keys:false,allowed_keys:[]},rtt=null,lastStats={time:performance.now(),bytes:0,frames:0};
const decoderConfig=()=>({codec:info.codec,optimizeForLatency:true,hardwareAcceleration:prefs.hardware});
const status=(text,error=false)=>{$('status').textContent=text;$('status').style.color=error?'#ff9898':'#b3e8c8';};
// Keep token out of HTTP request paths and server logs; it is sent as a WS subprotocol.
if(token)history.replaceState(null,'',location.pathname+location.search);
const supportedMSE=()=>window.ManagedMediaSource||window.MediaSource;
const input=new InputState(send);
function updateControls(){
 document.querySelectorAll('[data-key]').forEach(b=>{b.disabled=!ready||!keyAllowed(Number(b.dataset.key),permissions,volumeUnlocked);});
 $('text').disabled=!ready||permissions.read_only;$('screenshot').disabled=!ready;
 $('access-mode').hidden=!ready||!permissions.read_only;
 const allowed=permissions.allow_volume_keys&&!permissions.read_only;
 $('volume-policy').textContent=permissions.read_only?'当前连接为只读。':allowed?'后端已允许；仍需在下方确认风险。':'需要先在管理插件的危险功能中允许音量键。';
 $('volume-gate').hidden=!allowed;$('volume').hidden=!allowed||!volumeUnlocked;
 $('lock-volume').hidden=!volumeUnlocked;$('unlock-volume').hidden=volumeUnlocked;
 $('volume-confirmation').disabled=volumeUnlocked;
}
function lockVolume(){volumeUnlocked=false;$('volume-confirmation').value='';$('unlock-volume').disabled=true;updateControls();}
function cleanup(){
 input.releaseAll();generation++;clearTimeout(watchdog);ready=false;needKey=true;sps=pps=info=null;pending=null;base=undefined;sequence=1;queue=[];queueBytes=0;updateControls();
 if(ws){ws.onclose=null;ws.close();ws=null;}
 if(decoder&&decoder.state!=='closed')decoder.close();decoder=null;
 source=null;media=null;video.pause();video.removeAttribute('src');video.load();if(url)URL.revokeObjectURL(url);url=null;
 canvas.hidden=true;video.hidden=true;$('play').hidden=true;
}
function fail(error){
 if(disposed)return;console.error(error);const message=error?.message||String(error);cleanup();status(message,true);
 clearTimeout(retryTimer);if(++failures<=4)retryTimer=setTimeout(connect,Math.min(1000*2**failures,8000));else status(message+'；自动重试已停止，请查看日志或手动重连。',true);
}
async function connect(){
 if(disposed)return;clearTimeout(retryTimer);cleanup();packets=bytes=frames=0;rtt=null;lastStats={time:performance.now(),bytes:0,frames:0};
 if(!token){$('auth').hidden=false;status('请提供访问令牌');return;}
 $('auth').hidden=true;
 const authEpoch=generation;
 try{const options=await fetchClientOptions(token);if(authEpoch!==generation)return;permissions=options;
 updateControls();
 }catch(e){if(authEpoch===generation)fail(e);return;}
 const selected=$('mode').value;
 mode=selected==='auto'?(window.isSecureContext&&window.VideoDecoder&&!forceMSE?'webcodecs':'mse'):selected;
 if(mode==='webcodecs'&&(!window.isSecureContext||!window.VideoDecoder)){status('WebCodecs 需要安全上下文及浏览器支持；请选择 MSE，或通过可信 HTTPS/localhost 打开。',true);return;}
 if(mode==='mse'&&!supportedMSE()){status('浏览器没有可用的 MSE/ManagedMediaSource；请使用支持的浏览器或可信 HTTPS 的 WebCodecs。',true);return;}
 status('正在连接…');const epoch=generation;
 ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws',['uficpy-v2',token]);ws.binaryType='arraybuffer';
 ws.onopen=()=>{status('已连接，等待画面…');watchdog=setTimeout(()=>fail(Error('15 秒内未显示画面：请检查核心日志、编码器和浏览器解码支持')),15000);};
 ws.onerror=()=>status('WebSocket 连接失败：检查服务、令牌、端口及 HTTPS 配置',true);
 ws.onclose=e=>{if(epoch===generation)fail(Error('连接关闭 ('+e.code+')，检查服务日志/令牌'));};
 ws.onmessage=e=>{
  if(epoch!==generation)return;
  try{
   if(typeof e.data==='string'){const m=JSON.parse(e.data);if(m.type==='pong'){rtt=Date.now()-m.id;return;}if(m.state==='error'){fail(Error(m.detail));return;}if(!ready)status(m.detail);return;}
   const p=parsePacket(e.data);packets++;bytes+=p.data.length;
   const units=nals(p.data);if(!units.length)throw Error('收到的 H.264 数据不含 Annex-B 起始码');
   let changed=false;
   for(const n of units){const t=n[0]&31;if(t===7){changed=changed||(!!sps&&String(sps)!==String(n));sps=n.slice();}if(t===8){changed=changed||(!!pps&&String(pps)!==String(n));pps=n.slice();}}
   if(changed){fail(Error('屏幕方向/编码参数已变化，重新同步'));return;}
   if(p.config)return;
   const key=p.key||units.some(n=>(n[0]&31)===5);
   if(!units.some(n=>[1,5].includes(n[0]&31)))return;
   if(!sps||!pps||(!key&&needKey))return;
   if(!info){info=spsInfo(sps);initialize();}
   if(needKey){if(!key)return;needKey=false;}
   if(mode==='webcodecs'){
    if(decoder.decodeQueueSize>prefs.decodeQueue){decoder.reset();decoder.configure(decoderConfig());needKey=true;return;}
    decoder.decode(new EncodedVideoChunk({type:key?'key':'delta',timestamp:p.pts,data:key?annex(sps,pps,...units.filter(n=>![7,8].includes(n[0]&31))):p.data}));
   }else{
    if(base===undefined)base=p.pts;
    if(pending){const duration=p.pts-pending.pts;if(duration<=0||duration>4294967295)throw Error('时间戳不连续或含 B 帧，重新同步');append(fragment(pending.data,pending.key,pending.pts-base,duration,sequence++));}
    pending={...p,key};
   }

  }catch(error){if(mode==='webcodecs'&&$('mode').value==='auto')forceMSE=true;fail(error);}
 };
}
function displayed(){if(!ready){ready=true;failures=0;clearTimeout(watchdog);updateControls();status('画面已显示 · '+mode+(permissions.read_only?' · 只读':''));}}
function initialize(){
 if(mode==='webcodecs'){
  canvas.hidden=false;const epoch=generation;
  decoder=new VideoDecoder({output:frame=>{try{if(epoch!==generation)return;if(canvas.width!==frame.displayWidth||canvas.height!==frame.displayHeight){canvas.width=frame.displayWidth;canvas.height=frame.displayHeight;}ctx.drawImage(frame,0,0);frames++;displayed();}finally{frame.close();}},error:e=>{if(epoch!==generation)return;if($('mode').value==='auto')forceMSE=true;fail(e);}});
  decoder.configure(decoderConfig());
 }else{
  const MS=supportedMSE(),mime=`video/mp4; codecs="${info.codec}"`;
  if(!MS.isTypeSupported(mime))throw Error('浏览器不支持 '+info.codec+' 的 MSE 解码');
  video.hidden=false;video.muted=true;video.playsInline=true;video.disableRemotePlayback=true;
  media=new MS();const epoch=generation;
  media.addEventListener('sourceopen',()=>{if(epoch!==generation)return;try{source=media.addSourceBuffer(mime);source.addEventListener('updateend',()=>{if(epoch!==generation)return;pump();followLive();});source.addEventListener('error',()=>{if(epoch===generation)fail(Error('MSE 追加视频数据失败'));});media.duration=Infinity;pump();play();}catch(e){fail(e);}},{once:true});
  if('onstartstreaming' in media)media.addEventListener('startstreaming',()=>{if(epoch===generation){pump();play();}});
  url=URL.createObjectURL(media);video.src=url;append(initSegment(sps,pps));
 }
}
function append(data){queue.push(data);queueBytes+=data.length;if(queueBytes>prefs.queueMB*1024*1024||queue.length>2048)throw Error('播放缓冲积压，重新同步');pump();}
function pump(){
 if(!source||source.updating||!media||media.readyState!=='open')return;
 try{
  if(source.buffered.length && video.currentTime>6 && source.buffered.start(0)<video.currentTime-5){source.remove(0,video.currentTime-3);return;}
  if(queue.length){const data=queue.shift();queueBytes-=data.length;source.appendBuffer(data);}
 }catch(e){fail(e);}
}
function followLive(){
 if(!video.buffered.length)return;const i=video.buffered.length-1,end=video.buffered.end(i),start=video.buffered.start(i);
 if(video.currentTime<start||end-video.currentTime>prefs.maxBuffer)video.currentTime=Math.max(start,end-prefs.targetBuffer);
 video.playbackRate=end-video.currentTime>prefs.targetBuffer+0.08?1.05:1;
 if(video.paused)play();
}
function play(){const epoch=generation;video.play().then(()=>{if(epoch===generation)$('play').hidden=true;}).catch(()=>{if(epoch===generation){$('play').hidden=false;status('浏览器暂停了自动播放，请点击播放');}});}
video.addEventListener('error',()=>{if(media)fail(Error('视频元素解码错误：'+(video.error?.message||video.error?.code)));});
video.addEventListener('timeupdate',()=>{if(media&&mode==='mse'&&video.videoWidth&&video.currentTime>0)displayed();});
$('play').onclick=play;$('retry').onclick=()=>{failures=0;forceMSE=false;connect();};$('mode').onchange=()=>{prefs.mode=$('mode').value;savePreferences(prefs);failures=0;forceMSE=false;connect();};
$('auth').onsubmit=e=>{e.preventDefault();token=$('token').value.trim();failures=0;connect();};
function send(packet,releasing=false){
 if(permissions.read_only||ws?.readyState!==WebSocket.OPEN||ws.bufferedAmount>(releasing?1048576:65536))return false;
 try{ws.send(packet);return true;}catch{return false;}
}
function pointFor(event,clamp=false){return info&&mapPoint(stage.getBoundingClientRect(),info.width,info.height,event.clientX,event.clientY,clamp);}
stage.addEventListener('pointerdown',event=>{
 if(permissions.read_only||!ready||!info||event.button!==0||event.target.closest('form,button'))return;
 const point=pointFor(event);if(!point||!input.down(event.pointerId,point,info))return;
 event.preventDefault();stage.focus({preventScroll:true});try{stage.setPointerCapture(event.pointerId);}catch{input.up(event.pointerId);}
});
stage.addEventListener('pointermove',event=>{if(!input.pointers.has(event.pointerId)||!info)return;event.preventDefault();const point=pointFor(event,true);if(point)input.move(event.pointerId,point);});
function releasePointer(event){input.up(event.pointerId);if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);}
for(const event of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(event,releasePointer);
stage.addEventListener('contextmenu',event=>{if(ready&&!permissions.read_only)event.preventDefault();});
stage.addEventListener('wheel',event=>{
 if(!ready||permissions.read_only||!info||event.ctrlKey)return;const point=pointFor(event);if(!point)return;
 const scale=event.deltaMode===1?40:event.deltaMode===2?stage.clientHeight:1;
 if(send(scrollPacket(point,info,-event.deltaX*scale/100,-event.deltaY*scale/100)))event.preventDefault();
},{passive:false});
stage.addEventListener('keydown',event=>{
 if(event.target!==stage||!ready||permissions.read_only)return;const key=keyboardKey(event);
 if(key===null||!keyAllowed(key,permissions))return;
 if(input.keyDown(event.code,key))event.preventDefault();
});
window.addEventListener('keyup',event=>{if(input.keyUp(event.code))event.preventDefault();});
stage.addEventListener('blur',()=>input.releaseAll());
window.addEventListener('blur',()=>input.releaseAll());
document.addEventListener('visibilitychange',()=>{if(document.hidden)input.releaseAll();});
for(const button of document.querySelectorAll('[data-key]'))button.onclick=()=>{
 const key=Number(button.dataset.key);if(!ready||!keyAllowed(key,permissions,volumeUnlocked))return;
 if(send(keyPacket(0,key)))send(keyPacket(1,key),true);
};
$('volume-confirmation').oninput=()=>{$('unlock-volume').disabled=$('volume-confirmation').value.trim()!=='我已确认设备音量键行为';};
$('unlock-volume').onclick=()=>{if(permissions.read_only||!permissions.allow_volume_keys||$('volume-confirmation').value.trim()!=='我已确认设备音量键行为')return;volumeUnlocked=true;updateControls();};
$('lock-volume').onclick=lockVolume;
$('dangerous-controls').addEventListener('toggle',()=>{if(!$('dangerous-controls').open)lockVolume();});
$('preferences-panel').addEventListener('toggle',()=>{if($('preferences-panel').open)input.releaseAll();else{lockVolume();$('dangerous-controls').open=false;}});
document.addEventListener('pointerdown',event=>{if($('preferences-panel').open&&!$('preferences-panel').contains(event.target))$('preferences-panel').open=false;});
$('text').onclick=()=>{if(!ready||permissions.read_only)return;input.releaseAll();$('text-error').textContent='';$('text-dialog').showModal();$('paste-text').focus();};
$('cancel-text').onclick=()=>{$('text-dialog').close();};
$('text-form').onsubmit=event=>{event.preventDefault();if(!ready||permissions.read_only){$('text-error').textContent='设备尚未连接或处于只读模式';return;}try{if(!send(textPacket($('paste-text').value)))throw Error('发送失败，请检查连接后重试');$('paste-text').value='';$('text-dialog').close();}catch(error){$('text-error').textContent=error.message;}};
window.addEventListener('pagehide',()=>{input.releaseAll();lockVolume();disposed=true;clearTimeout(retryTimer);cleanup();});
window.addEventListener('pageshow',event=>{if(event.persisted){disposed=false;connect();}});

$('mode').value=prefs.mode;
$('hardware').value=prefs.hardware;$('target-buffer').value=Math.round(prefs.targetBuffer*1000);$('max-buffer').value=Math.round(prefs.maxBuffer*1000);$('decode-queue').value=prefs.decodeQueue;
$('preferences').onsubmit=e=>{e.preventDefault();const target=Number($('target-buffer').value)/1000,max=Number($('max-buffer').value)/1000,depth=Number($('decode-queue').value);if(!Number.isFinite(target)||target<0.03||target>3||!Number.isFinite(max)||max<=target||max>10||!Number.isInteger(depth)||depth<1||depth>120){status('缓冲/队列参数无效',true);return;}Object.assign(prefs,{mode:$('mode').value,targetBuffer:target,maxBuffer:max,decodeQueue:depth,hardware:$('hardware').value});savePreferences(prefs);$('preferences-panel').open=false;forceMSE=false;failures=0;connect();};
$('reset-preferences').onclick=()=>{Object.assign(prefs,loadPreferences({getItem:()=>null}));savePreferences(prefs);$('mode').value=prefs.mode;$('hardware').value=prefs.hardware;$('target-buffer').value=Math.round(prefs.targetBuffer*1000);$('max-buffer').value=Math.round(prefs.maxBuffer*1000);$('decode-queue').value=prefs.decodeQueue;forceMSE=false;failures=0;connect();};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{status('浏览器不支持当前页面全屏，请用新窗口打开');}};
$('screenshot').onclick=()=>{if(!ready||!info)return;const c=document.createElement('canvas');c.width=info.width;c.height=info.height;c.getContext('2d').drawImage(mode==='webcodecs'?canvas:video,0,0,c.width,c.height);c.toBlob(blob=>{if(!blob)return;const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='uficpy-'+Date.now()+'.png';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);});};
function frameCallback(){if(media&&mode==='mse'&&video.videoWidth){frames++;displayed();}video.requestVideoFrameCallback(frameCallback);}
if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(frameCallback);
const statsTimer=setInterval(()=>{
 if(disposed)return;const now=performance.now(),seconds=(now-lastStats.time)/1000;
 if(mode==='mse'&&!video.requestVideoFrameCallback&&video.getVideoPlaybackQuality)frames=video.getVideoPlaybackQuality().totalVideoFrames;
 const fps=Math.max(0,(frames-lastStats.frames)/seconds),mbps=Math.max(0,(bytes-lastStats.bytes)*8/seconds/1e6);
 const buffer=mode==='mse'&&video.buffered.length?Math.max(0,video.buffered.end(video.buffered.length-1)-video.currentTime)*1000:0;
 $('stats').textContent=info?`${mode} · ${info.width}×${info.height} · ${fps.toFixed(1)} FPS · ${mbps.toFixed(2)} Mbps · ${mode==='mse'?'缓存 '+Math.round(buffer)+' ms':'解码队列 '+(decoder?.decodeQueueSize||0)} · RTT ${rtt===null?'—':rtt+' ms'}`:'等待数据';
 lastStats={time:now,frames,bytes};if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping',id:Date.now()}));
},1000);
// A browser round-trip is diagnostic, not a glass-to-glass video latency measurement.
connect();
