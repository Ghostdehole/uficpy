// Raw uploads are streamed by the server; never read the whole APK into JS memory.
export function uploadFile({file,install,token,onProgress=()=>{},onUploaded=()=>{},xhrFactory=()=>new XMLHttpRequest()}){
 const xhr=xhrFactory();let uploaded=false,finished=false;
 const promise=new Promise((resolve,reject)=>{
  const finish=(error,result)=>{if(finished)return;finished=true;error?reject(error):resolve(result);};
  xhr.open('POST',`${install?'/api/install':'/api/files'}?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader('Authorization','Bearer '+token);
  xhr.setRequestHeader('Content-Type',install?'application/vnd.android.package-archive':'application/octet-stream');
  xhr.timeout=14*60*1000;
  xhr.upload.onprogress=e=>onProgress(e.loaded,e.lengthComputable?e.total:file.size);
  xhr.upload.onload=()=>{uploaded=true;onUploaded();};
  xhr.onload=()=>{
   let result;try{result=JSON.parse(xhr.responseText);}catch{finish(Error(install?'安装响应不完整，结果未知。请先检查设备，勿重复安装。':'上传响应不完整，请先检查设备文件目录。'));return;}
   if(xhr.status<200||xhr.status>=300||result.ok!==true){
    const detail=typeof result.detail==='string'?'\n'+result.detail:'';
    finish(Error((result.error||`请求失败（HTTP ${xhr.status}）`)+detail+(result.status_unknown?'\n安装结果未知，请先检查设备。':'')));return;
   }
   finish(null,result);
  };
  const interrupted=()=>finish(Error(install?'连接中断，安装结果未知。请先检查设备应用列表，勿自动重试。':'连接中断，请检查设备目录后再上传。'));
  xhr.onerror=interrupted;xhr.ontimeout=interrupted;
  xhr.onabort=()=>finish(Error(uploaded?'请求已中断，请检查设备上的操作结果。':'已取消上传；若设备已收到完整文件，请检查操作结果。'));
  xhr.send(file);
 });
 return {promise,cancel(){if(!uploaded&&!finished)xhr.abort();},get uploaded(){return uploaded;}};
}
