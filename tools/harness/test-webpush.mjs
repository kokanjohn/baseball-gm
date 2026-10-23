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
console.log(`\n${fail ? fail + ' failed' : 'all passed'}`);
process.exit(fail ? 1 : 0);
