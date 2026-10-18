import {nals} from './h264.mjs';
import {initSegment,fragment} from './mp4.mjs';

const MAX_SAMPLE_DURATION=0xffffffff;
const equal=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);

// Locate the duration field rather than depending on the muxer's box sizes.
function durationOffset(bytes,start=0,end=bytes.length){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 for(let at=start;at+8<=end;){
  const size=view.getUint32(at),type=String.fromCharCode(...bytes.subarray(at+4,at+8));
  if(size<8||at+size>end)throw Error('无效的 MP4 片段');
  if(type==='trun'){
   const flags=view.getUint32(at+8)&0xffffff;
   if(!(flags&0x100)||view.getUint32(at+12)!==1)throw Error('MP4 片段缺少单帧时长');
   return at+16+((flags&1)?4:0)+((flags&4)?4:0);
  }
  if(type==='moof'||type==='traf'){
   const found=durationOffset(bytes,at+8,at+size);if(found!==null)return found;
  }
  at+=size;
 }
 return null;
}

/** Records the received H.264 stream without decoding or transcoding. No audio track. */
export class Recorder {
 constructor({maxBytes=128*1024*1024,maxDurationMs=30*60*1000,defaultFrameDurationUs=33333,onstate,onstop}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('录屏大小限制无效');
  if(!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1||maxDurationMs>0x7fffffff)throw Error('录屏时长限制无效');
  if(!Number.isSafeInteger(defaultFrameDurationUs)||defaultFrameDurationUs<1||defaultFrameDurationUs>MAX_SAMPLE_DURATION)throw Error('录屏默认帧时长无效');
  this.maxBytes=maxBytes;this.maxDurationMs=maxDurationMs;this.defaultFrameDurationUs=defaultFrameDurationUs;
  this.onstate=onstate;this.onstop=onstop;this.state='idle';this.result=null;
  this.bytes=0;this.frames=0;this.durationUs=0;this.parts=[];this.pending=null;this.timer=null;
 }
 get active(){return this.state==='waiting'||this.state==='recording';}
 get status(){return {state:this.state,bytes:this.bytes,frames:this.frames,durationUs:this.durationUs};}
 start(){
  if(this.active)throw Error('录屏已经开始');
  this.result=null;this.parts=[];this.pending=null;this.sps=null;this.pps=null;this.base=null;
  this.bytes=0;this.frames=0;this.durationUs=0;this.lastDurationUs=this.defaultFrameDurationUs;
  this.state='waiting';
  this.timer=setTimeout(()=>this.stop('time-limit'),this.maxDurationMs);this.timer.unref?.();
  this.onstate?.(this.status);return this.status;
 }
 push(packet,sps,pps){
  if(!this.active)return false;
  if(!(packet?.data instanceof Uint8Array)){this.stop('invalid-stream');return false;}
  const units=nals(packet.data);
  for(const unit of units){if((unit[0]&31)===7)sps=unit;if((unit[0]&31)===8)pps=unit;}
  if((sps&&this.sps&&!equal(sps,this.sps))||(pps&&this.pps&&!equal(pps,this.pps))){
   if(this.state==='recording'){this.stop('configuration-changed');return false;}
  }
  if(sps)this.sps=Uint8Array.from(sps);if(pps)this.pps=Uint8Array.from(pps);
  if(packet.config||!units.some(unit=>[1,5].includes(unit[0]&31)))return false;
  const key=units.some(unit=>(unit[0]&31)===5);
  if(!this.sps||!this.pps||(this.state==='waiting'&&!key))return false;
  if(!Number.isSafeInteger(packet.pts)||packet.pts<0){this.stop('invalid-stream');return false;}
  if(this.pending){
   const duration=packet.pts-this.pending.pts;
   if(duration<=0||duration>MAX_SAMPLE_DURATION){this.stop('timestamp-discontinuity');return false;}
   const remaining=this.maxDurationMs*1000-(this.pending.pts-this.base);
   this.finalizePending(Math.min(duration,remaining));this.lastDurationUs=duration;
   if(packet.pts-this.base>=this.maxDurationMs*1000){this.stop('time-limit');return false;}
  }
  const first=this.state==='waiting',base=first?packet.pts:this.base;
  let header,chunk,offset;
  try{
   if(first)header=initSegment(this.sps,this.pps);
   chunk=fragment(packet.data,key,packet.pts-base,this.defaultFrameDurationUs,this.frames+1);
   offset=durationOffset(chunk);
   if(offset===null)throw Error('MP4 片段缺少时长');
  }catch{this.stop('invalid-stream');return false;}
  if(this.bytes+(header?.length||0)+chunk.length>this.maxBytes){this.stop('size-limit');return false;}
  if(first){this.base=base;this.parts.push(header);this.bytes+=header.length;this.state='recording';}
  this.parts.push(chunk);this.bytes+=chunk.length;this.frames++;
  this.pending={chunk,offset,pts:packet.pts};
  if(first)this.onstate?.(this.status);
  if(this.bytes===this.maxBytes)this.stop('size-limit');
  return true;
 }
 finalizePending(duration){
  if(!this.pending)return;
  const {chunk,offset,pts}=this.pending;
  new DataView(chunk.buffer,chunk.byteOffset,chunk.byteLength).setUint32(offset,duration);
  this.durationUs=pts-this.base+duration;this.pending=null;
 }
 stop(reason='user'){
  if(!this.active)return this.result;
  clearTimeout(this.timer);this.timer=null;
  if(this.pending){
   const remaining=this.maxDurationMs*1000-(this.pending.pts-this.base);
   this.finalizePending(Math.min(this.lastDurationUs,remaining));
  }
  const blob=this.frames?new Blob(this.parts,{type:'video/mp4'}):null;
  this.result={blob,reason,frames:this.frames,bytes:this.bytes,durationUs:this.durationUs};
  this.parts=[];this.pending=null;this.sps=this.pps=null;this.state='stopped';
  this.onstate?.(this.status);this.onstop?.(this.result);return this.result;
 }
}
