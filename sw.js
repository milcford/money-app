const C='money-v6',F=['./','index.html','core.js','app.js','manifest.json','icon.svg','style.css','sync.js'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(F)));});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
const CDN=/cdn\.jsdelivr\.net|unpkg\.com|tessdata/;
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin&&!CDN.test(e.request.url))return;
  if(CDN.test(e.request.url)) // OCR engine + language data: cache-first (large, versioned)
    return e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(n=>{const cl=n.clone();caches.open(C).then(c=>c.put(e.request,cl));return n;})));
  e.respondWith(fetch(e.request).then(r=>{const cl=r.clone();caches.open(C).then(c=>c.put(e.request,cl));return r;}).catch(()=>caches.match(e.request)));});
