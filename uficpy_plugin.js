//<!-- [KANO_PLUGIN_START] uficpy_plugin.js -->
//<script>
// uficpy 2.2.2 — UFI-TOOLS plugin.
(async () => {
    'use strict';
    const version = '2.2.2', path = '/data/uficpy', boot = '/sdcard/ufi_tools_boot.sh';
    const defaultRepository='Ghostdehole/uficpy';
    const marker = '# UFICPY_V2_AUTOSTART';
    const oldBootLine = '(cd /data/uficpy && sh service.sh start)';
    const bootLine = `sh ${path}/service.sh start ${marker}`;
    const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const redact = s => String(s).replace(/[a-f0-9]{64}/gi, '[已隐藏摘要或令牌]').slice(0, 1000);
    const memory = new Map();
    const storage = {
        available: true,
        get(key) { if(memory.has(key))return memory.get(key);try { return localStorage.getItem(key); } catch { this.available=false;return null; } },
        set(key, value) { memory.set(key,value);try { value===null?localStorage.removeItem(key):localStorage.setItem(key,value); } catch { this.available=false;createToast('uficpy：浏览器禁止存储，此设置仅在当前页面有效','orange'); } }
    };
    try { localStorage.setItem('uficpy_storage_probe','1');localStorage.removeItem('uficpy_storage_probe'); } catch { storage.available=false; }
    function parseObject(text, label) {
        if (typeof text!=='string'||!text.trim()) throw Error(`${label}为空；请检查文件或接口返回内容`);
        let value;
        try { value=JSON.parse(text); } catch { throw Error(`${label}不是完整的 JSON；可能为空、截断或返回了 HTML。未应用任何配置。`); }
        if (!value||typeof value!=='object'||Array.isArray(value)) throw Error(`${label}必须是 JSON 对象`);
        return value;
    }
    function httpURL(value) {
        let u;try { u=new URL(value); } catch { throw Error('播放地址格式错误，请填写完整的 http://设备地址:端口/ 或 https://域名/'); }
        if (!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password) throw Error('播放地址必须为不含用户名和密码的 HTTP(S) 地址');
        return u;
    }
    if (document.getElementById('uficpy_CONTAINER')) return;
    for (let i = 0; i < 50 && !document.querySelector('.functions-container'); i++) await delay(200);
    const anchor = document.querySelector('.functions-container');
    if (!anchor || typeof runShellWithRoot !== 'function') throw Error('uficpy: UFI-TOOLS 插件接口不可用');
    let busy = false, expanded = false, lastError = '', initTimer;
    async function shell(command, timeout = 20000, phase = 'Root 命令') {
        const script = 'set -e\n[ "$(id -u)" = 0 ]\n' + command;
        // Official UFI-TOOLS caps Root commands at 100 seconds. Never retry a
        // mutation after an uncertain response: it may already have executed.
        let result;
        try { result=await runShellWithRoot(`sh -c ${q(script)} && printf '\\nUFICPY_OK\\n' || printf '\\nUFICPY_COMMAND_FAILED\\n'`, Math.min(timeout,90000)); }
        catch(e) { result={success:false,content:e?.message||String(e)}; }
        const text = typeof result?.content==='string'?result.content:'';
        if (result?.success!==true || !text.trimEnd().endsWith('UFICPY_OK')) {
            const bridge=result?.success!==true||!text.trimEnd().endsWith('UFICPY_COMMAND_FAILED');
            const e=Error(`${phase}：${bridge?'UFI-TOOLS 命令接口返回异常，请检查登录、设备连接与高级功能；操作结果需刷新状态确认。':'执行未成功，请检查高级功能与日志。'}${text?' 原始提示：'+redact(text.trim()):' 未收到有效命令结果。'}`);
            e.code=bridge?'UFI_BRIDGE':'UFI_COMMAND';
            e.downloadFailure=!bridge&&text.includes('UFICPY_DOWNLOAD_FAILED');throw e;
        }
        return text.replace(/\n?UFICPY_OK\s*$/, '').trim();
    }
    async function guarded(action, quiet=false) {
        if (busy) return;
        busy = true;
        root.querySelectorAll('button').forEach(b => b.disabled = true);
        try { await action();root.querySelector('#uficpy_error').textContent=''; }
        catch (e) {
            lastError=new Date().toISOString()+' · '+redact(e.message||e);
            root.querySelector('#uficpy_error').textContent=lastError;
            if (!quiet) createToast('uficpy：'+escape(redact(e.message||e)), 'red', 10000);
        }
        finally { busy = false; root.querySelectorAll('button').forEach(b => b.disabled = false); }
    }
    const readConfig = async () => parseObject(await shell(`timeout 2s awk '{print}' ${path}/config.json`,10000,'读取后端配置'),'后端 config.json');
    const service = action => shell(`sh ${path}/service.sh ${action}`, 30000, '服务 '+action);
    async function state() {
        const current=await shell(`if [ -f ${path}/service.sh ]; then sh ${path}/service.sh status; else echo missing; fi`,10000,'读取服务状态');
        if(!['missing','running','stopped'].includes(current))throw Error('服务状态返回异常，请检查旧版 service.sh 与部署目录');
        const running=current==='running';
        root.querySelector('#uficpy_status').textContent = `uficpy ${version} · ${current==='missing'?'未安装':running?'服务运行中':'服务已停止'}`;
        return running;
    }
    async function playerURL() {
        const c = await readConfig();
        if (!/^[a-f0-9]{64}$/.test(c.token || '')) throw Error('请先点击“检查部署”，初始化访问令牌');
        let host = location.hostname;
        if (!host && typeof UFI_DATA !== 'undefined') host = UFI_DATA?.lan_ipaddr;
        const custom = storage.get('uficpy_player_base');
        if (!custom&&(!host||!Number.isInteger(c.port)||c.port<1||c.port>65535)) throw Error('配置缺少有效的设备地址或端口，请检查 config.json 的 port 字段');
        if (host?.includes(':') && !host.startsWith('[')) host = `[${host}]`;
        const u = httpURL(custom || `${c.tls_cert ? 'https' : 'http'}://${host}:${c.port}/`);
        u.hash = new URLSearchParams({ token: c.token }).toString();
        return u.href;
    }
    async function render() {
        const url = await playerURL();
        if (location.protocol === 'https:' && url.startsWith('http:')) {
            frame.src = 'about:blank';
            throw Error('HTTPS 管理页不能嵌入 HTTP 播放器。请用“新窗口”打开，或配置可信 HTTPS 播放地址。');
        }
        frame.src = url;
    }
    async function updateBoot(enable) {
        // Prepare beside the destination, retain its metadata, then replace once.
        // A timeout or write failure leaves the original boot script untouched.
        await shell(`temp=$(mktemp ${boot}.uficpy.XXXXXX)
trap 'rm -f "$temp"' EXIT
if [ -f ${boot} ]; then
    cp -p ${boot} "$temp"
    timeout 2s awk -v old=${q(oldBootLine)} -v current=${q(bootLine)} '$0 != old && $0 != current {print}' ${boot} > "$temp"
else
    chmod 644 "$temp"
fi
${enable ? `printf '%s\\n' ${q(bootLine)} >> "$temp"` : ':'}
mv -f "$temp" ${boot}`);
    }
    function modal(options) {
        document.getElementById(options.name)?.remove();
        const result=createModal(options);
        if(!result?.el||!result.id)throw Error('UFI-TOOLS 弹窗容器未就绪，请等待管理页面加载完成');
        return result;
    }
    const dismiss = ({id,el}) => {
        // Host utils.js shares one close timer across all dialogs. Remove our
        // own node now so closing two dialogs cannot leave an invisible overlay.
        closeModal(id,0);el.remove();
    };
    function showText(title, text) {
        const { id } = modal({ name: 'uficpy_detail', title, maxWidth: '720px', showConfirm: false, onClose: () => true,
            content: `<pre style="white-space:pre-wrap;overflow:auto;max-height:65vh;user-select:text;font-size:12px">${escape(text)}</pre>` });
        showModal(id);
    }
    // Every UI write, including imported JSON, must pass the same opt-in gate.
    // A failed or cancelled acknowledgement never reaches the shell writer.
    function confirmVolumeKeys() {
        return new Promise(resolve => {
            let settled=false;
            const settle=value=>{if(!settled){settled=true;resolve(value);}};
            const phrase='我已确认设备音量键行为';
            const dialog=modal({name:'uficpy_volume_confirm',title:'确认启用音量键',maxWidth:'580px',showConfirm:false,onClose:()=>{settle(false);return true;},
                content:`<p><strong>部分 UFI 固件会将音量键绑定为恢复出厂设置等操作，可能造成数据丢失。</strong></p><p>uficpy 无法识别或拦截固件对音量键的特殊处理。开启前，请确认当前设备和固件的按键行为，并备份重要数据。后续更换固件时请重新确认。</p><p>输入“${phrase}”后才可启用：</p><input id="uficpy_volume_phrase" type="text" autocomplete="off" spellcheck="false" aria-label="音量键风险确认" style="width:100%;padding:8px;box-sizing:border-box"><p><button id="uficpy_volume_accept" type="button" disabled>确认启用音量键</button></p>`});
            const input=dialog.el.querySelector('#uficpy_volume_phrase'),accept=dialog.el.querySelector('#uficpy_volume_accept');
            input.oninput=()=>{accept.disabled=input.value.trim()!==phrase;};
            accept.onclick=()=>{if(input.value.trim()!==phrase)return;settle(true);dismiss(dialog);};
            showModal(dialog.id);input.focus();
        });
    }
    async function dangerSettings(onUpdated) {
        const current=await readConfig();
        const dialog=modal({name:'uficpy_danger',title:'危险功能',maxWidth:'580px',showConfirm:false,onClose:()=>true,
            content:`<p><strong>音量键</strong> · ${current.allow_volume_keys===true?'已启用':'未启用'}</p><p>部分 UFI 固件可能将音量键绑定为恢复出厂设置，造成数据丢失。只有确认当前设备按键行为后才应开启。</p><p>开启后，播放器“设置 → 高级控制 → 危险按键”中才可解锁音量控制。可随时在此关闭。</p><button id="uficpy_volume_toggle" type="button">${current.allow_volume_keys===true?'关闭音量键':'继续设置音量键'}</button>`});
        dialog.el.querySelector('#uficpy_volume_toggle').onclick=()=>guarded(async()=>{
            const c=await readConfig();c.allow_volume_keys=current.allow_volume_keys!==true;
            if(!await saveConfiguration(c))return;
            onUpdated?.(c);dismiss(dialog);createToast(c.allow_volume_keys?'音量键已启用':'音量键已关闭','green');
        });
        showModal(dialog.id);
    }
    async function saveConfiguration(c) {
        const previous=await readConfig();
        if(c.allow_volume_keys===true&&previous.allow_volume_keys!==true&&!await confirmVolumeKeys())return false;
        const staged=`${path}/config.next.${Date.now()}.json`;
        const running=await state();
        await shell(`umask 077
printf '%s\\n' ${q(JSON.stringify(c,null,2))} > ${staged}
${path}/uficpy -dir ${path} -config ${staged} -check
cp ${path}/config.json ${path}/config.previous.json
mv ${staged} ${path}/config.json`);
        frame.src='about:blank';
        try { if(running) await service('restart'); }
        catch(e) {
            if(e.code==='UFI_BRIDGE')throw Error('新配置已写入，但重启响应异常，运行结果未知。请先刷新状态、检查日志，不自动覆盖配置或重复重启。'+e.message);
            await shell(`cp ${path}/config.previous.json ${path}/config.json`);if(running)await service('start');throw Error('新配置启动失败，已恢复旧配置：'+e.message);
        }
        await state();if(running&&expanded)await render();return true;
    }
    async function configModal() {
        const conf=await readConfig();
        const fields=[
            ['max_size','最大长边（0 = 原生尺寸）','number'],['max_fps','帧率上限（0 = 不限制）','number'],
            ['bit_rate','码率 bit/s','number'],['video_encoder','H.264 编码器（空 = 系统选择）','text'],
            ['video_codec_options','MediaCodec 参数（保留 max-bframes=0）','text'],['display_id','显示屏 ID','number'],
            ['crop','裁剪 width:height:x:y（空 = 全屏）','text'],['capture_orientation','方向 0/90/180/270，可加 @ 锁定','text'],
            ['port','服务端口','number'],['listen','监听地址','text'],['max_clients','最大客户端数','number'],
            ['queue_mb','每客户端队列上限 MiB','number'],['gop_mb','关键帧缓存上限 MiB','number'],['idle_seconds','无人观看后停止采集的秒数','number'],
            ['wm_size','系统显示覆盖尺寸（单独应用才生效）','text'],['wm_density','系统 DPI（0 = 不修改）','number']
        ];
        const inputs=keys=>fields.filter(([key])=>keys.includes(key)).map(([key,label,type])=>`<label>${label}<input data-field="${key}" type="${type}" value="${escape(conf[key]??'')}" style="display:block;width:100%;padding:7px;box-sizing:border-box"></label>`).join('');
        const grid=content=>`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0">${content}</div>`;
        const {id,el}=modal({name:'uficpy_config',title:'投屏设置',maxWidth:'780px',showConfirm:false,onClose:()=>true,
        content:`<div style="font-size:13px;line-height:1.7;max-height:72vh;overflow:auto;padding-right:4px">
        <div style="display:flex;gap:7px;flex-wrap:wrap"><button data-preset="eco">节能</button><button data-preset="balanced">平衡</button><button data-preset="quality">高画质</button><button data-preset="native">原生尺寸</button></div>
        ${grid(inputs(['max_size','max_fps','bit_rate']))}
        <label><input type="checkbox" data-field="read_only" ${conf.read_only?'checked':''}> 只读投屏</label>
        <details style="margin:14px 0"><summary>编码与采集</summary>${grid(inputs(['video_encoder','video_codec_options','display_id','crop','capture_orientation']))}<label><input type="checkbox" data-field="downsize_on_error" ${conf.downsize_on_error?'checked':''}> 编码失败时允许降低分辨率</label><p>设为原生尺寸或不限帧率时，实际表现取决于设备、网络和浏览器。</p></details>
        <details style="margin:14px 0"><summary>连接与资源</summary>${grid(inputs(['port','listen','max_clients','queue_mb','gop_mb','idle_seconds']))}<p>修改端口后，播放器将使用新的连接地址。</p></details>
        <details style="margin:14px 0"><summary>系统显示</summary>${grid(inputs(['wm_size','wm_density']))}<p>保存仅记录尺寸和 DPI；在“管理与诊断 → 应用系统显示”中单独应用，影响设备上的所有应用。</p></details>
        <button id="uficpy_save">保存设置</button></div>`});
        const field=k=>el.querySelector(`[data-field="${k}"]`);
        el.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{const presets={eco:[1280,30,4000000],balanced:[1920,60,12000000],quality:[2560,60,24000000],native:[0,0,40000000]};['max_size','max_fps','bit_rate'].forEach((k,i)=>field(k).value=presets[b.dataset.preset][i]);});
        el.querySelector('#uficpy_save').onclick=()=>guarded(async()=>{const c={...conf,no_audio:true};for(const [k,,type]of fields)c[k]=type==='number'?Number(field(k).value):field(k).value.trim();for(const k of ['downsize_on_error','read_only'])c[k]=field(k).checked;if(!await saveConfiguration(c))return;dismiss({id,el});createToast('配置已应用','green');});showModal(id);
    }
    async function advancedConfig() {
        const c=await readConfig();const {id,el}=modal({name:'uficpy_json',title:'完整 JSON 配置',maxWidth:'820px',showConfirm:false,onClose:()=>true,
        content:`<p>所有支持字段均可编辑，包括 TLS、token 和按键白名单。包含访问令牌，请勿公开。未知字段和不支持的参数会被拒绝。</p><textarea id="uficpy_json_input" spellcheck="false" style="width:100%;height:48vh"></textarea><button id="uficpy_json_save">校验、保存并重启</button><button id="uficpy_export">导出配置</button><button id="uficpy_danger_open" type="button">危险功能</button><label>导入 JSON <input id="uficpy_import" type="file" accept="application/json,.json"></label>`});
        const area=el.querySelector('#uficpy_json_input');area.value=JSON.stringify(c,null,2);
        el.querySelector('#uficpy_json_save').onclick=()=>guarded(async()=>{if(!await saveConfiguration(parseObject(area.value,'输入配置')))return;dismiss({id,el});createToast('已保存','green');});
        el.querySelector('#uficpy_danger_open').onclick=()=>guarded(()=>dangerSettings(updated=>{
            try { const edited=JSON.parse(area.value);edited.allow_volume_keys=updated.allow_volume_keys;area.value=JSON.stringify(edited,null,2); } catch { /* Preserve an unfinished edit. Saving it still requires validation. */ }
        }));
        el.querySelector('#uficpy_export').onclick=()=>{const u=URL.createObjectURL(new Blob([area.value],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='uficpy-config.private.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
        el.querySelector('#uficpy_import').onchange=e=>guarded(async()=>{const f=e.target.files[0];if(!f)return;if(f.size>65536)throw Error('配置文件不能超过 64 KiB');area.value=JSON.stringify(parseObject(await f.text(),'导入配置'),null,2);});showModal(id);
    }
    function validRepository(repo){return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)&&repo.split('/').every(part=>part!=='.'&&part!=='..');}
    function repository(){const repo=storage.get('uficpy_repository')||defaultRepository;if(!validRepository(repo))throw Error('仓库格式应为 owner/repo');return repo;}
    function mirrorURL(value){
        if(/[\u0000-\u001f\u007f]/.test(value))throw Error('备用源地址不能包含控制字符');
        value=value.trim();if(!value)return '';
        let u;try { u=new URL(value); } catch { throw Error('备用源地址格式错误，请填写完整的 HTTPS 目录地址'); }
        if(u.protocol!=='https:'||!u.hostname||u.username||u.password||/[\s\\?#]/.test(value))throw Error('备用源必须为 HTTPS 地址，不能包含账号、密码、空格、查询参数或片段');
        if(u.pathname.endsWith('/release.json'))throw Error('请填写 release.json 所在的目录，不要填写文件地址');
        return u.origin+u.pathname.replace(/\/+$/,'');
    }
    function sourceSettings(){
        const repo=repository(),mirror=mirrorURL(storage.get('uficpy_mirror_base')||'');
        let policy=storage.get('uficpy_download_policy')||'github-first';
        if(!['github-first','mirror-first','mirror-only'].includes(policy))throw Error('下载顺序无效，请在“发布源”中重新保存设置');
        if(!mirror&&policy==='mirror-only')throw Error('仅备用源模式需要填写备用源地址');
        if(!mirror)policy='github-first';
        const github={name:'GitHub',manifest:`https://github.com/${repo}/releases/latest/download/release.json`,asset:(tag,name)=>`https://github.com/${repo}/releases/download/${tag}/${name}`};
        const backup={name:'备用源',manifest:mirror+'/release.json',asset:(tag,name)=>`${mirror}/releases/${tag}/${name}`};
        return {repo,sources:!mirror?[github]:policy==='mirror-only'?[backup]:policy==='mirror-first'?[backup,github]:[github,backup]};
    }
    function sourceModal(){
        const dialog=modal({name:'uficpy_sources',title:'发布源',maxWidth:'640px',showConfirm:false,onClose:()=>true,
            content:`<div style="font-size:13px;line-height:1.7"><label for="uficpy_source_repository">GitHub 仓库</label><input id="uficpy_source_repository" type="text" autocomplete="off" spellcheck="false" style="display:block;width:100%;padding:8px;box-sizing:border-box"><p><label for="uficpy_mirror_base">备用后端下载源（可选）</label><input id="uficpy_mirror_base" type="url" autocomplete="off" spellcheck="false" placeholder="https://download.doevt.top/uficpy" style="display:block;width:100%;padding:8px;box-sizing:border-box"></p><p>填写存放 release.json 的 HTTPS 目录，留空使用 GitHub。只添加自己管理或信任的服务器；该服务器提供的程序将以 Root 权限安装。</p><label for="uficpy_download_policy">下载顺序</label><select id="uficpy_download_policy" style="display:block;width:100%;padding:8px;box-sizing:border-box"><option value="github-first">GitHub 优先，失败后尝试备用源</option><option value="mirror-first">备用源优先，失败后尝试 GitHub</option><option value="mirror-only">仅备用源</option></select><p>优先或仅使用备用源时，安装服务器已同步的版本。切换下载源时保持同一版本；清单或校验不通过时会停止安装。设置只保存在当前浏览器。</p><p id="uficpy_source_error" role="alert" style="color:#c94c4c;overflow-wrap:anywhere"></p><button id="uficpy_source_save" type="button">保存发布源</button></div>`});
        const field=id=>dialog.el.querySelector('#'+id);
        field('uficpy_source_repository').value=storage.get('uficpy_repository')||defaultRepository;
        field('uficpy_mirror_base').value=storage.get('uficpy_mirror_base')||'';
        field('uficpy_download_policy').value=storage.get('uficpy_download_policy')||'github-first';
        field('uficpy_source_save').onclick=()=>{
            try {
                const repo=field('uficpy_source_repository').value.trim(),mirror=mirrorURL(field('uficpy_mirror_base').value);
                let policy=field('uficpy_download_policy').value;
                if(!validRepository(repo))throw Error('仓库格式应为 owner/repo');
                if(!['github-first','mirror-first','mirror-only'].includes(policy))throw Error('请选择下载顺序');
                if(!mirror&&policy==='mirror-only')throw Error('仅备用源模式需要填写备用源地址');
                if(!mirror)policy='github-first';
                storage.set('uficpy_repository',repo);storage.set('uficpy_mirror_base',mirror||null);storage.set('uficpy_download_policy',policy);
                dismiss(dialog);createToast('发布源已保存','green');
            } catch(e) { field('uficpy_source_error').textContent=e.message; }
        };
        showModal(dialog.id);
    }
    const curlSetup=`if command -v curl >/dev/null 2>&1; then CURL=curl; elif [ -x /data/data/com.minikano.f50_sms/files/curl ]; then CURL=/data/data/com.minikano.f50_sms/files/curl; else echo '设备缺少 curl，请安装支持 HTTPS 的 curl'; exit 1; fi`;
    async function installLatest(fresh=false){
        const {repo,sources}=sourceSettings();let manifest,selected;
        for(let i=0;i<sources.length;i++){
            const source=sources[i];createToast(`正在从 ${source.name} 获取发布清单…`,'',10000);
            let payload;
            try { payload=await shell(`${curlSetup}
"$CURL" -fLsS --globoff --proto '=https' --proto-redir '=https' --connect-timeout 8 --max-time 20 -H 'Cache-Control: no-cache' ${q(source.manifest)} || { printf '\\nUFICPY_DOWNLOAD_FAILED\\n'; exit 1; }`,30000,`获取 ${source.name} 发布清单`); }
            catch(e){
                if(!e.downloadFailure)throw e;
                if(i+1===sources.length)throw Error('无法获取发布清单，请检查发布源地址、文件和设备网络。'+e.message);
                createToast(`${source.name} 下载失败，正在尝试 ${sources[i+1].name}…`,'orange',10000);continue;
            }
            if(payload.length>65536)throw Error(`${source.name} 发布清单超过 64 KiB，已停止安装`);
            manifest=parseObject(payload,source.name+' 发布清单');selected=source;break;
        }
        const a=manifest.assets?.arm64;
        if(manifest.schema!==1||manifest.repository!==repo||typeof manifest.tag!=='string'||!/^[A-Za-z0-9_.-]{1,120}$/.test(manifest.tag)||['.','..'].includes(manifest.tag)||a?.name!=='uficpy-arm64.tar.gz'||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isInteger(a.size)||a.size<1024||a.size>134217728)throw Error(`${selected.name} 发布清单不符合要求，请检查仓库、版本和文件摘要；已停止安装`);
        createToast(`正在下载并校验 ${escape(manifest.version)} / scrcpy ${escape(manifest.scrcpy_version)}，完成后自动安装…`,'',20000);
        frame.src='about:blank';const temp='/data/local/tmp/uficpy-download-'+Date.now()+'-'+Math.random().toString(36).slice(2,10);
        let created=false,uncertain=false,result;
        try {
            await shell(`${curlSetup}
case "$(uname -m)" in aarch64|arm64) :;; *) echo '当前发布包仅支持 ARM64'; exit 1;; esac
umask 077
mkdir ${q(temp)}`,10000,'准备后端下载目录');
            created=true;
            const downloads=[selected,...sources.filter(source=>source!==selected)];
            for(let i=0;i<downloads.length;i++){
                const source=downloads[i];
                try {
                    await shell(`${curlSetup}
cd ${q(temp)}
rm -f package.tar.gz
"$CURL" -fLsS --globoff --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 55 ${q(source.asset(manifest.tag,a.name))} -o package.tar.gz || { printf '\\nUFICPY_DOWNLOAD_FAILED\\n'; exit 1; }`,75000,`从 ${source.name} 下载后端包`);
                    break;
                } catch(e){
                    if(!e.downloadFailure)throw e;
                    if(i+1===downloads.length)throw Error(`无法下载 ${manifest.tag}。${sources.some(source=>source.name==='备用源')?'请确认该版本的后端包已同步到备用源；不会改装其他版本。':'请检查设备网络和 Release 资源。'}`+e.message);
                    createToast(`${source.name} 下载失败，改用 ${downloads[i+1].name} 下载同一版本 ${escape(manifest.tag)}…`,'orange',10000);
                }
            }
            await shell(`cd ${q(temp)}
[ "$(wc -c < package.tar.gz | tr -d ' ')" = ${q(a.size)} ]
printf '%s\\n' ${q(a.sha256+'  package.tar.gz')} > checksum
sha256sum -c checksum
tar -tzf package.tar.gz > entries
awk 'BEGIN{ok=1} $0 !~ /^(uficpy|scrcpy-server\\.jar|core-lock\\.json|version\\.txt|VERSION|config\\.json|service\\.sh|install\\.sh|uninstall\\.sh|uficpy_plugin\\.js|README\\.md|THIRD_PARTY_NOTICES\\.md|release-tag\\.txt|licenses\\/(scrcpy-Apache-2\\.0\\.txt|gorilla-websocket-BSD-2-Clause\\.txt))$/ {ok=0} END{exit !ok}' entries
tar -tvzf package.tar.gz > types
awk '$1 !~ /^-/ {bad=1} END{exit bad}' types
mkdir extracted
tar -xzf package.tar.gz -C extracted`,30000,'校验并解压后端包');
            result=await shell(`cd ${q(temp)}
sh extracted/install.sh ${fresh?'--fresh':''}`,90000,'安装后端（若响应中断，请先刷新状态，勿重复安装）');
        } catch(e) { uncertain=e.code==='UFI_BRIDGE';throw e; }
        finally {
            if(created&&!uncertain){
                try { await shell(`rm -rf ${q(temp)}`,10000,'清理下载临时文件'); }
                catch(e) { createToast('临时文件清理未确认，可稍后清理 '+escape(temp),'orange',10000); }
            }
        }
        showText('安装结果',result);await state();if(expanded)await render();
    }
    anchor.insertAdjacentHTML('afterend', `<div id="uficpy_CONTAINER" style="margin-top:12px">
        <div class="title"><strong id="uficpy_status">uficpy ${version} · 等待管理页就绪</strong> <span id="collapse_uficpy_btn"></span></div>
        <p id="uficpy_error" role="status" style="font-size:12px;color:#c94c4c;overflow-wrap:anywhere"></p>
        <div class="collapse" id="collapse_uficpy" data-name="close" style="height:0;overflow:hidden"><div class="collapse_box">
        <div id="uficpy_actions" style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px"></div><details style="margin-bottom:10px"><summary style="cursor:pointer">管理与诊断</summary><div id="uficpy_advanced" style="padding:6px 0"><p style="font-size:12px;margin:10px 0 6px">服务管理</p><div id="uficpy_manage" style="display:flex;gap:7px;flex-wrap:wrap"></div><p style="font-size:12px;margin:12px 0 6px">高级设置</p><div id="uficpy_settings" style="display:flex;gap:7px;flex-wrap:wrap"></div><p style="font-size:12px;margin:12px 0 6px">诊断</p><div id="uficpy_diagnostics" style="display:flex;gap:7px;flex-wrap:wrap"></div></div></details>
        <iframe id="uficpy_iframe" src="about:blank" allow="autoplay; fullscreen" style="border:0;width:100%;height:75vh;min-height:420px;background:#080c12;border-radius:10px"></iframe>
        </div></div></div>`);
    const root = document.getElementById('uficpy_CONTAINER'), frame = document.getElementById('uficpy_iframe');
    function button(label, action) {
        const b=document.createElement('button');b.className='btn';b.textContent=label;b.onclick=()=>guarded(action);
        const groups={
            uficpy_manage:['安装 / 更新','全新安装','重启','开机自启','卸载后端'],
            uficpy_settings:['发布源','高级 JSON','应用系统显示','播放地址','恢复显示'],
            uficpy_diagnostics:['检查部署','编码器 / 显示屏','日志','错误详情']
        };
        const target=Object.keys(groups).find(key=>groups[key].includes(label))||'uficpy_actions';root.querySelector('#'+target).appendChild(b);
    }
    button('安装 / 更新',()=>installLatest(false));
    button('全新安装',async()=>{if(confirm('全新安装将使用默认配置并生成新 token；旧目录暂存为备份。继续？'))await installLatest(true);});
    button('发布源',sourceModal);
    button('刷新状态',async()=>{clearTimeout(initTimer);if(await state()&&expanded)await render();});
    button('检查部署', async () => {
        await shell(`test -x ${path}/uficpy && test -f ${path}/service.sh
${path}/uficpy -dir ${path} -init
${path}/uficpy -dir ${path} -check`);
        createToast('配置、访问令牌及配套 JAR 检查通过；可启动服务', 'green'); await state();
    });
    button('启动', async () => { await service('start'); await state(); if (expanded) await render(); });
    button('停止', async () => { frame.src = 'about:blank'; await service('stop'); await state(); });
    button('重启', async () => { frame.src = 'about:blank'; await service('restart'); await state(); if (expanded) await render(); });
    button('参数', configModal);
    button('高级 JSON',advancedConfig);
    button('编码器 / 显示屏',async()=>showText('设备能力',await shell(`${path}/uficpy -dir ${path} -list-encoders
${path}/uficpy -dir ${path} -list-displays`,45000)));
    button('应用系统显示',async()=>{if(confirm('将按配置修改 Android 系统显示尺寸 / DPI，影响所有应用。继续？')){await shell(`${path}/uficpy -dir ${path} -apply-display`);createToast('系统显示设置已应用','green');}});
    button('新窗口', async () => {
        // Open during the click gesture, before the async config read.
        const tab = window.open('about:blank', '_blank'); if (!tab) throw Error('弹出窗口被拦截，请允许此站点打开新窗口');
        tab.opener = null; try { tab.location.href = await playerURL(); } catch (e) { tab.close(); throw e; }
    });
    button('播放地址', async () => {
        const address = prompt('可选：填写直达播放器的 HTTP(S) 地址。留空使用当前设备域名及配置端口。反向代理需同时代理 /ws。', storage.get('uficpy_player_base') || '');
        if (address === null) return;
        if (address.trim()) { const u = httpURL(address.trim());storage.set('uficpy_player_base',u.origin+'/'); }
        else storage.set('uficpy_player_base',null);
        createToast('播放地址已保存', 'green');
    });
    button('开机自启', async () => {
        const enabled = (await shell(`if [ -f ${boot} ] && { grep -qxF ${q(bootLine)} ${boot} || grep -qxF ${q(oldBootLine)} ${boot}; then echo yes; else echo no; fi`)) === 'yes';
        await updateBoot(!enabled); createToast(enabled ? '已关闭自启' : '已开启自启', 'green');
    });
    button('日志', async () => showText('uficpy 日志', await shell(`timeout 2s tail -n 120 ${path}/uficpy.log`,10000,'读取日志')));
    button('错误详情',async()=>showText('uficpy 最近错误',lastError||'本页尚未记录 uficpy 错误。若顶部仍报错，请查看 UFI-TOOLS 控制台和失败请求。'));
    button('恢复显示', async () => { await shell(`${path}/uficpy -dir ${path} -restore-display`); createToast('已恢复首次修改前的显示覆盖值', 'green'); });
    button('卸载后端',async()=>{
        if(!confirm('停止并删除后端、配置、自启及全部 uficpy 旧备份？管理插件仍保留，可重新安装。'))return;
        frame.src='about:blank';await shell(`sh ${path}/uninstall.sh --purge-backups`,60000);await state();createToast('后端已完整卸载','green');
    });
    const hostReady = () => typeof UFI_DATA==='undefined'||UFI_DATA?.loginfo==='ok';
    collapseGen('#collapse_uficpy_btn', '#collapse_uficpy', storage.available?'#collapse_uficpy':null, stateValue => {
        expanded = stateValue === 'open';
        if (expanded&&hostReady()) guarded(async () => { clearTimeout(initTimer);if (await state()) await render(); }); else frame.src = 'about:blank';
    });
    expanded = root.querySelector('#collapse_uficpy').dataset.name === 'open';
    let polls=0;
    function initialize() {
        if(!root.isConnected)return;
        if(!hostReady()) {
            root.querySelector('#uficpy_status').textContent=`uficpy ${version} · 等待登录`;
            if(++polls<120)initTimer=setTimeout(initialize,1000);
            return;
        }
        if(busy){initTimer=setTimeout(initialize,500);return;}
        guarded(async()=>{if(await state()&&expanded)await render();},true);
    }
    initialize();
    window.addEventListener('pagehide',()=>clearTimeout(initTimer),{once:true});
})().catch(e => { console.error('uficpy:', e); if (typeof createToast === 'function') createToast('uficpy 插件加载失败，请查看控制台', 'red'); });
//</script>
//<!-- [KANO_PLUGIN_END] uficpy_plugin.js -->
