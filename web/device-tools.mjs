import {uploadFile} from './transfers.mjs';
import {clipboardPacket,clipboardRequestPacket,displayPowerPacket,panelPacket,rotatePacket,startAppPacket} from './control.mjs';

const bytesLabel=bytes=>bytes>=1024*1024?(bytes/1024/1024).toFixed(1)+' MiB':bytes+' B';
export class DeviceTools{
 constructor({send,getToken,releaseInput,startRecording,stopRecording,enableAudio,disableAudio,setVolume}){
  Object.assign(this,{send,getToken,releaseInput,startRecording,stopRecording,enableAudio,disableAudio,setVolume});
  this.permissions={read_only:true};this.ready=false;this.file=null;this.transfer=null;this.recording=false;this.recordURL=null;this.clipboardPending=false;
  const style=document.createElement('style');style.textContent=`
   #tools-dialog{width:min(660px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box}
   #tools-dialog h2{margin:0}#tools-dialog .tools-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
   #tools-dialog .tools-tabs{display:flex;gap:6px;margin:18px 0;flex-wrap:wrap}#tools-dialog [aria-selected=true]{background:#304b70;border-color:#85b5ff}
   #tools-dialog label{display:block;margin:12px 0}#tools-dialog input:not([type=checkbox]),#tools-dialog select{max-width:100%;box-sizing:border-box}
   #tools-dialog input[type=text]{width:100%}#tools-dialog input[type=file]{display:block;margin-top:8px;width:100%}
   #tools-dialog .tools-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}#tools-dialog progress{display:block;width:100%;margin:12px 0;height:16px}
   #tools-dialog .tools-drop{border:1px dashed #637992;border-radius:10px;padding:16px;margin:12px 0}
   #tools-dialog [role=status]{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;color:#b7c9df}#tools-file-info{overflow-wrap:anywhere}
   #tools-dialog textarea{min-height:120px;box-sizing:border-box;width:100%}#tools-dialog h3{font-size:14px;margin:18px 0 8px}
   #tools-dialog a[download]{display:inline-block;color:#9bc9ff;padding:8px 0}
   @media(max-width:420px){#tools-dialog{padding:16px}.tools-tabs button{flex:1;padding:7px 5px;font-size:12px}}
  `;document.head.append(style);
  this.dialog=document.createElement('dialog');this.dialog.id='tools-dialog';this.dialog.setAttribute('aria-labelledby','tools-title');
  this.dialog.innerHTML=`<div class="tools-heading"><h2 id="tools-title">设备工具</h2><button id="tools-close" type="button">关闭</button></div>
   <div class="tools-tabs" role="tablist" aria-label="工具分类">
    <button id="tools-tab-files" role="tab" aria-selected="true" aria-controls="tools-files" data-tab="files">文件与应用</button>
    <button id="tools-tab-controls" role="tab" aria-selected="false" aria-controls="tools-controls" data-tab="controls">设备与剪贴板</button>
    <button id="tools-tab-media" role="tab" aria-selected="false" aria-controls="tools-media" data-tab="media">录屏与声音</button>
   </div>
   <section id="tools-files" role="tabpanel" aria-labelledby="tools-tab-files">
    <p id="tools-readonly" hidden>当前为只读连接，不能上传文件、安装应用或控制设备。</p>
    <label>用途 <select id="tools-upload-kind"><option value="install">安装 APK</option><option value="file">上传文件</option></select></label>
    <div class="tools-drop" id="tools-drop"><label>选择文件，也可以拖放到这里或投屏画面<input id="tools-file" type="file" accept=".apk,application/vnd.android.package-archive"></label><p id="tools-file-info">尚未选择文件</p></div>
    <p id="tools-upload-help">支持单个 APK；安装同包名应用时尝试保留数据更新。签名不匹配时会报错，不会自动卸载旧应用。暂不支持 XAPK / APKM / 分包集合。</p>
    <p id="tools-upload-limit"></p><progress id="tools-progress" max="100" value="0" aria-label="上传进度"></progress>
    <div class="tools-buttons"><button id="tools-upload" disabled>上传并安装</button><button id="tools-upload-cancel" disabled>取消上传</button></div>
    <p id="tools-transfer-status" role="status" aria-live="polite"></p>
   </section>
   <section id="tools-controls" role="tabpanel" aria-labelledby="tools-tab-controls" hidden>
    <h3>设备操作</h3><div class="tools-buttons">
     <button data-control="screen-off">关闭设备屏幕</button><button data-control="screen-on">打开设备屏幕</button><button data-control="rotate">旋转屏幕</button>
     <button data-control="notifications">通知栏</button><button data-control="settings">快捷设置</button><button data-control="collapse">收起面板</button>
    </div><p>关闭的是设备物理屏幕，投屏继续；最后一个观看连接结束后会尝试恢复。旋转是否生效取决于应用和系统。</p>
    <label>启动应用（包名）<input id="tools-package" type="text" placeholder="com.example.app" autocomplete="off" spellcheck="false"></label><button id="tools-launch" data-mutate>启动应用</button>
    <p id="tools-control-status" role="status" aria-live="polite"></p>
    <h3>剪贴板</h3><p>手动读取或写入，不会在后台同步其他页面的剪贴板。仅在点击下方按钮后访问浏览器剪贴板。</p>
    <label for="tools-clipboard">剪贴板文字</label><textarea id="tools-clipboard" maxlength="262139" spellcheck="false"></textarea>
    <div class="tools-buttons"><button id="tools-clipboard-get" data-mutate>读取设备剪贴板</button><button id="tools-clipboard-set" data-mutate>写入设备</button><button id="tools-clipboard-paste" data-mutate>写入并粘贴</button><button id="tools-clipboard-local">读取本机剪贴板</button><button id="tools-clipboard-copy">复制到本机</button></div>
    <p id="tools-clipboard-status" role="status" aria-live="polite"></p>
   </section>
   <section id="tools-media" role="tabpanel" aria-labelledby="tools-tab-media" hidden>
    <h3>录屏</h3><p>将接收到的 H.264 视频直接封装为 MP4，不重新编码。当前录屏不含音轨；最多保存 128 MiB 或 30 分钟，达到限制会停止并保留可下载片段。关闭页面前请下载。</p>
    <div class="tools-buttons"><button id="tools-record-start">开始录屏</button><button id="tools-record-stop" disabled>停止录屏</button></div>
    <p id="tools-record-status" role="status" aria-live="polite">未录制</p><a id="tools-record-download" hidden>下载录屏</a>
    <h3>设备声音</h3><p id="tools-audio-config">默认不采集音频。请在管理插件的“参数 → 设备声音”中开启采集并保存，再回来重连。</p>
    <div class="tools-buttons"><button id="tools-audio-start">开启声音</button><button id="tools-audio-stop">静音</button></div>
    <label>浏览器播放音量 <input id="tools-audio-volume" type="range" min="0" max="1" step="0.05" value="1"></label>
    <p>这里仅调节浏览器声音，不会发送设备音量键。音频使用 PCM，约增加 1.54 Mbps 流量，缓冲与视频分别处理。</p><p id="tools-audio-status" role="status" aria-live="polite"></p>
   </section>`;
  document.body.append(this.dialog);this.$=id=>this.dialog.querySelector('#tools-'+id);
  document.getElementById('device-tools').onclick=()=>this.open();this.$('close').onclick=()=>this.dialog.close();
  this.dialog.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>this.tab(button.dataset.tab));
  this.$('file').onchange=()=>this.select(this.$('file').files);
  this.$('upload-kind').onchange=()=>this.uploadKindChanged();
  for(const target of [this.$('drop'),document.getElementById('stage')]){
   target.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=this.permissions.read_only?'none':'copy';}});
   target.addEventListener('drop',e=>{if(!e.dataTransfer?.files.length)return;e.preventDefault();this.open('files');if(this.transfer)return;this.$('upload-kind').value=/\.apk$/i.test(e.dataTransfer.files[0].name)?'install':'file';this.uploadKindChanged();this.select(e.dataTransfer.files);});
  }
  this.$('upload').onclick=()=>this.upload();this.$('upload-cancel').onclick=()=>this.transfer?.cancel();
  const controls={
   'screen-off':()=>displayPowerPacket(false),'screen-on':()=>displayPowerPacket(true),rotate:rotatePacket,
   notifications:()=>panelPacket('notifications'),settings:()=>panelPacket('settings'),collapse:()=>panelPacket('collapse')
  };
  this.dialog.querySelectorAll('[data-control]').forEach(button=>button.onclick=()=>this.action(()=>controls[button.dataset.control](),'control-status'));
  this.$('launch').onclick=()=>this.action(()=>startAppPacket(this.$('package').value.trim()),'control-status');
  this.$('clipboard-get').onclick=()=>{if(this.clipboardPending)return;if(this.action(clipboardRequestPacket,'clipboard-status')){this.clipboardPending=true;this.refresh();}};
  this.$('clipboard-set').onclick=()=>this.action(()=>clipboardPacket(this.$('clipboard').value,false),'clipboard-status');
  this.$('clipboard-paste').onclick=()=>this.action(()=>clipboardPacket(this.$('clipboard').value,true),'clipboard-status');
  this.$('clipboard-local').onclick=async()=>{try{if(!navigator.clipboard?.readText)throw Error('当前环境不能直接读取本机剪贴板，请手动粘贴到文字框。');this.$('clipboard').value=await navigator.clipboard.readText();this.note('clipboard-status','已读取本机文字，尚未发送到设备。');}catch{this.note('clipboard-status','浏览器未允许读取，请手动粘贴到文字框。');this.$('clipboard').focus();}};
  this.$('clipboard-copy').onclick=async()=>{try{if(!navigator.clipboard?.writeText)throw Error();await navigator.clipboard.writeText(this.$('clipboard').value);this.note('clipboard-status','已复制到本机剪贴板。');}catch{this.$('clipboard').focus();this.$('clipboard').select();this.note('clipboard-status','文字已选中，请用浏览器的复制操作。');}};
  this.$('record-start').onclick=()=>{this.releaseInput();this.startRecording();};this.$('record-stop').onclick=()=>this.stopRecording();
  this.$('audio-start').onclick=async()=>{try{await this.enableAudio();}catch(error){this.audioState('error',error.message);}};
  this.$('audio-stop').onclick=()=>this.disableAudio();this.$('audio-volume').oninput=()=>this.setVolume(Number(this.$('audio-volume').value));
  window.addEventListener('beforeunload',e=>{if(this.transfer||this.recording){e.preventDefault();e.returnValue='';}});
  window.addEventListener('pagehide',()=>{this.transfer?.cancel();if(this.recordURL)URL.revokeObjectURL(this.recordURL);});
  this.refresh();
 }
 note(id,text){this.$(id).textContent=text;}
 open(tab){this.releaseInput();if(tab)this.tab(tab);if(!this.dialog.open)this.dialog.showModal();}
 tab(name){for(const button of this.dialog.querySelectorAll('[data-tab]')){const selected=button.dataset.tab===name;button.setAttribute('aria-selected',String(selected));this.$(button.dataset.tab).hidden=!selected;}}
 update(ready,permissions){this.ready=ready;this.permissions=permissions;if(!ready&&this.clipboardPending){this.clipboardPending=false;this.note('clipboard-status','连接已中断，请重连后手动读取。');}this.refresh();}
 refresh(){
  const write=!!this.permissions.device_tools&&!this.permissions.read_only,control=write&&this.ready,busy=!!this.transfer;
  this.$('readonly').hidden=!this.permissions.read_only;
  for(const button of this.dialog.querySelectorAll('[data-control],[data-mutate]'))button.disabled=!control;
  this.$('clipboard-get').disabled=!control||this.clipboardPending;
  this.$('file').disabled=!write||busy;this.$('upload-kind').disabled=!write||busy;this.$('upload').disabled=!write||!this.file||busy;
  this.$('upload-cancel').disabled=!busy||this.transfer.uploaded;
  this.note('upload-limit',`单文件上限 ${bytesLabel(this.permissions.transfers?.max_bytes||512*1024*1024)}；普通文件保存到 /sdcard/Download/uficpy/，同名文件不会覆盖。`);
  this.$('record-start').disabled=!this.ready||this.recording;this.$('record-stop').disabled=!this.recording;
  this.$('audio-start').disabled=!this.permissions.audio?.enabled;
  this.note('audio-config',this.permissions.audio?.enabled?`后端已开启${this.permissions.audio.source==='mic'?'设备麦克风':'设备播放声音'}采集。点击“开启声音”允许本页播放；应用可能限制采集。`:'后端尚未开启音频。请在管理插件的“参数 → 设备声音”中开启采集并保存，然后重连。');
 }
 select(files){if(this.transfer)return;if(files.length!==1){this.note('transfer-status','请一次选择一个文件；分包 APK 集合暂不支持。');return;}this.file=files[0];this.note('file-info',this.file.name+' · '+bytesLabel(this.file.size));this.note('transfer-status','已选择，点击下方按钮才会上传。');this.refresh();}
 uploadKindChanged(){const install=this.$('upload-kind').value==='install';this.$('file').accept=install?'.apk,application/vnd.android.package-archive':'';this.$('upload').textContent=install?'上传并安装':'上传文件';this.note('upload-help',install?'支持单个 APK；安装同包名应用时尝试保留数据更新。签名不匹配时会报错，不会自动卸载旧应用。暂不支持 XAPK / APKM / 分包集合。':'文件写入设备的 Download/uficpy 目录，不会自动打开或执行。');}
 async upload(){
  if(!this.file||this.transfer||this.permissions.read_only||!this.permissions.device_tools)return;
  const install=this.$('upload-kind').value==='install';
  if(install&&!/\.apk$/i.test(this.file.name)){this.note('transfer-status','请选择单个 .apk 文件；XAPK / APKM / APKS 不能直接安装。');return;}
  if((install&&!this.file.size)||this.file.size>(this.permissions.transfers?.max_bytes||512*1024*1024)){this.note('transfer-status','APK 为空或文件超过上传上限。');return;}
  this.$('progress').value=0;this.note('transfer-status','正在上传…');
  const job=uploadFile({file:this.file,install,token:this.getToken(),onProgress:(loaded,total)=>{this.$('progress').value=total?Math.min(100,loaded/total*100):0;this.note('transfer-status',`上传 ${bytesLabel(loaded)} / ${bytesLabel(total)}`);},onUploaded:()=>{this.note('transfer-status',install?'文件已发送，正在等待设备校验并安装。此时不再取消安装，请等待结果。':'文件已发送，正在等待设备保存并校验。');this.refresh();}});
  this.transfer=job;this.refresh();
  try{const result=await job.promise;this.$('progress').value=100;this.note('transfer-status',(result.message||'操作完成')+(result.path?'\n'+result.path:'')+(result.sha256?'\nSHA-256: '+result.sha256:''));}
  catch(error){this.note('transfer-status',error.message);}
  finally{if(this.transfer===job)this.transfer=null;this.refresh();}
 }
 action(makePacket,id){try{if(!this.ready||this.permissions.read_only)throw Error('设备尚未连接或处于只读模式');if(!this.send(makePacket()))throw Error('发送失败，请检查连接');this.note(id,'请求已发送，请以设备实际结果为准。');return true;}catch(error){this.note(id,error.message);return false;}}
 message(message){
  if(message.type==='clipboard'){this.clipboardPending=false;if(typeof message.text==='string'){this.$('clipboard').value=message.text;this.note('clipboard-status','已读取设备剪贴板，可复制到本机或修改后写回。');}else this.note('clipboard-status',message.error||'读取失败');this.refresh();return true;}
  if(message.type==='control_error'){this.note('control-status',message.detail||'设备控制失败');if(this.clipboardPending){this.clipboardPending=false;this.note('clipboard-status',message.detail||'读取失败');this.refresh();}return true;}
  if(message.type==='audio-status'){this.note('audio-status',message.detail||message.state);return true;}return false;
 }
 recordingState(state){this.recording=state==='waiting'||state==='recording';this.note('record-status',state==='waiting'?'正在等待关键帧…':state==='recording'?'正在录制；停止后请下载保存。':'未录制');this.refresh();}
 recordingStopped(result){
  this.recording=false;
  if(result.blob){if(this.recordURL)URL.revokeObjectURL(this.recordURL);this.recordURL=URL.createObjectURL(result.blob);const link=this.$('record-download');link.href=this.recordURL;link.download='uficpy-'+Date.now()+'.mp4';link.hidden=false;link.textContent='下载录屏 · '+bytesLabel(result.bytes);}
  const reasons={user:'已停止',disconnected:'连接已中断','size-limit':'达到大小上限','time-limit':'达到时长上限','configuration-changed':'编码参数变化','timestamp-discontinuity':'时间戳变化','invalid-stream':'视频数据格式变化'};
  this.note('record-status',(reasons[result.reason]||'录制已停止')+(result.blob?'，片段已保留，请点击下载。':'，尚未收到可录制的关键帧。'));this.refresh();
 }
 audioState(state,detail){this.note('audio-status',detail||({enabled:'本页声音已开启',disabled:'本页已静音',playing:'正在播放设备声音'}[state]||state));}
}
