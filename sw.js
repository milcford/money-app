// Учёт денег — service worker: offline shell, stale-while-revalidate. Bump CACHE on every app change.
const CACHE='money-v46';
const SHELL=['./','index.html','app.js','core.js','sync.js','style.css','icon.svg','manifest.json'];
const CDN=['https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'];
const INDEX=new URL('index.html',self.registration.scope).href, ROOT=self.registration.scope;
// Safari refuses redirected responses for navigations: rebuild as a clean response.
async function clean(r){if(!r||!r.redirected)return r;const b=await r.blob();return new Response(b,{status:r.status,statusText:r.statusText,headers:r.headers});}
const tfetch=(q,o,ms=8000)=>Promise.race([fetch(q,o),new Promise((_,j)=>setTimeout(()=>j(new Error('timeout')),ms))]);
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil((async()=>{const c=await caches.open(CACHE);
  await Promise.all(SHELL.map(async u=>{try{const r=await clean(await tfetch(new Request(u,{cache:'reload'})));if(r&&r.ok)await c.put(new URL(u,ROOT).href,r);}catch(_){}}));
  for(const u of CDN){try{let r=await tfetch(u,{mode:'cors'}).catch(()=>null);if(!r||!r.ok)r=await tfetch(u,{mode:'no-cors'});await c.put(u,r);}catch(_){}}})());});
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);await self.clients.claim();})()));
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET')return;const u=new URL(q.url);
  if(u.origin===location.origin&&u.pathname.includes('/api/'))return;
  const same=u.origin===location.origin;if(!same&&!CDN.includes(q.url))return;
  const nav=q.mode==='navigate';
  e.respondWith((async()=>{const c=await caches.open(CACHE);const key=nav?INDEX:q;
    let hit=nav?((await c.match(INDEX,{ignoreSearch:true}))||(await c.match(ROOT,{ignoreSearch:true}))):await c.match(q,{ignoreSearch:same});
    const net=tfetch(nav?INDEX:q,nav?{cache:'no-cache'}:undefined,15000).then(clean).then(r=>{if(r&&(r.ok||r.type==='opaque'))c.put(key,r.clone()).catch(()=>{});return r;}).catch(()=>null);
    if(hit){e.waitUntil(net);return hit;}
    const r=await net;if(r)return r;
    return (await c.match(INDEX,{ignoreSearch:true}))||(await c.match(ROOT,{ignoreSearch:true}))||new Response('<meta charset=utf-8>Офлайн: откройте приложение один раз с интернетом',{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});})());});
