import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchClientOptions} from '../web/client.mjs';

test('player diagnoses empty, truncated, HTML and invalid JSON responses without leaking tokens',async()=>{
 for(const [body,pattern] of [['',/空内容/],['{"token":"secret"',/完整 JSON/],['<html>login</html>',/完整 JSON/],['null',/格式不兼容/],['{}',/格式不兼容/]]) {
  await assert.rejects(fetchClientOptions('secret',async()=>new Response(body)),e=>pattern.test(e.message)&&!e.message.includes('secret'));
 }
});

test('player distinguishes authentication, server error and valid options',async()=>{
 for(const [status,pattern] of [[401,/授权/],[503,/HTTP 503/]])await assert.rejects(fetchClientOptions('secret',async()=>new Response('',{status})),pattern);
 const options={read_only:false,allowed_keys:[3,4],allow_volume_keys:false};
 assert.deepEqual(await fetchClientOptions('secret',async(url,init)=>{
  assert.equal(url,'/api/client');assert.equal(init.headers.Authorization,'Bearer secret');assert.equal(init.cache,'no-store');assert.ok(init.signal);
  return new Response(JSON.stringify(options));
 }),options);
});
