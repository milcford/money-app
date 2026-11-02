// Offline-first sync engine (browser + Node). db adapter: {raw(store)->Promise<records incl. tombstones>, put(store,rec)}
// request(body)->Promise<{changes,cursor,more}>. Records carry updatedAt (ms) and deleted (tombstone); _dirty marks unsent local edits.
(function(root){
const STORES=['accounts','ops','cats'];const CHUNK=250;
const strip=r=>{const{_dirty,...d}=r;return d;};
const key=r=>(r.deleted?1:0)+JSON.stringify(strip(r));
// does record a beat record b (last-write-wins, deterministic tie-break identical to server)?
const wins=(a,b)=>!b||((a.updatedAt||0)!==(b.updatedAt||0)?(a.updatedAt||0)>(b.updatedAt||0):key(a)>key(b));
async function syncOnce({db,request,cursor=0}){
  const pushed=[];for(const s of STORES)for(const r of await db.raw(s))if(r._dirty){const d=strip(r);pushed.push({store:s,id:r.id,updatedAt:r.updatedAt||0,deleted:!!r.deleted,data:d});}
  // push in chunks (thousands of dirty records after a big import), ack each chunk with one read per store
  let res,applied=0,cur=cursor;
  for(let i=0;i<pushed.length;i+=CHUNK){const part=pushed.slice(i,i+CHUNK);await request({since:cur,changes:part,pushOnly:true});
    const loc={};for(const s of STORES)loc[s]=new Map((await db.raw(s)).map(r=>[r.id,r]));
    for(const c of part){const l=loc[c.store].get(c.id);if(l&&l._dirty&&l.updatedAt===c.updatedAt)await db.put(c.store,{...l,_dirty:0});}}
  do{res=await request({since:cur,changes:[]});
    const local={};for(const s of STORES)local[s]=new Map((await db.raw(s)).map(r=>[r.id,r]));
    for(const c of res.changes){if(!local[c.store])continue;const rec={...c.data,id:c.id,updatedAt:c.updatedAt,deleted:c.deleted?true:undefined};if(!rec.deleted)delete rec.deleted;
      const l=local[c.store].get(c.id);if(l&&key(strip(l))===key(rec))continue;
      if(wins(rec,l)){await db.put(c.store,{...rec,_dirty:0});applied++;}}
    cur=res.cursor;}while(res.more);
  return {pushed:pushed.length,applied,cursor:cur};}
root.Sync={syncOnce,wins,STORES};
if(typeof module!=='undefined')module.exports=root.Sync;
})(typeof self!=='undefined'?self:globalThis);
