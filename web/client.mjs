// Read the entire body within the timeout; never expose a token or response body
// in errors. Firmware/proxy failures may return HTML, empty or truncated bodies.
export async function fetchClientOptions(token, fetcher=fetch) {
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try {
  const response=await fetcher('/api/client',{headers:{Authorization:'Bearer '+token},signal:controller.signal,cache:'no-store'});
  if(!response.ok)throw Error([401,403].includes(response.status)?'播放器授权失败，请重新从管理插件打开':`播放器 /api/client 返回 HTTP ${response.status}，请检查服务或反向代理`);
  const text=await response.text();
  if(!text.trim())throw Error('播放器 /api/client 返回空内容，请检查服务或反向代理');
  let options;try {options=JSON.parse(text);}catch {throw Error('播放器 /api/client 未返回完整 JSON，请检查服务或反向代理');}
  if(!options||typeof options.read_only!=='boolean'||!Array.isArray(options.allowed_keys)||!options.allowed_keys.every(Number.isInteger)||typeof options.allow_volume_keys!=='boolean')throw Error('播放器 /api/client 配置格式不兼容，请配套更新后端与播放器');
  return options;
 } catch(e) {
  if(e?.name==='AbortError')throw Error('播放器 /api/client 请求超过 10 秒，请检查设备连接');
  throw e;
 } finally {clearTimeout(timer);}
}
