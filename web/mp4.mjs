// Minimal single-track fragmented MP4 muxer for scrcpy H.264 without B-frames.
// Timescale is microseconds. Input access-unit boundaries are preserved.
import {concat,nals,spsInfo} from './h264.mjs';
const u8=(...v)=>new Uint8Array(v),zero=n=>new Uint8Array(n);
const u16=n=>u8(n>>>8,n),u32=n=>u8(n>>>24,n>>>16,n>>>8,n);
const u64=n=>concat(u32(Math.floor(n/4294967296)),u32(n));
const str=s=>new TextEncoder().encode(s);
const box=(type,...body)=>{const data=concat(...body);return concat(u32(data.length+8),str(type),data);};
const full=(type,version,flags,...body)=>box(type,u8(version,flags>>>16,flags>>>8,flags),...body);
const matrix=concat(u32(0x10000),u32(0),u32(0),u32(0),u32(0x10000),u32(0),u32(0),u32(0),u32(0x40000000));
export function initSegment(sps,pps) {
 const {width,height}=spsInfo(sps);
 const avcC=box('avcC',u8(1,sps[1],sps[2],sps[3],255,225),u16(sps.length),sps,u8(1),u16(pps.length),pps);
 const avc1=box('avc1',zero(6),u16(1),zero(16),u16(width),u16(height),u32(0x480000),u32(0x480000),zero(4),u16(1),zero(32),u16(24),u16(65535),avcC);
 const stbl=box('stbl',full('stsd',0,0,u32(1),avc1),full('stts',0,0,u32(0)),full('stsc',0,0,u32(0)),full('stsz',0,0,u32(0),u32(0)),full('stco',0,0,u32(0)));
 const dinf=box('dinf',full('dref',0,0,u32(1),full('url ',0,1)));
 const minf=box('minf',full('vmhd',0,1,zero(8)),dinf,stbl);
 const mdia=box('mdia',full('mdhd',0,0,zero(8),u32(1000000),u32(0),u16(0x55c4),u16(0)),full('hdlr',0,0,u32(0),str('vide'),zero(12),str('uficpy\0')),minf);
 const trak=box('trak',full('tkhd',0,7,zero(8),u32(1),u32(0),u32(0),zero(8),zero(8),matrix,u32(width*65536),u32(height*65536)),mdia);
 const mvhd=full('mvhd',0,0,zero(8),u32(1000000),u32(0),u32(0x10000),u16(0x100),zero(10),matrix,zero(24),u32(2));
 return concat(box('ftyp',str('isom'),u32(512),str('isomiso6avc1mp41')),box('moov',mvhd,trak,box('mvex',full('trex',0,0,u32(1),u32(1),u32(0),u32(0),u32(0)))));
}
export function fragment(data,key,pts,duration,sequence) {
 const units=nals(data).filter(n=>![7,8,9].includes(n[0]&31));
 const sample=concat(...units.map(n=>concat(u32(n.length),n)));
 const make=offset=>box('moof',full('mfhd',0,0,u32(sequence)),box('traf',full('tfhd',0,0x020000,u32(1)),full('tfdt',1,0,u64(pts)),full('trun',0,0x701,u32(1),u32(offset),u32(duration),u32(sample.length),u32(key?0x02000000:0x01010000))));
 const moof=make(0);return concat(make(moof.length+8),box('mdat',sample));
}
