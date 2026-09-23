import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SessionControl, normalizedState, type ControlSession, type ControlStore } from '../../src/pilot/control.mjs';
import { gatewayServer } from '../../src/pilot/http.mjs';

test('control auth, sanitized status, no-store QR, canonical lifecycle, durable pause and deduplication', async () => {
 let state='connected', paused=false, linked=true, pairs=0, reconnects=0, unlinks=0, sends=0;
 const ids=new Set<string>();
 const store: ControlStore={paused:async()=>paused,pause:async value=>{paused=value;},reserve:async id=>{if(ids.has(id))return false;ids.add(id);return true;}};
 const session: ControlSession={status:()=>state,qr:()=>state==='awaiting_pairing'?'synthetic-fixture-only':null,identity:()=>linked?{last4:'0123',jid:'15555550123@s.whatsapp.net'}:null,connectedSince:()=>null,diagnostics:()=>({connectionOpens:1,disconnects:0,reconnectAttempts:0}),reconnect:async()=>{assert.equal(paused,true);reconnects++;state='connected';},beginPairing:async()=>{assert.equal(paused,true);pairs++;state='awaiting_pairing';},unlink:async()=>{assert.equal(paused,true);unlinks++;linked=false;state='logged_out';}};
 const control=new SessionControl(session,store);
 const key='a'.repeat(64),sendKey='b'.repeat(64);
 const gateway={...session,pair:session.beginPairing,send:async()=>{sends++;return 'mock';},delivery:()=>null};
 const server=gatewayServer({apiKey:sendKey,controlKey:key,sessionId:'canonical',recipients:['+15555550123'],pairingEnabled:false},gateway,async()=>true,undefined,control);
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const base=`http://127.0.0.1:${address.port}`;
 const req=(path:string,method='GET',credential:string|undefined=key,body?:unknown)=>fetch(base+path,{method,headers:{'content-type':'application/json',...(credential?{'x-control-key':credential}:{})},body:body?JSON.stringify(body):undefined});
 const route='/internal/v1/control/session';
 try {
  for(const credential of ['',sendKey,'incorrect'])assert.equal((await req(route,'GET',credential)).status,401);
  let response=await req(route);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const text=await response.text();assert.ok(!text.includes('15555550123')&&!text.includes('jid')&&!text.includes(key)&&!text.includes('synthetic'));
  assert.equal(JSON.parse(text).account.last4,'0123');assert.equal((await req(route+'/qr')).status,409);
  assert.equal((await req('/api/sessions/canonical/restart','POST')).status,401);
  assert.equal((await req(route+'/send','POST',key,{text:'forbidden'})).status,404);
  assert.equal((await req(route,'POST',key,{action:'send',operationId:randomUUID()})).status,400);
  const operationId=randomUUID();response=await req(route,'POST',key,{action:'reconnect',operationId});assert.equal(response.status,200);assert.equal(reconnects,1);assert.equal(paused,true);
  assert.equal((await req(route,'POST',key,{action:'reconnect',operationId})).status,409);assert.equal(reconnects,1);
  assert.equal((await req(route,'POST',key,{action:'resume',operationId:randomUUID()})).status,200);assert.equal(paused,false);
  assert.equal((await req(route,'POST',key,{action:'pair',operationId:randomUUID()})).status,409);assert.equal(pairs,0);
  assert.equal((await req(route,'POST',key,{action:'replace',operationId:randomUUID()})).status,200);assert.equal(unlinks,1);assert.equal(pairs,1);assert.equal(paused,true);
  response=await req(route+'/qr');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match((await response.json()).image,/^data:image\/png;base64,/);
  assert.equal((await req(route,'POST',key,{action:'resume',operationId:randomUUID()})).status,409);assert.equal(paused,true);
  // A process replacement uses the same durable pause; no implicit resume.
  assert.equal((await new SessionControl(session,store).status(true,true)).paused,true);
  state='connected';linked=true;assert.equal((await req(route+'/qr')).status,409);
  response=await fetch(base+'/v1/sessions/canonical/messages',{method:'POST',headers:{'x-api-key':sendKey,'content-type':'application/json'},body:JSON.stringify({recipient:'+15555550123',text:'fixture'})});assert.equal(response.status,409);assert.equal(sends,0);
  assert.equal((await req(route,'POST',key,{action:'unlink',operationId:randomUUID()})).status,200);assert.equal(unlinks,2);
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('state normalization and failed persistence never mutate session',async()=>{
 assert.equal(normalizedState('logged_out'),'LOGGED_OUT');assert.equal(normalizedState('awaiting_pairing'),'PAIRING');assert.equal(normalizedState('private-details'),'UNKNOWN');
 let mutations=0;const session={status:()=> 'connected',identity:()=>null,reconnect:async()=>{mutations++;}} as unknown as ControlSession;
 const control=new SessionControl(session,{paused:async()=>true,reserve:async()=>true,pause:async()=>{throw Error('db unavailable');}});
 await assert.rejects(control.act('reconnect',randomUUID(),async()=>true));assert.equal(mutations,0);
});

test('unlink stops callbacks and flushes before clearing only canonical credentials',async()=>{
 const {PilotWhatsApp}=await import('../../src/pilot/whatsapp.mjs');
 const calls:string[]=[];let scope:unknown;
 const db={authState:{deleteMany:async(value:unknown)=>{scope=value;calls.push('delete');}}} as unknown as import('@prisma/client').PrismaClient;
 const wa=new PilotWhatsApp(db,'canonical','a'.repeat(64),false);
 Object.assign(wa,{socket:{ev:{removeAllListeners:()=>calls.push('remove')},logout:async()=>{calls.push('logout');},end:()=>calls.push('end')},flush:async()=>{calls.push('flush');}});
 await wa.unlink();assert.deepEqual(scope,{where:{sessionId:'canonical'}});assert.ok(calls.indexOf('flush')<calls.indexOf('delete'));assert.ok(calls.indexOf('remove')<calls.indexOf('logout'));assert.equal(wa.status(),'logged_out');assert.equal(wa.identity(),null);
});

test('failed remote unlink does not erase stored credentials',async()=>{
 const {PilotWhatsApp}=await import('../../src/pilot/whatsapp.mjs');let deleted=false;
 const db={authState:{deleteMany:async()=>{deleted=true;}}} as unknown as import('@prisma/client').PrismaClient;
 const wa=new PilotWhatsApp(db,'canonical','a'.repeat(64),false);
 Object.assign(wa,{socket:{ev:{removeAllListeners:()=>{}},logout:async()=>{throw Error('provider failed');},end:()=>{}},flush:async()=>{}});
 await assert.rejects(wa.unlink());assert.equal(deleted,false);
});
