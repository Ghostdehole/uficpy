import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPreferences,savePreferences} from '../web/preferences.mjs';
test('playback preferences validate persisted data',()=>{
 const storage={value:'',getItem(){return this.value},setItem(k,v){this.value=v}};
 const p=loadPreferences(storage);assert.equal(p.mode,'auto');
 p.targetBuffer=.2;p.maxBuffer=.6;p.hardware='prefer-software';savePreferences(p,storage);
 assert.equal(loadPreferences(storage).targetBuffer,.2);
 storage.value=JSON.stringify({...p,maxBuffer:.1});assert.equal(loadPreferences(storage).targetBuffer,.12);
 storage.value='{broken';assert.equal(loadPreferences(storage).mode,'auto');
 storage.value=JSON.stringify({...p,decodeQueue:-5});assert.equal(loadPreferences(storage).decodeQueue,8);
});
test('blocked browser storage falls back to usable session defaults',()=>{
 const storage={getItem(){throw new DOMException('Blocked','SecurityError')},setItem(){throw new DOMException('Blocked','SecurityError')}};
 assert.equal(loadPreferences(storage).mode,'auto');assert.doesNotThrow(()=>savePreferences(loadPreferences(storage),storage));
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 try{Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('Blocked','SecurityError')}});assert.equal(loadPreferences().mode,'auto');assert.doesNotThrow(()=>savePreferences({mode:'mse'}));}
 finally{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete globalThis.localStorage;}
});
