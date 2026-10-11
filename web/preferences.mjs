const defaults={mode:'auto',hardware:'no-preference',targetBuffer:0.12,maxBuffer:0.45,decodeQueue:8,queueMB:32};
export function loadPreferences(storage){
 try{storage??=globalThis.localStorage;const p={...defaults,...JSON.parse(storage.getItem('uficpy-player-v21')||'{}')};
 if(!['auto','mse','webcodecs'].includes(p.mode)||!['prefer-hardware','prefer-software','no-preference'].includes(p.hardware)||!Number.isFinite(p.targetBuffer)||p.targetBuffer<0.03||p.targetBuffer>3||!Number.isFinite(p.maxBuffer)||p.maxBuffer<=p.targetBuffer||p.maxBuffer>10||!Number.isInteger(p.decodeQueue)||p.decodeQueue<1||p.decodeQueue>120)return {...defaults};
 p.queueMB=32;return p;
 }catch{return {...defaults};}
}
export function savePreferences(p,storage){try{storage??=globalThis.localStorage;storage.setItem('uficpy-player-v21',JSON.stringify(p));}catch{}}
