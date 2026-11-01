'use strict';
// Minimal sync server: node:http + node:sqlite (built into Node >= 22.13) + bcryptjs. Single user.
const http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const bcrypt=require('bcryptjs');
process.removeAllListeners('warning'); // hide node:sqlite experimental warning
if(process.argv[2]==='hash'){ // usage: node server.js hash   (reads password from stdin)
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=s.replace(/\r?\n$/,'');if(p.length<8){console.error('Пароль ≥ 8 символов');process.exit(1);}console.log(bcrypt.hashSync(p,10));});
  if(process.stdin.isTTY)process.stderr.write('Введите пароль и нажмите Ctrl-D: ');return;}
const {DatabaseSync}=require('node:sqlite');
const PORT=+process.env.PORT||8787,HOST=process.env.HOST||'127.0.0.1';
const DB_PATH=process.env.DB_PATH||path.join(__dirname,'data','money.db');
const HASH=process.env.MONEY_PASSWORD_HASH||'';
const ORIGINS=(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
const TRUST_PROXY=process.env.TRUST_PROXY==='1';
const SESSION_DAYS=+process.env.SESSION_DAYS||180;
const PUBLIC_DIR=path.resolve(process.env.PUBLIC_DIR||path.join(__dirname,'public'));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
function serveStatic(req,res,pathname){
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
  let rel;try{rel=decodeURIComponent(pathname);}catch{res.writeHead(400);return res.end();}
  if(rel.includes('\0')){res.writeHead(400);return res.end();}
  if(rel.endsWith('/'))rel+='index.html';
  const file=path.resolve(PUBLIC_DIR,'.'+path.posix.normalize('/'+rel));
  if(!file.startsWith(PUBLIC_DIR+path.sep)||path.basename(file).startsWith('.')){res.writeHead(404);return res.end('not found');}
  const type=MIME[path.extname(file).toLowerCase()];
  fs.stat(file,(err,st)=>{if(err||!st.isFile()||!type){res.writeHead(404,{'content-type':'text/plain'});return res.end('not found');}
    const noCache=/(^|\/)(sw\.js|index\.html)$/.test(file);
    const etag='"'+st.size.toString(16)+'-'+Math.floor(st.mtimeMs).toString(16)+'"';
    const h={'content-type':type,'content-length':st.size,etag,'x-content-type-options':'nosniff','cache-control':noCache?'no-cache':'public, max-age=300'};
    if(req.headers['if-none-match']===etag){res.writeHead(304,h);return res.end();}
    res.writeHead(200,h);if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);});}
const STORES=new Set(['accounts','ops','cats']);
if(!HASH){console.error('MONEY_PASSWORD_HASH не задан (см. README)');process.exit(1);}
fs.mkdirSync(path.dirname(DB_PATH),{recursive:true});
const db=new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA cache_size=-2000;
CREATE TABLE IF NOT EXISTS records(store TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,seq INTEGER NOT NULL,PRIMARY KEY(store,id));
CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta VALUES('seq',0);`);
const q={
  get:db.prepare('SELECT data,updated_at,deleted FROM records WHERE store=? AND id=?'),
  up:db.prepare('INSERT INTO records(store,id,data,updated_at,deleted,seq) VALUES(?,?,?,?,?,?) ON CONFLICT(store,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,deleted=excluded.deleted,seq=excluded.seq'),
  since:db.prepare('SELECT store,id,data,updated_at,deleted,seq FROM records WHERE seq>? ORDER BY seq LIMIT ?'),
  seq:db.prepare("SELECT v FROM meta WHERE k='seq'"),setSeq:db.prepare("UPDATE meta SET v=? WHERE k='seq'"),
  sess:db.prepare('SELECT expires FROM sessions WHERE token_hash=?'),addSess:db.prepare('INSERT INTO sessions VALUES(?,?)'),
  delSess:db.prepare('DELETE FROM sessions WHERE token_hash=?'),gcSess:db.prepare('DELETE FROM sessions WHERE expires<?')};
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
// last-write-wins: newer updatedAt wins; exact tie broken deterministically by data string so all replicas converge
const wins=(aT,aD,bT,bD)=>aT!==bT?aT>bT:aD>bD;
const fails=new Map(); // ip -> {n,until}
function send(res,code,obj,req){const h={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
  const o=req&&req.headers.origin;if(o&&(ORIGINS.includes(o)||ORIGINS.includes('*'))){h['access-control-allow-origin']=o;h.vary='Origin';h['access-control-allow-headers']='authorization,content-type';h['access-control-allow-methods']='GET,POST,OPTIONS';h['access-control-max-age']='86400';}
  res.writeHead(code,h);res.end(obj===undefined?'':JSON.stringify(obj));}
function body(req){return new Promise((ok,no)=>{let n=0;const c=[];req.on('data',d=>{n+=d.length;if(n>8e6){no(Object.assign(new Error('too large'),{code:413}));req.destroy();}else c.push(d);});
  req.on('end',()=>{try{ok(c.length?JSON.parse(Buffer.concat(c)):{});}catch(e){no(Object.assign(e,{code:400}));}});req.on('error',no);});}
function authed(req){const m=/^Bearer (\S+)$/.exec(req.headers.authorization||'');if(!m)return false;const r=q.sess.get(sha(m[1]));return !!r&&r.expires>Date.now();}
const ipOf=req=>TRUST_PROXY&&req.headers['x-forwarded-for']?String(req.headers['x-forwarded-for']).split(',')[0].trim():req.socket.remoteAddress;
function applyChanges(changes){let seq=q.seq.get().v,n=0;db.exec('BEGIN');
  try{for(const c of changes){if(!c||!STORES.has(c.store)||typeof c.id!=='string'||!c.id||c.id.length>200)continue;
      const t=Math.max(0,Math.floor(+c.updatedAt||0)),del=c.deleted?1:0,data=JSON.stringify(c.data&&typeof c.data==='object'?c.data:{});
      const cur=q.get.get(c.store,c.id);
      if(cur&&!wins(t,del+data,cur.updated_at,cur.deleted+cur.data))continue;
      q.up.run(c.store,c.id,data,t,del,++seq);n++;}
    q.setSeq.run(seq);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return n;}
const server=http.createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://x');if(!/\/api\//.test(url.pathname))return serveStatic(req,res,url.pathname);
    const p=url.pathname.replace(/^.*?\/api\//,'/api/'); // works behind any subpath prefix
    if(req.method==='OPTIONS')return send(res,204,undefined,req);
    if(p==='/api/health')return send(res,200,{ok:true},req);
    if(p==='/api/login'&&req.method==='POST'){const ip=ipOf(req),f=fails.get(ip);
      if(f&&f.until>Date.now())return send(res,429,{error:'Слишком много попыток, подождите 15 минут'},req);
      const {password}=await body(req);
      if(typeof password==='string'&&await bcrypt.compare(password,HASH)){fails.delete(ip);q.gcSess.run(Date.now());
        const tok=crypto.randomBytes(32).toString('base64url');q.addSess.run(sha(tok),Date.now()+SESSION_DAYS*864e5);return send(res,200,{token:tok},req);}
      const g=f&&f.until>0&&f.until<Date.now()?{n:0}:(f||{n:0});g.n++;g.until=g.n>=10?Date.now()+15*6e4:0;fails.set(ip,g);
      await new Promise(r=>setTimeout(r,800));return send(res,401,{error:'Неверный пароль'},req);}
    if(!authed(req))return send(res,401,{error:'Нужен вход'},req);
    if(p==='/api/logout'&&req.method==='POST'){q.delSess.run(sha(req.headers.authorization.slice(7)));return send(res,200,{ok:true},req);}
    if(p==='/api/sync'&&req.method==='POST'){ // body: {since, changes:[{store,id,updatedAt,deleted,data}]}
      const b=await body(req);const accepted=applyChanges(Array.isArray(b.changes)?b.changes:[]);
      const since=Math.max(0,+b.since||0),LIM=5000;const rows=q.since.all(since,LIM);
      const out=rows.map(r=>({store:r.store,id:r.id,updatedAt:r.updated_at,deleted:!!r.deleted,data:JSON.parse(r.data)}));
      const cursor=rows.length?rows[rows.length-1].seq:Math.max(since,0);
      return send(res,200,{accepted,changes:out,cursor:rows.length===LIM?cursor:Math.max(cursor,q.seq.get().v),more:rows.length===LIM},req);}
    send(res,404,{error:'not found'},req);
  }catch(e){send(res,e.code===413?413:e.code===400?400:500,{error:e.code===400?'bad json':e.code===413?'too large':'server error'},req);if(!e.code)console.error(e);}
});
server.listen(PORT,HOST,()=>console.log(`money-sync on http://${HOST}:${PORT} db=${DB_PATH}`));
const stop=()=>{server.close();try{db.close();}catch{}process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
module.exports=server;
