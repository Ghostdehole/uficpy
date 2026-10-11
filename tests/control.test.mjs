import test from 'node:test';
import assert from 'node:assert/strict';
import {InputState,keyAllowed,keyboardKey,scrollPacket,textPacket,VOLUME_KEYS} from '../web/control.mjs';

const dimensions={width:1080,height:1920},point={x:20,y:30};
const capture=()=>{const packets=[];return {packets,input:new InputState((packet,releasing)=>{packets.push({data:new DataView(packet),releasing});return true;})};};
test('independent contacts keep IDs and last position through cancellation',()=>{
 const {input,packets}=capture();
 assert.equal(input.down(7,point,dimensions),true);assert.equal(input.down(42,{x:500,y:600},dimensions),true);
 input.move(7,{x:25,y:39});input.up(42);input.releaseAll();
 assert.deepEqual(packets.map(p=>[p.data.getUint8(1),p.data.getBigUint64(2)]),[[0,7n],[0,42n],[2,7n],[1,42n],[1,7n]]);
 assert.equal(packets[4].data.getUint32(10),25);assert.equal(packets[4].data.getUint32(14),39);assert.equal(packets[4].data.getUint16(18),1080);
 assert.equal(packets[4].data.getUint16(22),0);assert.equal(packets[4].releasing,true);assert.equal(input.pointers.size,0);
 input.releaseAll();assert.equal(packets.length,5);
});
test('ten contact limit and failed send cannot create phantom touches',()=>{
 const {input,packets}=capture();for(let i=0;i<10;i++)assert.equal(input.down(i,point,dimensions),true);
 assert.equal(input.down(11,point,dimensions),false);assert.equal(input.down(0,point,dimensions),false);assert.equal(packets.length,10);
 input.releaseAll();assert.equal(packets.length,20);
 const blocked=new InputState(()=>false);assert.equal(blocked.down(0,point,dimensions),false);assert.equal(blocked.pointers.size,0);
});
test('key state avoids autorepeat and releases held keys on focus loss',()=>{
 const {input,packets}=capture();input.keyDown('ArrowDown',20);input.keyDown('ArrowDown',20);input.keyDown('Enter',66);input.keyUp('ArrowDown');input.releaseAll();
 assert.deepEqual(packets.map(p=>[p.data.getUint8(1),p.data.getUint32(2)]),[[0,20],[0,66],[1,20],[1,66]]);
 assert.equal(input.keys.size,0);assert.equal(input.keyUp('Enter'),false);
 for(const code of ['AudioVolumeUp','AudioVolumeDown','AudioVolumeMute','Power','KeyA'])assert.equal(keyboardKey({code}),null);
 assert.equal(keyboardKey({code:'ArrowLeft'}),21);assert.equal(keyboardKey({code:'Escape'}),4);assert.equal(keyboardKey({code:'Home'}),122);
 for(const modifier of ['ctrlKey','altKey','metaKey','shiftKey','isComposing'])assert.equal(keyboardKey({code:'ArrowLeft',[modifier]:true}),null);
});
test('volume requires both backend permission and explicit session unlock; readonly always blocks',()=>{
 const p={read_only:false,allowed_keys:[4,24,25,164],allow_volume_keys:false};
 for(const key of VOLUME_KEYS){assert.equal(keyAllowed(key,p,true),false);assert.equal(keyAllowed(key,{...p,allow_volume_keys:true},false),false);assert.equal(keyAllowed(key,{...p,allow_volume_keys:true},true),true);assert.equal(keyAllowed(key,{...p,read_only:true,allow_volume_keys:true},true),false);}
 assert.equal(keyAllowed(4,p),true);assert.equal(keyAllowed(3,p),false);
});
test('scroll uses scrcpy 5 signed 16-bit fixed point and saturates with correct direction',()=>{
 const packet=new DataView(scrollPacket(point,dimensions,2,-1));assert.equal(packet.byteLength,21);assert.equal(packet.getUint8(0),3);assert.equal(packet.getUint32(1),20);assert.equal(packet.getUint32(5),30);assert.equal(packet.getUint16(9),1080);assert.equal(packet.getUint16(11),1920);assert.equal(packet.getInt16(13),4096);assert.equal(packet.getInt16(15),-2048);assert.equal(packet.getUint32(17),0);
 const saturated=new DataView(scrollPacket(point,dimensions,1000,-1000));assert.equal(saturated.getInt16(13),32767);assert.equal(saturated.getInt16(15),-32768);
});
test('clipboard payload preserves UTF-8 and enforces byte limit before sending',()=>{
 const text='你好\n🎉';const packet=textPacket(text),view=new DataView(packet.buffer);assert.equal(packet[0],9);assert.equal(packet[9],1);assert.equal(view.getBigUint64(1),0n);assert.equal(view.getUint32(10),11);assert.equal(new TextDecoder().decode(packet.subarray(14)),text);
 assert.throws(()=>textPacket('中'.repeat(342)),/1024/);assert.equal(textPacket('a'.repeat(1024)).length,1038);
});
