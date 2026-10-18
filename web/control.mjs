// scrcpy 5.0.1 control wire format. The server maps client pointer IDs to
// globally unique Android contacts and releases them when a client disconnects.
export const VOLUME_KEYS=new Set([24,25,164]);
export function keyAllowed(key,permissions,volumeUnlocked=false){
 return !permissions.read_only&&(VOLUME_KEYS.has(key)?permissions.allow_volume_keys&&volumeUnlocked:permissions.allowed_keys.includes(key));
}
export function keyPacket(action,key){const b=new ArrayBuffer(14),d=new DataView(b);d.setUint8(1,action);d.setUint32(2,key);return b;}
export function touchPacket(action,id,point,dimensions){
 const b=new ArrayBuffer(32),d=new DataView(b);d.setUint8(0,2);d.setUint8(1,action);d.setBigUint64(2,BigInt(id));d.setUint32(10,point.x);d.setUint32(14,point.y);d.setUint16(18,dimensions.width);d.setUint16(20,dimensions.height);d.setUint16(22,action===1?0:65535);return b;
}
export function scrollPacket(point,dimensions,horizontal,vertical){
 const fixed=value=>Math.max(-32768,Math.min(32767,Math.round(value/16*32768)));
 const b=new ArrayBuffer(21),d=new DataView(b);d.setUint8(0,3);d.setUint32(1,point.x);d.setUint32(5,point.y);d.setUint16(9,dimensions.width);d.setUint16(11,dimensions.height);d.setInt16(13,fixed(horizontal));d.setInt16(15,fixed(vertical));return b;
}
export function clipboardPacket(text,paste=false){
 const data=new TextEncoder().encode(text);if(data.length>1024)throw Error('文字最多为 1024 个 UTF-8 字节，请分段发送');
 const b=new Uint8Array(14+data.length),d=new DataView(b.buffer);b[0]=9;b[9]=paste?1:0;d.setUint32(10,data.length);b.set(data,14);return b;
}
export function textPacket(text){return clipboardPacket(text,true);}
export function clipboardRequestPacket(){return new Uint8Array([8,0]);}
export function displayPowerPacket(on){return new Uint8Array([10,on?1:0]);}
export function panelPacket(panel){const types={notifications:5,settings:6,collapse:7};if(!Object.hasOwn(types,panel))throw Error('未知面板');return new Uint8Array([types[panel]]);}
export function rotatePacket(){return new Uint8Array([11]);}
export function startAppPacket(packageName){
 if(typeof packageName!=='string'||packageName.length>255||!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName))throw Error('请输入完整应用包名，例如 com.android.settings');
 const data=new TextEncoder().encode(packageName),b=new Uint8Array(2+data.length);b[0]=16;b[1]=data.length;b.set(data,2);return b;
}
const keys={ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Enter:66,NumpadEnter:66,Tab:61,Space:62,Backspace:67,Delete:112,Escape:4,Home:122,End:123,PageUp:92,PageDown:93};
export function keyboardKey(event){return event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.isComposing?null:keys[event.code]??null;}
export class InputState{
 constructor(send){this.send=send;this.pointers=new Map();this.keys=new Map();}
 down(id,point,dimensions){
  if(this.pointers.has(id)||this.pointers.size>=10)return false;
  const contact={point:{...point},dimensions:{width:dimensions.width,height:dimensions.height}};
  if(!this.send(touchPacket(0,id,point,dimensions)))return false;
  this.pointers.set(id,contact);return true;
 }
 move(id,point){const contact=this.pointers.get(id);if(!contact)return false;contact.point={...point};return this.send(touchPacket(2,id,point,contact.dimensions));}
 up(id){const contact=this.pointers.get(id);if(!contact)return false;this.pointers.delete(id);return this.send(touchPacket(1,id,contact.point,contact.dimensions),true);}
 keyDown(code,key){if(this.keys.has(code))return true;if([...this.keys.values()].includes(key))return false;if(!this.send(keyPacket(0,key)))return false;this.keys.set(code,key);return true;}
 keyUp(code){if(!this.keys.has(code))return false;const key=this.keys.get(code);this.keys.delete(code);return this.send(keyPacket(1,key),true);}
 releaseAll(){for(const id of [...this.pointers.keys()])this.up(id);for(const code of [...this.keys.keys()])this.keyUp(code);}
}
