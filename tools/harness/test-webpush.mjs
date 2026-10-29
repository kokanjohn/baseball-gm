/**
 * tools/harness/test-webpush.mjs
 * Proves workers/push-worker.js encrypts Web Push payloads per RFC 8291.
 *   1. An independent RFC 8291 decryptor is validated against the RFC's own
 *      Appendix A test vector.
 *   2. The worker's encryptPayload output must decrypt with that decryptor.
 * Usage: node tools/harness/test-webpush.mjs
 */
const { subtle } = globalThis.crypto;
const b64 = s => Uint8Array.from(Buffer.from(s.replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/'), 'base64'));
const cat = (...a) => { const o = new Uint8Array(a.reduce((s,x)=>s+x.length,0)); let i=0; for (const x of a){o.set(x,i);i+=x.length;} return o; };
async function hkdf(salt, ikm, info, len){ const k=await subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']); return new Uint8Array(await subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,len*8)); }
// Independent RFC 8291 decryptor (user-agent side)
async function decrypt(body, uaPriv32, uaPub65, auth){
  const salt=body.slice(0,16), idlen=body[20], asPub=body.slice(21,21+idlen), ct=body.slice(21+idlen);
  const jwk={kty:'EC',crv:'P-256',d:Buffer.from(uaPriv32).toString('base64url'),x:Buffer.from(uaPub65.slice(1,33)).toString('base64url'),y:Buffer.from(uaPub65.slice(33)).toString('base64url')};
  const priv=await subtle.importKey('jwk',jwk,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const pub=await subtle.importKey('raw',asPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const ecdh=new Uint8Array(await subtle.deriveBits({name:'ECDH',public:pub},priv,256));
  const ikm=await hkdf(auth,ecdh,cat(new TextEncoder().encode('WebPush: info\0'),uaPub65,asPub),32);
  const cek=await hkdf(salt,ikm,new TextEncoder().encode('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(salt,ikm,new TextEncoder().encode('Content-Encoding: nonce\0'),12);
  const k=await subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']);
  const pt=new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv:nonce},k,ct));
  let e=pt.length-1; while(pt[e]===0)e--; return new TextDecoder().decode(pt.slice(0,e));
}
// 1) Validate decryptor on RFC 8291 Appendix A
const rfcBody=b64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`);
const uaPriv=b64('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
const uaPub=b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
const auth=b64('BTBZMqHH6r4Tts7J_aSIgg');
const rfcText = await decrypt(rfcBody,uaPriv,uaPub,auth);
let fail = 0;
const ok = (label, cond, detail='') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) fail++; };
ok('decryptor reproduces RFC 8291 Appendix A', rfcText === 'When I grow up, I want to be a watermelon', JSON.stringify(rfcText));
// 2) Worker round trip
const { encryptPayload } = await import(new URL('../../workers/push-worker.js', import.meta.url));
const kp = await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
const myPub = new Uint8Array(await subtle.exportKey('raw',kp.publicKey));
const myPriv = b64((await subtle.exportKey('jwk',kp.privateKey)).d);
const myAuth = crypto.getRandomValues(new Uint8Array(16));
const sub = { endpoint:'x', keys:{ p256dh:Buffer.from(myPub).toString('base64url'), auth:Buffer.from(myAuth).toString('base64url') } };
const msg = JSON.stringify({ title:'The Front Office', body:'New message ⚾' });
let out = null;
try { out = await decrypt(await encryptPayload(sub, msg), myPriv, myPub, myAuth); } catch (e) { out = 'ERROR ' + e.message; }
ok('worker payload decrypts on the browser side', out === msg, out);
// 3) Whole worker end-to-end with a fake KV + fake push service
{
  const worker = (await import(new URL('../../workers/push-worker.js', import.meta.url))).default;
  const vk = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const kv = new Map();
  const ops = { put: 0, list: 0 };   // §98 the free plan's scarce operations
  const env = {
    VAPID_PRIVATE_KEY: (await subtle.exportKey('jwk', vk.privateKey)).d,
    VAPID_PUBLIC_KEY:  Buffer.from(new Uint8Array(await subtle.exportKey('raw', vk.publicKey))).toString('base64url'),
    VAPID_SUBJECT:     'mailto:test@example.com',
    SCHEDULES: {
      async put(k, v) { ops.put++; kv.set(k, v); },
      async get(k, t) { const v = kv.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
      async delete(k) { kv.delete(k); },
      async list({ prefix }) { ops.list++; return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
    },
  };
  const received = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    received.push({ url, init });
    return new Response('', { status: 201 });
  };
  const subJson = { endpoint: 'https://fcm.googleapis.com/fcm/send/fake', keys: sub.keys };
  const call = (method, path, body) => worker.fetch(new Request('https://w.test' + path,
    { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);

  const reg = await call('POST', '/register', { userId: 'dev1', subscription: subJson,
    schedule: [{ id: 'c1', deliverAt: Date.now() - 1000, title: 'GM', body: 'Due now' },
               { id: 'c2', deliverAt: Date.now() + 3600e3, title: 'GM', body: 'Later' }] });
  ok('worker /register accepts a schedule', reg.status === 200);

  const ts = await (await call('POST', '/test-send', { userId: 'dev1', subscription: subJson })).json();
  ok('worker /test-send reports success + matching VAPID keys', ts.ok && ts.status === 201 && ts.keys?.ok, JSON.stringify(ts.keys));

  await worker.scheduled({}, env);
  const st = await (await call('GET', '/status')).json();
  ok('cron sent the due card and kept the future one',
     st.lastSend?.sent === 1 && st.subscriptions[0]?.scheduled === 1, JSON.stringify({ lastSend: st.lastSend, s: st.subscriptions }));

  // §98 the KV budget: a day of cron minutes with nothing due, and the app
  // re-sending an unchanged schedule, cost no writes and no list calls.
  {
    const before = { ...ops };
    for (let m = 0; m < 1440; m++) await worker.scheduled({}, env);
    // the app re-sending exactly what the worker holds now
    const regBody = { userId: 'dev1', subscription: subJson, schedule: JSON.parse(kv.get('sub:dev1')).schedule };
    for (let i = 0; i < 50; i++) await call('POST', '/register', regBody);
    ok(`worker stays inside the free KV budget (a day of idle cron + 50 unchanged registers: ${ops.put - before.put} writes, ${ops.list - before.list} lists)`,
       ops.put === before.put && ops.list === before.list);
  }

  // What the push service received must decrypt and carry a valid VAPID JWT
  const last = received[received.length - 1];
  const pt = await decrypt(new Uint8Array(await new Response(last.init.body).arrayBuffer()), myPriv, myPub, myAuth);
  ok('delivered push decrypts to the card text', JSON.parse(pt).body === 'Due now', pt);
  const [, t] = last.init.headers.Authorization.match(/t=([^,]+)/);
  const [h, p, sg] = t.split('.');
  const jwtOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk.publicKey,
    Buffer.from(sg, 'base64url'), new TextEncoder().encode(h + '.' + p));
  ok('VAPID JWT verifies with the public key', jwtOk);

  env.VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY.slice(0, -4) + 'AAAA';
  const bad = await (await call('GET', '/status')).json();
  ok('/status detects a private/public key mismatch', bad.keys.privateMatchesPublic === false);
  globalThis.fetch = realFetch;
}

console.log(`\n${fail ? fail + ' failed' : 'all passed'}`);
process.exit(fail ? 1 : 0);
