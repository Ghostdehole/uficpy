import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadFile} from '../web/transfers.mjs';

function setup(install=true){
 const events=[],xhr={upload:{},headers:{},open(method,url){this.method=method;this.url=url;},setRequestHeader(key,value){this.headers[key]=value;},send(body){this.body=body;},abort(){events.push('aborted');this.onabort();}};
 const file={name:'测试 app.apk',size:42};
 const task=uploadFile({file,install,token:'a'.repeat(64),xhrFactory:()=>xhr,onProgress:(loaded,total)=>events.push([loaded,total]),onUploaded:()=>events.push('uploaded')});
 return {xhr,task,file,events};
}
test('raw file upload keeps credentials out of URL and never reads file into memory',async()=>{
 const {xhr,task,file,events}=setup();
 assert.equal(xhr.method,'POST');assert.equal(xhr.url,'/api/install?name='+encodeURIComponent(file.name));
 assert.equal(xhr.headers.Authorization,'Bearer '+'a'.repeat(64));assert.equal(xhr.body,file);
 xhr.upload.onprogress({loaded:21,total:42,lengthComputable:true});xhr.upload.onload();
 assert.equal(task.uploaded,true);task.cancel();assert.deepEqual(events,[[21,42],'uploaded']);
 xhr.status=200;xhr.responseText=JSON.stringify({ok:true,message:'Success'});xhr.onload();
 assert.equal((await task.promise).ok,true);
});
test('upload cancel is explicit and cannot cancel once installation may have started',async()=>{
 const {task,events}=setup();const rejected=assert.rejects(task.promise,/已取消上传/);task.cancel();await rejected;assert.deepEqual(events,['aborted']);
 task.cancel();assert.equal(events.length,1);
});
test('failure and malformed responses never report success or replay the request',async()=>{
 for(const response of [{status:422,body:{error:'签名不匹配',detail:'INSTALL_FAILED_UPDATE_INCOMPATIBLE'},error:/INSTALL_FAILED_UPDATE_INCOMPATIBLE/},{status:504,body:{error:'安装超时',status_unknown:true},error:/结果未知/},{status:200,text:'',error:/响应不完整/},{status:200,text:'<html>login</html>',error:/响应不完整/},{status:200,body:{message:'missing ok'},error:/请求失败/}]){
  const {xhr,task}=setup();xhr.status=response.status;xhr.responseText=response.text??JSON.stringify(response.body);
  xhr.onload();await assert.rejects(task.promise,response.error);
 }
});
test('network interruptions leave installation result explicitly unknown',async()=>{
 for(const event of ['onerror','ontimeout']){const {xhr,task}=setup();xhr[event]();await assert.rejects(task.promise,/安装结果未知/);}
 const {xhr,task}=setup(false);assert.match(xhr.url,/^\/api\/files\?/);xhr.onerror();await assert.rejects(task.promise,/检查设备目录/);
});
