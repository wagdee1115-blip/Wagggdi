const CACHE_NAME='markabat-v4-hardened-2026-08-11';
const STATIC=['/offline.html','/manifest.json','/icons/icon-192x192.png','/icons/icon-512x512.png','/logo.webp','/brands.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('markabat-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request; const url=new URL(req.url);
  if(url.pathname.startsWith('/api/')) return;
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).catch(()=>caches.match('/offline.html'))); return;
  }
  if(['image','style','script','font'].includes(req.destination)){
    event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(res=>{const clone=res.clone();caches.open(CACHE_NAME).then(c=>c.put(req,clone));return res;})));
  }
});
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();if(event.data?.type==='CLEAR_CACHE')event.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>caches.delete(k)))));});
