import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {nals,annex} from '../web/h264.mjs';
import {initSegment,fragment} from '../web/mp4.mjs';
import {Recorder} from '../web/recorder.mjs';

const fixture=new URL('./fixtures/sample.h264',import.meta.url);
const units=nals(fs.readFileSync(fixture));
const sps=units.find(n=>(n[0]&31)===7),pps=units.find(n=>(n[0]&31)===8);
const frames=[];let current=[];
for(const unit of units){
 if((unit[0]&31)===9&&current.length){frames.push(annex(...current));current=[];}
 current.push(unit);
}
if(current.length)frames.push(annex(...current));
const packet=(index,pts=index*33333)=>({data:frames[index],pts,config:false,key:index===0});
const firstBytes=initSegment(sps,pps).length+fragment(frames[0],true,0,33333,1).length;

function boxes(bytes,start=0,end=bytes.length){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),result=[];
 for(let at=start;at<end;){
  assert.ok(at+8<=end);const size=view.getUint32(at),type=String.fromCharCode(...bytes.subarray(at+4,at+8));
  assert.ok(size>=8&&at+size<=end,`invalid ${type} size`);
  result.push({at,size,type});at+=size;
 }
 return result;
}
async function samples(blob){
 const bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer);
 return boxes(bytes).filter(b=>b.type==='moof').map(moof=>{
  const traf=boxes(bytes,moof.at+8,moof.at+moof.size).find(b=>b.type==='traf');
  const children=boxes(bytes,traf.at+8,traf.at+traf.size);
  const trun=children.find(b=>b.type==='trun'),tfdt=children.find(b=>b.type==='tfdt');
  return {pts:Number(view.getBigUint64(tfdt.at+12)),duration:view.getUint32(trun.at+20),flags:view.getUint32(trun.at+28)};
 });
}

test('recording waits for real IDR and produces no file before a keyframe',()=>{
 const states=[],stops=[],recorder=new Recorder({onstate:s=>states.push(s.state),onstop:r=>stops.push(r)});
 assert.equal(recorder.push(packet(0),sps,pps),false);
 recorder.start();recorder.push({data:annex(sps,pps),config:true,pts:0});
 assert.equal(recorder.push({...packet(1),key:true},sps,pps),false);
 assert.equal(recorder.state,'waiting');
 const result=recorder.stop();assert.equal(result.blob,null);assert.equal(result.frames,0);
 assert.deepEqual(states,['waiting','stopped']);assert.equal(stops.length,1);
 assert.equal(recorder.stop(),result);assert.equal(stops.length,1);
});

test('MP4 starts at zero, retains variable frame durations and flushes the final frame',async()=>{
 const recorder=new Recorder();recorder.start();
 for(const [index,pts] of [[0,1000000],[1,1040000],[2,1100000]])assert.equal(recorder.push(packet(index,pts),sps,pps),true);
 const result=recorder.stop();assert.equal(result.blob.type,'video/mp4');assert.equal(result.frames,3);
 assert.equal(result.bytes,result.blob.size);assert.equal(result.durationUs,160000);
 assert.deepEqual(await samples(result.blob),[
  {pts:0,duration:40000,flags:0x02000000},
  {pts:40000,duration:60000,flags:0x01010000},
  {pts:100000,duration:60000,flags:0x01010000}
 ]);
});

test('single-frame recording has a positive configurable final duration',async()=>{
 const recorder=new Recorder({defaultFrameDurationUs:16667});recorder.start();recorder.push(packet(0),sps,pps);
 const result=recorder.stop();assert.equal(result.frames,1);assert.equal(result.durationUs,16667);
 assert.equal((await samples(result.blob))[0].duration,16667);
});

test('configuration packets do not affect the recording timeline',async()=>{
 const recorder=new Recorder();recorder.start();recorder.push(packet(0,100000),sps,pps);
 recorder.push({data:annex(sps,pps),pts:0,config:true},sps,pps);
 recorder.push(packet(1,133333),sps,pps);const result=recorder.stop();
 assert.equal(result.reason,'user');assert.equal(result.frames,2);assert.equal(result.durationUs,66666);
 assert.deepEqual((await samples(result.blob)).map(s=>s.pts),[0,33333]);
});

test('changed SPS or PPS stops without appending incompatible samples',async()=>{
 for(const type of ['sps','pps']){
  const stops=[],recorder=new Recorder({onstop:r=>stops.push(r)});recorder.start();recorder.push(packet(0),sps,pps);
  const nextSPS=Uint8Array.from(sps),nextPPS=Uint8Array.from(pps),changed=type==='sps'?nextSPS:nextPPS;changed[changed.length-1]^=1;
  assert.equal(recorder.push({data:annex(nextSPS,nextPPS),pts:0,config:true},nextSPS,nextPPS),false);
  assert.equal(stops.length,1);assert.equal(stops[0].reason,'configuration-changed');
  assert.equal(stops[0].frames,1);assert.equal((await samples(stops[0].blob)).length,1);
 }
});

test('duplicate, reversed and overflowing timestamps retain a valid preceding recording',async()=>{
 for(const next of [100,99,100+0x100000000]){
  const recorder=new Recorder();recorder.start();recorder.push(packet(0,100),sps,pps);
  recorder.push(packet(1,next),sps,pps);assert.equal(recorder.state,'stopped');
  assert.equal(recorder.result.reason,'timestamp-discontinuity');assert.equal(recorder.result.frames,1);
  assert.equal((await samples(recorder.result.blob))[0].duration,33333);
 }
});

test('malformed timestamps and SPS never leave an unbounded active recorder',()=>{
 for(const pts of [NaN,Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1]){
  const recorder=new Recorder();recorder.start();recorder.push(packet(0,pts),sps,pps);
  assert.equal(recorder.result.reason,'invalid-stream');assert.equal(recorder.result.blob,null);
 }
 const recorder=new Recorder();recorder.start();
 const idr=annex(units.find(n=>(n[0]&31)===5));
 recorder.push({data:idr,pts:0},new Uint8Array([7]),pps);
 assert.equal(recorder.result.reason,'invalid-stream');assert.equal(recorder.result.blob,null);
});

test('byte cap preserves accepted frames, includes MP4 overhead and reports an automatic stop',async()=>{
 const stops=[],recorder=new Recorder({maxBytes:firstBytes+1,onstop:r=>stops.push(r)});
 recorder.start();recorder.push(packet(0),sps,pps);assert.equal(recorder.active,true);
 recorder.push(packet(1),sps,pps);
 assert.equal(stops.length,1);assert.equal(stops[0].reason,'size-limit');assert.equal(stops[0].frames,1);
 assert.equal(stops[0].blob.size,firstBytes);assert.ok(stops[0].bytes<=recorder.maxBytes);
 assert.equal((await samples(stops[0].blob))[0].duration,33333);
 recorder.stop();assert.equal(stops.length,1);
});

test('a first frame over the byte cap creates no empty MP4; an exact fit is retained',()=>{
 for(const maxBytes of [1,firstBytes-1,firstBytes]){
  const recorder=new Recorder({maxBytes});recorder.start();recorder.push(packet(0),sps,pps);
  assert.equal(recorder.state,'stopped');assert.equal(recorder.result.reason,'size-limit');
  assert.equal(recorder.result.frames,maxBytes===firstBytes?1:0);
  assert.equal(recorder.result.bytes,maxBytes===firstBytes?firstBytes:0);
  assert.equal(recorder.result.blob?.size??0,maxBytes===firstBytes?firstBytes:0);
 }
});

test('media-time cap truncates the pending frame without accepting later samples',async()=>{
 const recorder=new Recorder({maxDurationMs:50});recorder.start();
 recorder.push(packet(0,1000000),sps,pps);recorder.push(packet(1,1030000),sps,pps);recorder.push(packet(2,1060000),sps,pps);
 assert.equal(recorder.result.reason,'time-limit');assert.equal(recorder.result.durationUs,50000);
 assert.deepEqual((await samples(recorder.result.blob)).map(s=>s.duration),[30000,20000]);
});

test('wall-clock cap ends stalled recordings and waiting sessions',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const withFrame of [false,true]){
  const stops=[],recorder=new Recorder({maxDurationMs:25,onstop:r=>stops.push(r)});recorder.start();
  if(withFrame)recorder.push(packet(0),sps,pps);
  t.mock.timers.tick(25);assert.equal(recorder.active,false);assert.equal(stops.length,1);
  assert.equal(stops[0].reason,'time-limit');assert.equal(stops[0].frames,withFrame?1:0);
  assert.equal(stops[0].durationUs,withFrame?25000:0);
 }
});

test('stop on disconnect closes the previous file; restart requires a fresh keyframe',async()=>{
 const recorder=new Recorder();recorder.start();recorder.push(packet(0,5000000),sps,pps);
 const before=recorder.stop('disconnected');assert.equal(before.reason,'disconnected');
 recorder.start();assert.equal(recorder.push(packet(1,0),sps,pps),false);
 recorder.push(packet(0,20000),sps,pps);const after=recorder.stop();
 assert.notEqual(before.blob,after.blob);assert.equal(before.frames,1);assert.equal(after.frames,1);
 assert.equal((await samples(after.blob))[0].pts,0);
});

test('recording owns encoded bytes and ignores later caller buffer mutations',async()=>{
 const recorder=new Recorder(),data=frames[0].slice();recorder.start();recorder.push({data,pts:0},sps,pps);
 data.fill(0);const result=recorder.stop();
 const expected=Buffer.concat([initSegment(sps,pps),fragment(frames[0],true,0,33333,1)]);
 assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),expected);
});

test('recorded MP4 has one H.264 video track and exactly the original decoded frames',async()=>{
 const recorder=new Recorder();recorder.start();for(let i=0;i<frames.length;i++)recorder.push(packet(i,1234567+i*33333),sps,pps);
 const result=recorder.stop(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'uficpy-recording-'));
 try{
  const file=path.join(tmp,'recorded.mp4');fs.writeFileSync(file,Buffer.from(await result.blob.arrayBuffer()));
  const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',file]));
  assert.equal(metadata.streams.length,1);assert.equal(metadata.streams[0].codec_name,'h264');
  assert.equal(metadata.streams[0].codec_type,'video');assert.equal(metadata.streams[0].nb_read_frames,'30');
  assert.equal(metadata.streams[0].width,160);assert.equal(metadata.streams[0].height,96);
  const hashes=file=>execFileSync('ffmpeg',['-v','error','-i',file,'-f','framemd5','-']).toString().split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1).trim());
  assert.deepEqual(hashes(file),hashes(fixture.pathname));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('invalid limits are rejected and starting twice cannot discard an active recording',()=>{
 for(const options of [{maxBytes:0},{maxBytes:NaN},{maxDurationMs:0},{maxDurationMs:0x80000000},{defaultFrameDurationUs:0}])assert.throws(()=>new Recorder(options));
 const recorder=new Recorder();recorder.start();recorder.push(packet(0),sps,pps);
 assert.throws(()=>recorder.start());assert.equal(recorder.stop().frames,1);
});
