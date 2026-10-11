export function concat(...arrays) {
 const out=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let offset=0;
 for(const a of arrays){out.set(a,offset);offset+=a.length;}return out;
}
export function nals(data) {
 const starts=[];
 for(let i=0;i+2<data.length;i++) {
  if(data[i]===0 && data[i+1]===0) {
   if(data[i+2]===1){starts.push([i,i+3]);i+=2;}
   else if(i+3<data.length && data[i+2]===0 && data[i+3]===1){starts.push([i,i+4]);i+=3;}
  }
 }
 return starts.map((s,i)=>data.subarray(s[1],i+1<starts.length?starts[i+1][0]:data.length)).filter(n=>n.length);
}
export function annex(...nalUnits){return concat(...nalUnits.map(n=>concat(new Uint8Array([0,0,0,1]),n)));}
export function parsePacket(buffer) {
 const d=new DataView(buffer);if(d.byteLength<13)throw Error('视频包过短');
 const flags=d.getBigUint64(0),size=d.getUint32(8);
 if(size!==d.byteLength-12 || flags&(1n<<63n))throw Error('视频协议错位');
 return {config:!!(flags&(1n<<62n)),key:!!(flags&(1n<<61n)),pts:Number(flags&((1n<<61n)-1n)),data:new Uint8Array(buffer,12)};
}
export function spsInfo(sps) {
 if(!sps || sps.length<4)throw Error('缺少 SPS');
 const codec='avc1.'+[sps[1],sps[2],sps[3]].map(x=>x.toString(16).padStart(2,'0')).join('');
 const rbsp=[];
 for(let i=1;i<sps.length;i++){if(i>=3&&sps[i]===3&&sps[i-1]===0&&sps[i-2]===0)continue;rbsp.push(sps[i]);}
 let at=0;
 const bits=n=>{let v=0;while(n--){if(at>=rbsp.length*8)throw Error('截断的 SPS');v=v*2+((rbsp[at>>3]>>(7-(at++&7)))&1);}return v;};
 const ue=()=>{let z=0;while(!bits(1)){if(++z>30)throw Error('无效 SPS');}return 2**z-1+bits(z);};
 const se=()=>{const v=ue();return v&1?(v+1)/2:-v/2;};
 const profile=bits(8);bits(8);bits(8);ue();let chroma=1,separate=0;
 if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)) {
  chroma=ue();if(chroma===3)separate=bits(1);ue();ue();bits(1);
  if(bits(1))for(let i=0;i<(chroma===3?12:8);i++)if(bits(1)){let last=8,next=8;for(let j=0;j<(i<6?16:64);j++){if(next!==0)next=(last+se()+256)%256;last=next===0?last:next;}}
 }
 ue();const poc=ue();if(poc===0)ue();else if(poc===1){bits(1);se();se();const n=ue();if(n>256)throw Error('无效 POC');for(let i=0;i<n;i++)se();}
 ue();bits(1);const mw=ue()+1,mh=ue()+1,frame=bits(1);if(!frame)bits(1);bits(1);
 let left=0,right=0,top=0,bottom=0;if(bits(1)){left=ue();right=ue();top=ue();bottom=ue();}
 const arrayType=separate?0:chroma,cropX=arrayType===1||arrayType===2?2:1,cropY=(arrayType===1?2:1)*(2-frame);
 const width=mw*16-(left+right)*cropX,height=mh*16*(2-frame)-(top+bottom)*cropY;
 if(width<1||height<1||width>16384||height>16384)throw Error('SPS 尺寸无效');
 return {codec,width,height};
}
export function mapPoint(rect,width,height,x,y,clamp=false) {
 if(![rect.width,rect.height,width,height,x,y].every(Number.isFinite)||rect.width<=0||rect.height<=0||width<=0||height<=0)return null;
 const scale=Math.min(rect.width/width,rect.height/height),w=width*scale,h=height*scale;
 x=(x-rect.left-(rect.width-w)/2)/scale;y=(y-rect.top-(rect.height-h)/2)/scale;
 if(!clamp&&(x<0||y<0||x>=width||y>=height))return null;
 return {x:Math.max(0,Math.min(width-1,Math.floor(x))),y:Math.max(0,Math.min(height-1,Math.floor(y)))};
}
