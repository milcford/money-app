// Учёт денег — service worker: offline shell, stale-while-revalidate. Bump CACHE on every app change.
const CACHE='money-v36';
const SHELL=['./','index.html','app.js','core.js','sync.js','style.css','icon.svg','manifest.json'];
const CDN=['https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil((async()=>{const c=await caches.open(CACHE);
  await c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'})));
  for(const u of CDN){try{let r=await fetch(u,{mode:'cors'}).catch(()=>null);if(!r||!r.ok)r=await fetch(u,{mode:'no-cors'});await c.put(u,r);}catch(_){}}})());});
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);await self.clients.claim();})()));
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET')return;const u=new URL(q.url);
  if(u.origin===location.origin&&u.pathname.includes('/api/'))return;
  const same=u.origin===location.origin;if(!same&&!CDN.includes(q.url))return;
  e.respondWith((async()=>{const c=await caches.open(CACHE);const key=q.mode==='navigate'?'index.html':q;
    const hit=await c.match(key,{ignoreSearch:same});
    const net=fetch(q).then(r=>{if(r&&(r.ok||r.type==='opaque'))c.put(key,r.clone());return r;}).catch(()=>null);
    if(hit){e.waitUntil(net);return hit;}
    const r=await net;if(r)return r;return (await c.match('index.html'))||new Response('офлайн',{status:503});})());});
