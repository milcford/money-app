// ---- storage (IndexedDB) ----
let db;const S={accounts:[],ops:[],cats:[]};
function openDB(){return new Promise((ok,no)=>{const r=indexedDB.open('money',1);r.onupgradeneeded=()=>{const d=r.result;['accounts','ops','cats'].forEach(s=>d.createObjectStore(s,{keyPath:'id'}));};r.onsuccess=()=>ok(r.result);r.onerror=no;});}
const tx=(s,m='readonly')=>db.transaction(s,m).objectStore(s);
// records carry updatedAt + _dirty (unsynced) ; deletes are tombstones {id,deleted:true} so they sync to other devices
const raw=s=>new Promise(ok=>{const r=tx(s).getAll();r.onsuccess=()=>ok(r.result);});
const all=async s=>(await raw(s)).filter(x=>!x.deleted);
const putRaw=(s,o)=>new Promise(ok=>{const r=tx(s,'readwrite').put(o);r.onsuccess=ok;});
let cdT=null;const countDirtySoon=()=>{clearTimeout(cdT);cdT=setTimeout(countDirty,400);};
const put=(s,o)=>{o.updatedAt=Math.max(Date.now(),(o.updatedAt||0)+1);o._dirty=1;scheduleSync();return putRaw(s,o).then(r=>{countDirtySoon();return r;});};
const del=(s,id)=>put(s,{id,deleted:true});
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const byOrder=(a,b)=>(a.order??0)-(b.order??0);
const COLORS={inc:'#2c4a9a',cash:'#c9a84c',savings:'#4caf72',card:'#4a3b1c',exp:'#0d2626'};
const PALETTE=['#2c4a9a','#c9a84c','#4caf72','#4a3b1c','#0d2626','#8e44ad','#c0392b','#16a085','#d35400','#555'];
async function ensureBlacks(){const acc=await raw('accounts');for(const x of acc)if((x.id==='mama_t'||x.id==='anya_t')&&x.credit===undefined)await put('accounts',{...x,credit:true,limit:x.limit||0});for(const[id,name,card]of[['mama_black','Мама Black','mama_t'],['anya_black','Аня Black','anya_t']])
  if(acc.some(a=>a.id===card)&&!acc.some(a=>a.id===id))await putRaw('accounts',{id,name,kind:'card',icon:'🖤',color:'#222',initial:0,cardMask:'',order:50,updatedAt:1,_dirty:1});}
// v47: «Яндекс Сплит» — fixed id + updatedAt=1 so it syncs without duplicates; credit, limit 100 000, not «Входящие = доход»
async function ensureSplit(){if((await raw('accounts')).some(a=>a.id==='ya_split'))return;
  await putRaw('accounts',{id:'ya_split',name:'Яндекс Сплит',kind:'card',bank:'yandex',credit:true,limit:100000,incomeIn:false,inCat:'',icon:'🧩',color:'#5b3fd6',initial:0,cardMask:'',order:55,updatedAt:1,_dirty:1});}
// v50: one-time cleanup of «Яндекс Сплит» screenshot-import duplicates (repeated «Применить» taps re-applied the same batch).
// Only ops on ya_split whose bankIds are all screenshot ids (s:…); group date+amount+type+accounts+normalized note -> keep one, merge bankIds, tombstone the rest.
async function migSplitDups(){if(localStorage.migSplitDups)return;const ops=(await raw('ops')).filter(o=>!o.deleted);
  const plan=Core.splitDupPlan(ops,'ya_split');
  for(const g of plan)for(const d of g.drop)await del('ops',d.id);
  localStorage.migSplitDups=JSON.stringify({at:Date.now(),removed:plan.reduce((s,g)=>s+g.drop.length,0)});}
// one-time-ish (idempotent) cleanup: PDF header junk (ФИО, паспорт, договор) in Yandex Bank op descriptions
async function cleanYandex(){const ya=new Set((await raw('accounts')).filter(a=>!a.deleted&&a.bank==='yandex').map(a=>a.id));if(!ya.size)return 0;let n=0;
  for(const o of await raw('ops')){if(o.deleted||!(ya.has(o.accountId)||ya.has(o.toAccountId)))continue;const c={...o};
    for(const f of ['note','desc'])if(typeof o[f]==='string'&&o[f]){const v=Core.cleanYandexDesc(o[f],true);if(v&&v!==o[f])c[f]=v;}
    if(c.note!==o.note||c.desc!==o.desc){await put('ops',c);n++;}}return n;}
// Jetlend: investment wallet + turn "Jetlend" card expenses into transfers card -> Jetlend (idempotent, ids/dates/amounts kept)
async function ensureJetlend(){const ops=(await raw('ops')).filter(o=>!o.deleted&&o.type==='expense'&&Core.JL.test((o.note||'')+' '+(o.desc||''))&&o.accountId!=='jetlend');
  const accs=await raw('accounts');if(!ops.length&&!accs.some(a=>a.id==='jetlend'&&!a.deleted))return;
  if(!accs.some(a=>a.id==='jetlend'))await put('accounts',{id:'jetlend',name:'Jetlend',kind:'savings',invest:true,icon:'📈',color:'#4caf72',initial:0,cardMask:'',order:60});
  for(const o of ops)await put('ops',{...o,type:'transfer',toAccountId:'jetlend',category:''});}
async function load(){
  // migrate pre-sync records
  for(const st of ['accounts','ops','cats'])for(const r of await raw(st))if(!r.updatedAt)await putRaw(st,{...r,updatedAt:Date.now(),_dirty:1});
  // defaults use fixed ids and updatedAt=1 so any real edit (on any device) wins and devices don't duplicate them
  const seed=(st,o)=>putRaw(st,{...o,updatedAt:1,_dirty:1});
  if(!(await raw('accounts')).length){let i=0;for(const[id,name,kind,icon]of[['cash','Наличные','cash','👛'],['saved','Отложенные','savings','👛'],['anya_t','Аня Тинькофф','card','💳'],['mama_t','Мама Тинькофф','card','💳']])
    await seed('accounts',{id,name,kind,icon,color:COLORS[kind],initial:0,cardMask:'',order:i++});}
  if(!(await raw('cats')).length){let i=0,j=0;
    for(const[n,ic]of[['Доход','💵'],['Аня','🛒'],['ЗП','🛒'],['Прочее','🛒']])await seed('cats',{id:'inc_'+j++,name:n,income:true,icon:ic,color:COLORS.inc,order:i++});j=0;
    for(const[n,ic]of[['Продукты','🧃'],['Развлечения','🎞️'],['Транспорт','🚌'],['Еда вне дома','🥤'],['Покупки','🛍️'],['Прочее','🛒'],['Пивной','🍺'],['Кальян','💨'],['Ремонт','🏠'],['на чай','🪙'],['Валенсия','✈️'],['парикмахерская','💇']])
      await seed('cats',{id:'exp_'+j++,name:n,income:false,icon:ic,color:COLORS.exp,order:i++});}
  await ensureBlacks();await ensureSplit();await cleanYandex();await ensureJetlend();await migIncomeIn();await migP2P();await migTrInc();await migTrInc3();await migSplitDups();
  for(const st of ['accounts','ops','cats'])S[st]=await all(st);S.accounts.sort(byOrder);S.cats.sort(byOrder);}
// ---- sync ----
let syncing=false,syncAgain=false,syncTimer=null,syncMsg='';
// served from our own server -> same origin by default; on GitHub Pages user enters the URL
const SAME_ORIGIN=!/github\.io$/.test(location.hostname)&&location.protocol==='https:';
const syncUrl=()=>(localStorage.syncUrl||(SAME_ORIGIN?location.origin:'')).replace(/\/+$/,'');
function scheduleSync(){clearTimeout(syncTimer);syncTimer=setTimeout(runSync,1500);}
let dirtyN=0;
async function countDirty(){if(!db)return;let n=0;for(const st of ['accounts','ops','cats'])for(const r of await raw(st))if(r._dirty)n++;dirtyN=n;const e=document.getElementById('sync');if(e){e.textContent=syncLabel();e.classList.toggle('off',!navigator.onLine);}}
function syncLabel(){const off=navigator.onLine===false,q=dirtyN?(off?' · '+dirtyN+' не отправлено':' ↑'+dirtyN):'';if(off)return '⚠ офлайн'+q;return syncBase()+q;}
function syncBase(){if(!syncUrl())return '';if(!localStorage.syncToken)return '⚠ войдите в синхронизацию';if(syncMsg)return syncMsg;
  const t=+localStorage.syncAt;return t?'☁ '+new Date(t).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'☁';}
function setSync(m){syncMsg=m;const e=document.getElementById('sync');if(e){e.textContent=syncLabel();e.classList.toggle('off',navigator.onLine===false);}}
async function api(path,body,tok){const r=await fetch(syncUrl()+path,{method:'POST',headers:{'content-type':'application/json',...(tok?{authorization:'Bearer '+tok}:{})},body:JSON.stringify(body||{})});
  const j=await r.json().catch(()=>({}));if(r.status===401&&tok){localStorage.removeItem('syncToken');throw new Error('нужно войти заново');}if(!r.ok)throw new Error(j.error||('ошибка '+r.status));return j;}
async function runSync(){if(!db)return;countDirty();if(!syncUrl()||!localStorage.syncToken)return setSync('');if(navigator.onLine===false)return setSync('');if(syncing){syncAgain=true;return;}syncing=true;setSync('⟳ синхронизация…');
  try{const r=await Sync.syncOnce({db:{raw,put:putRaw},cursor:+localStorage.syncCursor||0,request:b=>api('/api/sync',b,localStorage.syncToken)});
    localStorage.syncCursor=r.cursor;localStorage.syncAt=Date.now();setSync('');if(r.applied){await cleanYandex();await ensureJetlend();await refresh();}}
  catch(e){setSync(navigator.onLine===false||e instanceof TypeError||/load failed|failed to fetch|networkerror/i.test(e.message)?'⚠ офлайн':'⚠ '+e.message);}
  syncing=false;await countDirty();if(syncAgain){syncAgain=false;runSync();}}
setInterval(runSync,60000);addEventListener('online',runSync);addEventListener('offline',()=>setSync(''));addEventListener('pageshow',runSync);document.addEventListener('visibilitychange',()=>{if(!document.hidden)runSync();});
function syncSheet(){openSheet(`<b>Синхронизация между устройствами</b><p class="mut">Данные хранятся на телефоне и работают без интернета; при наличии сети изменения отправляются на ваш сервер.</p>
  <label class="mut">Адрес сервера (https)</label><input id="sy_url" placeholder="https://example.ru/money" value="${esc(syncUrl()||'https://money.138-16-160-124.sslip.io')}" autocapitalize="off" autocorrect="off">
  ${localStorage.syncToken?`<div class="mut">Вход выполнен. ${esc(syncLabel())}</div><button class="b" onclick="closeSheet();runSync()">Синхронизировать сейчас</button><button class="b r" onclick="syncLogout()">Выйти</button>`:
  `<label class="mut">Пароль</label><input id="sy_pw" type="password" autocomplete="current-password"><button class="b" onclick="syncLogin()">Войти</button>`}
  <div id="sy_err" class="neg"></div><button class="b s" onclick="closeSheet()">Закрыть</button>`);}
async function syncLogin(){const u=$('#sy_url').value.trim().replace(/\/+$/,'');if(!/^https?:\/\//.test(u))return $('#sy_err').textContent='Укажите адрес, начинающийся с https://';
  if(u!==localStorage.syncUrl){localStorage.syncUrl=u;localStorage.syncCursor=0;}
  try{const {token}=await api('/api/login',{password:$('#sy_pw').value});localStorage.syncToken=token;localStorage.syncCursor=0;closeSheet();toast('Вход выполнен');runSync();header();}
  catch(e){$('#sy_err').textContent=e.message==='Failed to fetch'?'Сервер недоступен':e.message;}}
async function syncLogout(){try{await api('/api/logout',{},localStorage.syncToken);}catch{}localStorage.removeItem('syncToken');closeSheet();header();}
// ---- helpers ----
const $=s=>document.querySelector(s),V=$('#view');
const fmt=n=>(Math.round((n||0)*100)/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
const accName=id=>(S.accounts.find(a=>a.id===id)||S.accounts.map(a=>blackFor(a.id)).find(b=>b&&b.id===id)||{}).name||'?';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10);
const month=()=>today().slice(0,7);
const BANKS=[['tbank','Т‑Банк'],['yandex','Яндекс Банк (бета)'],['other','Другой банк']];
const bankOf=a=>a.kind!=='card'?'':(a.bank||'tbank');
const liveAccs=()=>S.accounts.filter(a=>!a.archived);
const bankAccs=()=>liveAccs().filter(a=>a.kind==='card');
const accOpts=sel=>S.accounts.map(a=>`<option value="${a.id}" ${a.id===sel?'selected':''}>${esc(a.name)}</option>`).join('');
function toast(t){const e=$('#toast');e.textContent=t;e.style.display='block';clearTimeout(e._t);e._t=setTimeout(()=>e.style.display='none',2000);}
function openSheet(h){$('#sheet').innerHTML=h;$('#sheetbg').style.display='block';requestAnimationFrame(()=>$('#sheet').classList.add('open'));}
function closeSheet(){$('#sheet').classList.remove('open');$('#sheetbg').style.display='none';}
function monthSums(m){const r={inc:0,exp:0,byCat:{},byInc:{}};for(const o of S.ops){if(!o.date.startsWith(m))continue;
  if(o.type==='expense'){r.exp+=o.amount;r.byCat[o.category]=(r.byCat[o.category]||0)+o.amount;}else if(o.type==='income'){r.inc+=o.amount;r.byInc[o.category]=(r.byInc[o.category]||0)+o.amount;}}return r;}
let PER=localStorage.per||month();
const MN=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const perLabel=p=>p?MN[+p.slice(5,7)-1]+' '+p.slice(0,4):'Всё время';
function shiftM(p,d){const dt=new Date(Date.UTC(+p.slice(0,4),+p.slice(5,7)-1+d,1));return dt.toISOString().slice(0,7);}
function setPer(p){PER=p;localStorage.per=p;refreshView();}
function perStep(d){setPer(shiftM(PER||month(),d));}
function refreshView(){header();if(views[cur])views[cur](window._arg);}
function perBar(){return `<div class="perbar"><button onclick="perStep(-1)">◀</button><span onclick="setPer(PER?'':month())">${esc(perLabel(PER))}</span><button onclick="perStep(1)">▶</button></div>`;}
// Tinkoff Black wallet paired with a card wallet (fixed ids so devices don't duplicate)
const pairOf=id=>{const c=S.accounts.find(a=>a.id!==id&&blackFor(a.id)&&blackFor(a.id).id===id);return c&&c.id;};
const splitOpts=()=>({splitAcc:S.accounts.some(x=>x.id==='ya_split'&&!x.deleted)?'ya_split':null,splitFrom:(liveAccs().find(x=>x.bank==='yandex'&&x.id!=='ya_split'&&!x.deleted)||{}).id});
function blackFor(cardId){if(cardId==='ya_split')return null;const c=S.accounts.find(a=>a.id===cardId);if(!c||/black/i.test(c.name))return null;
  const id=cardId==='mama_t'?'mama_black':cardId==='anya_t'?'anya_black':cardId+'_black';
  return S.accounts.find(a=>a.id===id)||{id,name:c.name.split(/\s+/)[0]+' Black',kind:'card',icon:'🖤',color:'#222',initial:0,cardMask:'',order:50,_new:1};}
// «Входящие = доход»: mom's accounts on by default (one-time), then flag their imported incoming transfers for review (one-time, syncs via put)
async function migIncomeIn(){if(localStorage.migIncomeIn)return;const accs=await raw('accounts');
  for(const a of accs)if(!a.deleted&&(a.id==='mama_black'||a.id==='mama_t'||/^мама/i.test(a.name))&&a.incomeIn===undefined){a.incomeIn=true;await put('accounts',a);}
  const ids=(await raw('accounts')).filter(a=>a.incomeIn&&!a.deleted).map(a=>a.id);
  for(const o of await raw('ops'))if(!o.review&&Core.needsInReview(o,ids)){o.review=1;await put('ops',o);}localStorage.migIncomeIn=1;}
// v45: «Доход с переводов» — fixed-id category + clients' transfer accounts (mama_black, Аня Black, Яндекс, Сбер мамы) default to it
const TR_INC='Доход с переводов';const inCatOf=id=>((S.accounts.find(a=>a.id===id)||{}).inCat)||'Доход';
async function migTrInc(){const cats=await raw('cats');if(!cats.some(c=>c.income&&c.name===TR_INC&&!c.deleted))await putRaw('cats',{id:'inc_transfers',name:TR_INC,income:true,icon:'💳',color:COLORS.inc,order:1.5,updatedAt:1,_dirty:1});
  if(localStorage.migTrInc)return;
  for(const a of await raw('accounts'))if(!a.deleted&&a.inCat===undefined&&(a.id==='mama_black'||a.id==='anya_black'||a.bank==='yandex'||/яндекс|сбер/i.test(a.name))){a.incomeIn=true;a.inCat=TR_INC;await put('accounts',a);}
  const ids=(await raw('accounts')).filter(a=>a.incomeIn&&!a.deleted).map(a=>a.id);
  for(const o of await raw('ops'))if(!o.review&&Core.needsInReview(o,ids)){o.review=1;await put('ops',o);}localStorage.migTrInc=1;}
// v46: user-approved one-time move of 3 «Доход» ops on mama_black to «Доход с переводов»
const TRINC3=['mvy61wzrwtrzy_in','mvy61x3roviqi_in','mvy7dhozf7a11'];
async function migTrInc3(){if(localStorage.migTrInc3)return;for(const o of await raw('ops'))if(TRINC3.includes(o.id)&&!o.deleted&&o.accountId==='mama_black'&&o.type==='income'&&o.category==='Доход'){o.category=TR_INC;await put('ops',o);}localStorage.migTrInc3=1;}
// v41: «Эдвард О.»-style payments wrongly linked as transfer (INB matched any same-amount expense); split into sender expense + receiver income for review
const P2P_FIX={mvy61wzrwtrzy:'anya_t',mvy61x3roviqi:'anya_t'}; // already resolved to income on the receiver by v40; sender from statement
async function migP2P(){if(localStorage.migP2P)return;let n=0;
  for(const o of await raw('ops')){if(o.deleted)continue;let pair=null;
    if(Core.p2pMislink(o))pair=Core.splitP2P(o,o.accountId,o.toAccountId);
    else if(P2P_FIX[o.id]&&o.type==='income'&&(o.bankIds||[]).length>=2&&Core.PERSON.test(o.note||''))pair=Core.splitP2P(o,P2P_FIX[o.id],o.accountId);
    if(!pair)continue;const ex=(await raw('ops')).find(x=>x.id===pair[1].id);if(ex)continue;
    for(const x of pair)await put('ops',x);n++;}
  localStorage.migP2P=1;if(n)setTimeout(()=>toast('Исправлено ошибочных переводов: '+n),1500);}
const inIds=()=>S.accounts.filter(a=>a.incomeIn).map(a=>a.id);
const toReview=id=>S.ops.filter(o=>o.review===1&&!o.deleted&&(!id||o.accountId===id||o.toAccountId===id));
async function resolveIn(oid,cat){const o=S.ops.find(x=>x.id===oid);if(!o)return;
  if(cat){const acc=o.type==='transfer'?o.toAccountId:o.accountId;Object.assign(o,{type:'income',accountId:acc,toAccountId:undefined,category:cat,sides:undefined});}
  o.review=0;await put('ops',o);S.ops=await all('ops');views.inreview(window._arg);header();}
async function ensureAcc(a){if(a&&a._new){delete a._new;await put('accounts',a);S.accounts=await all('accounts');}return a&&a.id;}
const ownOps=()=>S.ops.filter(o=>(o.type==='income'||o.type==='expense')&&Core.OWN.test(o.note||'')&&(blackFor(o.accountId)||pairOf(o.accountId)));
async function migrateOwn(){const xs=ownOps();if(!xs.length)return;if(!confirm('Исправить '+xs.length+' операций «между своими счетами»: сделать переводами карта ⇄ Black (совпадающие записи объединятся)?'))return;
  const gone=new Set();
  // ops on a Black wallet (from its statement): merge with the paired card's record of the same money, else make a transfer
  for(const o of xs.filter(o=>pairOf(o.accountId))){const card=pairOf(o.accountId),want=o.type==='expense'?'income':'expense',d=o.date.slice(0,10);
    const cs=S.ops.filter(x=>!gone.has(x.id)&&x.id!==o.id&&x.type===want&&x.accountId===card&&Math.abs(x.amount-o.amount)<0.005&&Math.abs(new Date(x.date.slice(0,10))-new Date(d))<=864e5)
      .sort((p,q)=>(Core.OWN.test(q.note||'')-Core.OWN.test(p.note||''))||((q.category==='Прочее')-(p.category==='Прочее')));
    const t=o.type==='expense'?{accountId:o.accountId,toAccountId:card}:{accountId:card,toAccountId:o.accountId};
    if(cs.length){const x=cs[0];gone.add(x.id);await put('ops',{...x,type:'transfer',category:'',...t,bankIds:[...(x.bankIds||[]),...(o.bankIds||[])],sides:[card,o.accountId]});
      gone.add(o.id);await put('ops',{id:o.id,deleted:true});}
    else await put('ops',{...o,type:'transfer',category:'',...t,sides:[o.accountId]});}
  for(const o of xs.filter(o=>!pairOf(o.accountId)&&!gone.has(o.id))){const b=await ensureAcc(blackFor(o.accountId));await put('ops',Core.ownToTransfer(o,b));}
  S.ops=await all('ops');toast('Перенесено: '+xs.length);refresh();show('import');}
function opMatch(k,id){if(k==='inc'){const n=itemOf('inc',id).name;return o=>o.type==='income'&&o.category===n;}
  if(k==='exp'){const n=itemOf('exp',id).name;return o=>o.type==='expense'&&o.category===n;}
  return o=>o.accountId===id||o.toAccountId===id;}
function opVal(k,id,o){if(k!=='acc')return o.amount;if(o.type==='transfer')return o.toAccountId===id?o.amount:-o.amount;return o.type==='income'?o.amount:-o.amount;}
function header(){const m=monthSums(PER),b=Core.balances(S.accounts,S.ops);const tot=S.accounts.filter(a=>a.kind!=='savings').reduce((x,a)=>x+(a.credit?Math.max(0,b[a.id]):b[a.id]),0);const debt=S.accounts.filter(a=>a.credit).reduce((x,a)=>x+Math.max(0,-b[a.id]),0);
  $('#top').innerHTML=`<div class="prof" onclick="renameProfile()">${esc(localStorage.profile||'Мои финансы')} ⌄</div><div id="sync" class="${navigator.onLine===false?'off':''}" onclick="syncSheet()" style="position:absolute;right:14px;top:calc(env(safe-area-inset-top) + 12px);font-size:12px;color:#9ab">${esc(syncLabel())}</div>
  <div class="figs"><div><b>Расходы</b><span>${fmt(m.exp)}</span></div><div onclick="show('recon')" style="cursor:pointer"><b>Баланс</b><span>${fmt(tot)}</span>${debt?`<small style="display:block;color:#e57373;font-size:11px">Долг по кредиткам ${fmt(debt)}</small>`:''}</div><div><b>Доходы</b><span>${fmt(m.inc)}</span></div></div>${perBar()}`;
  const n=S.ops.filter(o=>o.reviewed===false).length,bd=$('#badge');bd.textContent=n;bd.style.display=n?'block':'none';}
function renameProfile(){const n=prompt('Название',localStorage.profile||'Мои финансы');if(n){localStorage.profile=n;header();}}
// ---- circles ----
function circ(kind,item,amt){const cls=kind==='inc'?'inc':kind==='exp'?'exp':'acc';
  const style=kind==='acc'||item.color&&item.color!==COLORS[kind]?`background:${item.color}`:'';
  return `<div class="c ${cls}" data-k="${kind}" data-id="${item.id}"><div class="lbl">${esc(item.name)}</div><div class="ic" style="${style}">${esc(item.icon||'•')}</div><div class="amt">${fmt(amt)}</div>${kind==='acc'&&item.credit?`<div class="mut" style="font-size:10px;text-align:center">${item.limit?'доступно '+fmt(+item.limit+(amt||0)):(amt<0?'долг':'')}</div>`:''}</div>`;}
const addCirc=k=>`<div class="c add" data-k="add" data-add="${k}"><div class="lbl">.</div><div class="ic">＋</div><div class="amt"> </div></div>`;
const COLS=()=>Math.max(4,Math.min(12,Math.floor(((document.querySelector('main')||document.body).clientWidth||360)/105)));
let _cols=0;addEventListener('resize',()=>{if(COLS()!==_cols&&cur==='home')show('home');});
function pager(items,per,id){const cols=_cols=COLS();per=per/4*cols;const pages=[];for(let i=0;i<items.length;i+=per)pages.push(items.slice(i,i+per));if(!pages.length)pages.push([]);
  return `<div class="pager" id="${id}" onscroll="dots(this)">${pages.map(p=>`<div class="page" style="grid-template-columns:repeat(${cols},1fr)">${p.join('')}</div>`).join('')}</div><div class="dots">${pages.length>1?pages.map((_,i)=>`<i class="${i?'':'on'}"></i>`).join(''):''}</div>`;}
function dots(el){const i=Math.round(el.scrollLeft/el.clientWidth);el.nextElementSibling.querySelectorAll('i').forEach((d,j)=>d.classList.toggle('on',i===j));}
const views={
inreview(id){const L=toReview(id).sort((a,b)=>b.date.localeCompare(a.date));V.innerHTML=`<div class="hdr"><h2>❓ Разобрать входящие</h2><button onclick="show('home')">‹ Назад</button></div>
  <div class="mut">${id?esc(accName(id))+': ':''}входящие, которые нужно разобрать. Выберите категорию или оставьте как есть.</div>
  ${L.length?L.map(o=>`<div class="card"><div>${esc(o.note||'')} <b class="pos">+${fmt(o.amount)}</b></div><div class="mut">${o.date.slice(0,10)} · ${o.type==='transfer'?esc(accName(o.accountId))+' → '+esc(accName(o.toAccountId)):'→ '+esc(accName(o.accountId))}</div>
   <div class="seg">${(c=>`<button onclick="resolveIn('${o.id}','${c}')">${c}</button>`)(inCatOf(o.type==='transfer'?o.toAccountId:o.accountId))}<button onclick="resolveIn('${o.id}','Прочее')">Прочее</button><button onclick="resolveIn('${o.id}','')">${o.type==='transfer'?'Оставить перевод':'Оставить'}</button></div></div>`).join(''):'<div class="card">Всё разобрано 👍</div>'}`;},
recon(){reconSheet();},
detail(a){a=a||window._arg;if(a)detail(a.k,a.id);},
home(){const m=monthSums(PER),b=Core.balances(S.accounts,S.ops);
  const inc=S.cats.filter(c=>c.income).map(c=>circ('inc',c,m.byInc[c.name]));inc.push(addCirc('inc'));
  const acc=liveAccs().map(a=>circ('acc',a,b[a.id]));acc.push(addCirc('acc'));
  const ex=S.cats.filter(c=>!c.income).map(c=>circ('exp',c,m.byCat[c.name]));ex.push(addCirc('exp'));
  V.innerHTML=`<div class="sect">${pager(inc,4,'p1')}</div><div class="sect">${pager(acc,4,'p2')}</div><div class="sect" style="border:0">${pager(ex,12,'p3')}</div>
  <div class="mut" style="text-align:center;margin-top:6px">Перетащите кружок на другой: доход → кошелёк, кошелёк → кошелёк, кошелёк → категория. Удержание — настройка.</div>`;},
stats(){const m=window._month||month(),s=monthSums(m);const rows=Object.entries(s.byCat).sort((a,b)=>b[1]-a[1]);const ic=n=>(S.cats.find(c=>c.name===n&&!c.income)||{}).icon||'•';
  V.innerHTML=`<div class="hdr"><h2>Обзор</h2></div><div class="card"><input type="month" value="${m}" onchange="window._month=this.value;views.stats()">
  <div class="row"><span>Доходы</span><b class="pos">${fmt(s.inc)}</b></div><div class="row"><span>Расходы</span><b class="neg">${fmt(s.exp)}</b></div><div class="row"><span>Итог</span><b>${fmt(s.inc-s.exp)}</b></div></div>
  <div class="card">${rows.map(([k,v])=>`<div class="row"><span>${esc(ic(k))} ${esc(k)}</span><span>${fmt(v)} <span class="mut">${Math.round(v/s.exp*100)}%</span></span></div><div style="height:4px;background:#6fe3df;width:${v/s.exp*100}%;border-radius:2px"></div>`).join('')||'<div class="mut">Нет расходов</div>'}</div>`;},
history(){const hf=window._hf||{};const f=hf.k?opMatch(hf.k,hf.id):()=>true;const list=[...S.ops].filter(o=>f(o)&&(!hf.m||o.date.startsWith(hf.m))).sort(Core.opCmp);const n=list.filter(o=>o.reviewed===false).length;const g={};list.forEach(o=>(g[o.date.slice(0,10)]=g[o.date.slice(0,10)]||[]).push(o));
  V.innerHTML=`<div class="hdr"><h2>История</h2><div><button onclick="show('import')">⤓ Импорт</button> <button onclick="menu()">⋯</button></div></div>${histFilter()}
  ${n?`<div class="card" style="display:flex;justify-content:space-between;align-items:center"><span>Новых из банка: <b>${n}</b></span><button class="b s" style="width:auto;margin:0;font-size:14px" onclick="markAll()">Всё верно</button></div>`:''}
  ${Object.entries(g).map(([d,ops])=>{const sum=ops.reduce((x,o)=>x+(o.type==='expense'?-o.amount:o.type==='income'?o.amount:0),0);
   return `<div class="dayh" data-d="${d}"><span>${new Date(d).toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'short'})}</span><span>${fmt(sum)}</span></div>${ops.map(hrow).join('')}`;}).join('')||'<div class="card mut">Пока пусто. Перетащите кружок на главном экране или загрузите выписку.</div>'}`;},
import(){V.innerHTML=`<div class="hdr"><h2>Импорт <span class="mut" style="font-size:13px">версия ${APP_VER}</span></h2><button onclick="show('history')">‹ Назад</button></div>
  <div class="card"><b>1. Выписка банка</b><p class="mut">В приложении Т‑Банка: Счёт → Выписка → CSV. Повторная или пересекающаяся выписка дублей не создаст. <b>Это добавляет операции банка в приложение.</b> Для переноса из CoinKeeper используйте блок 3, а не этот.</p>${(()=>{const n=S.ops.filter(o=>(o.bankIds||[]).some(b=>!String(b).startsWith('ck:'))&&!(o.bankIds||[]).some(b=>String(b).startsWith('ck:'))).length;return n?`<div class="mut">Сейчас в приложении операций из выписок: ${n}. <button class="b s" onclick="delBankOps()">Удалить их</button></div>`:'';})()}
  <label class="mut">Если в файле нет номера карты — на какой счёт</label><select id="csv_acc">${bankAccs().map(a=>`<option value="${a.id}">${esc(a.name)} · ${esc((BANKS.find(b=>b[0]===bankOf(a))||[])[1]||'')}</option>`).join('')}</select>
  <label class="b">Выбрать файл выписки<input type="file" accept=".csv,text/csv,.pdf,application/pdf" hidden onchange="doImport(this.files[0])"></label>
  <div class="mut">Т‑Банк — CSV. Яндекс Банк — PDF «Выписка по договору» (Профиль → Справки → Выписка по договору). Яндекс — бета: если что-то распознается не так, пришлите пример выписки.</div>
  <button class="b s" onclick="editCirc('acc')">+ Добавить счёт</button></div>
  ${ownOps().length?`<div class="card"><b>Счета Tinkoff Black</b><p class="mut">Операции «между своими счетами Т‑Банка» записаны как доход/расход. На самом деле это переводы с/на счёт Black (Мама Black, Аня Black).</p><button class="b" onclick="migrateOwn()">Перенести переводы между своими счетами на Black (${ownOps().length} операций)</button></div>`:''}
  <div class="card"><b>2. Скриншоты списка операций</b><p class="mut">Скриншоты экрана «Операции» Т‑Банка, можно несколько. Распознавание идёт на телефоне.</p>
  <label class="mut">На какой счёт</label><select id="ss_acc">${bankAccs().map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
  <label class="b">Выбрать скриншоты<input type="file" accept="image/*" multiple hidden onchange="doShots(this.files)"></label><div id="ss_prog" class="mut"></div></div>
  <div id="ssedit"></div><div id="review"></div>`;}
};
function opIcon(o){if(o.type==='transfer'){const a=S.accounts.find(x=>x.id===o.toAccountId)||{};return [a.icon||'⇄',a.color||'#555'];}
  const c=S.cats.find(x=>x.name===o.category&&x.income===(o.type==='income'))||{};return [c.icon||'•',o.type==='income'?COLORS.inc:COLORS.exp];}
function hrow(o){const[ic,col]=opIcon(o);const t=o.type==='transfer'?`${accName(o.accountId)} → ${accName(o.toAccountId)}`:o.category||'Без категории';
  const sub=o.type==='transfer'?'Перевод':o.type==='income'?`→ ${accName(o.accountId)}`:accName(o.accountId);
  return `<div class="hrow ${o.reviewed===false?'new':''}" data-id="${o.id}" onclick="editOp('${o.id}')"><div class="mini" style="background:${col}">${esc(ic)}</div>
  <div class="t"><div>${esc(t)}</div><div class="mut">${esc(sub)}${o.note?' · '+esc(o.note):''} ${(o.bankIds||[]).some(b=>!String(b).startsWith('ck:'))?'<span class="tag">банк</span>':''}${o.review===1?' <span class="tag q">❓ разобрать</span>':''}</div>${o.comment?`<div class="mut com">💬 ${esc(o.comment)}</div>`:''}</div>
  <b class="${o.type==='expense'?'neg':o.type==='income'?'pos':''}">${o.type==='expense'?'−':o.type==='income'?'+':''}${fmt(o.amount)}</b></div>`;}
async function markAll(){for(const o of S.ops)if(o.reviewed===false){o.reviewed=true;await put('ops',o);}refresh();}
function menu(){openSheet(`<b>Меню</b><button class="b s" onclick="closeSheet();show('recon')">Сверить остатки</button><button class="b s" onclick="closeSheet();editCirc('acc')">+ Добавить счёт</button>${S.accounts.some(a=>a.archived)?`<div class="mut">Архив: ${S.accounts.filter(a=>a.archived).map(a=>`<a href="#" onclick="closeSheet();editCirc('acc','${a.id}');return false">${esc(a.name)}</a>`).join(', ')}</div>`:''}<button class="b s" onclick="closeSheet();show('import')">Импорт CSV / скриншоты</button>
  <button class="b s" onclick="exportJSON()">Скачать резервную копию (JSON)</button><label class="b s">Восстановить из JSON<input type="file" accept=".json" hidden onchange="importJSON(this.files[0])"></label>
  <button class="b s" onclick="syncSheet()">☁ Синхронизация</button><button class="b s" onclick="closeSheet();renameProfile()">Название профиля</button><button class="b s" onclick="closeSheet()">Закрыть</button>`);}
// ---- operation sheet with numpad ----
let E=null;
function opSheet(o){E={type:'expense',amount:'',accountId:S.accounts[0].id,toAccountId:(S.accounts[1]||S.accounts[0]).id,category:'',date:today(),note:'',comment:'',...o};
  if(E.amount!==''&&typeof E.amount==='number')E.amount=String(E.amount).replace('.',',');
  if(!E.category){const c=S.cats.find(c=>c.income===(E.type==='income'));E.category=c?c.name:'';}renderOp();}
function opDateStrip(){const sel=E.date.slice(0,10),base=new Date(sel+'T12:00:00'),out=[];const td=today().slice(0,10);
  for(let i=-4;i<=2;i++){const d=new Date(base);d.setDate(d.getDate()+i);const iso=d.toISOString().slice(0,10);
    out.push(`<button class="${iso===sel?'on':''}" onclick="opSetDate('${iso}')"><small>${iso===td?'сегодня':d.toLocaleDateString('ru-RU',{weekday:'short'})}</small>${d.getDate()}<small>${d.toLocaleDateString('ru-RU',{month:'short'}).replace('.','')}</small></button>`);}
  return out.join('');}
function opSetDate(iso){if(!iso)return;E.date=iso+(E.date.length>10?E.date.slice(10):'');$('#op_dates').innerHTML=opDateStrip();const c=$('#op_dates .on');if(c)c.scrollIntoView({inline:'center',block:'nearest'});}
function opCard(kind,label){const b=Core.balances(S.accounts,S.ops);const cats=S.cats.filter(c=>c.income===(E.type==='income'));
  if(kind==='acc'){const f=label==='to'?'toAccountId':'accountId';const a=S.accounts.find(x=>x.id===E[f])||{};
    return `<label class="opc"><small>${label==='to'?'На счёт':'Со счёта'}</small><b>${esc(a.icon||'💳')} ${esc(a.name||'')}</b><small>${fmt(b[a.id]||0)}</small><select onchange="E.${f}=this.value;renderOp()">${accOpts(E[f])}</select></label>`;}
  const c=cats.find(x=>x.name===E.category)||{};
  return `<label class="opc"><small>${E.type==='income'?'Источник':'Категория'}</small><b>${esc(c.icon||'•')} ${esc(E.category||'—')}</b><small>&nbsp;</small><select onchange="E.category=this.value;renderOp()">${cats.map(x=>`<option value="${esc(x.name)}" ${x.name===E.category?'selected':''}>${esc(x.icon||'')} ${esc(x.name)}</option>`).join('')}</select></label>`;}
function renderOp(){const cls=E.type==='expense'?'neg':E.type==='income'?'pos':'';
  openSheet(`<div class="oph"><button onclick="closeSheet()">✕</button><b>${E.id?'Операция':'Новая операция'}</b>${E.id?`<span><button onclick="moveOpUI(-1)" title="Выше">↑</button><button onclick="moveOpUI(1)" title="Ниже">↓</button></span>`:'<span></span>'}</div>
  <div class="seg">${[['expense','Расход'],['income','Доход'],['transfer','Перевод']].map(([k,n])=>`<button class="${E.type===k?'on':''}" onclick="opType('${k}')">${n}</button>`).join('')}</div>
  <div class="opcards">${E.type==='income'?opCard('cat')+'<span>→</span>'+opCard('acc'):E.type==='transfer'?opCard('acc')+'<span>→</span>'+opCard('acc','to'):opCard('acc')+'<span>→</span>'+opCard('cat')}</div>
  <div class="opamt ${cls}"><input id="op_amt" inputmode="decimal" placeholder="0" value="${esc(E.amount)}" oninput="opAmt(this.value)"><span>₽</span></div>
  <div class="opdates"><div id="op_dates">${opDateStrip()}</div><label class="opcal">📅<input type="date" value="${E.date.slice(0,10)}" onchange="opSetDate(this.value)"></label></div>
  <input class="opnote" placeholder="Описание / получатель" value="${esc(E.note||'')}" oninput="E.note=this.value">
  <textarea class="opcom" rows="2" placeholder="Напишите комментарий" oninput="E.comment=this.value">${esc(E.comment||'')}</textarea>
  <div class="opbtns">${E.id?`<button class="b r" onclick="delOp('${E.id}')">Удалить</button>`:''}<button class="b" onclick="saveOp()">${E.id?'Сохранить':'Готово'}</button></div>`);
  const c=$('#op_dates .on');if(c)c.scrollIntoView({inline:'center',block:'nearest'});if(!E.id)setTimeout(()=>{const i=$('#op_amt');if(i)i.focus();},250);}
function opType(k){if(k===E.type)return;const other=id=>(S.accounts.find(a=>a.id!==id)||{}).id;
  if(k==='transfer'){if(E.type==='income'){E.toAccountId=E.accountId;E.accountId=other(E.accountId);}else if(!E.toAccountId||E.toAccountId===E.accountId)E.toAccountId=other(E.accountId);}
  else if(E.type==='transfer'&&k==='income')E.accountId=E.toAccountId||E.accountId;
  E.type=k;E.category='';opSheet(E);}
async function moveOpUI(dir){const list=(LASTLIST.some(o=>o.id===E.id)?LASTLIST:S.ops).map(o=>S.ops.find(x=>x.id===o.id)||o);
  const ch=Core.moveOp(list,E.id,dir);if(!ch.length)return toast(dir<0?'Уже первая за день':'Уже последняя за день');
  for(const o of ch){const cur=S.ops.find(x=>x.id===o.id);Object.assign(cur,{date:o.date});await put('ops',{...cur});if(o.id===E.id)E.date=o.date;}
  S.ops=await all('ops');LASTEDIT=E.id;keepPlace(refreshView);toast(dir<0?'Поднято':'Опущено');}
function key(k){let a=E.amount||'';if(k==='⌫')a=a.slice(0,-1);else if(k===','){if(!a.includes(','))a=(a||'0')+',';}else if(!/,\d\d$/.test(a))a=a==='0'?k:a+k;E.amount=a;$('#disp').textContent=(a||'0')+' ₽';}
// v49: the old inline handler lived inside a template string, so its /[^\d,]/ lost the backslash and became /[^d,]/ — every digit was stripped
function opAmt(v){E.amount=String(v||'');}
async function saveOp(){const inp=$('#op_amt');if(inp)E.amount=inp.value;const a=Core.parseAmount(E.amount);if(!(a>0))return toast('Введите сумму');
  if(E.type==='transfer'&&(!E.toAccountId||!E.accountId))return toast('Выберите оба счёта');
  if(E.type==='transfer'&&E.accountId===E.toAccountId)return toast('Счета должны различаться');
  const old=S.ops.find(o=>o.id===E.id)||{};
  const o={...old,id:E.id||uid(),type:E.type,amount:a,accountId:E.accountId,toAccountId:E.type==='transfer'?E.toAccountId:undefined,date:E.date,category:E.type==='transfer'?'':E.category,note:E.note,comment:(E.comment||'').trim()||undefined,bankIds:old.bankIds||[],reviewed:true};
  if(o.type==='transfer'){const d=Core.findDupTransfer(S.ops,o);
    if(d&&confirm(`Такой перевод уже есть (${String(d.date).slice(0,10)}, ${d.note||accName(d.accountId)+' → '+accName(d.toAccountId)}). Удалить эту как дубль?\n\nОК — удалить эту, Отмена — оставить обе.`)){
      if(old.id){const ids=(old.bankIds||[]).filter(b=>!(d.bankIds||[]).includes(b));if(ids.length){d.bankIds=[...(d.bankIds||[]),...ids];await put('ops',d);}await del('ops',old.id);}
      closeSheet();refresh();toast('Дубль удалён');return;}}
  await put('ops',o);closeSheet();refresh();toast('Сохранено');}
async function delOp(id){if(!confirm('Удалить операцию?'))return;await del('ops',id);closeSheet();refresh();}
async function editOp(id){LASTEDIT=id;const o=S.ops.find(x=>x.id===id);if(o.reviewed===false){o.reviewed=true;await put('ops',o);header();}opSheet({...o});}
async function refresh(){S.ops=await all('ops');S.accounts=(await all('accounts')).sort(byOrder);S.cats=(await all('cats')).sort(byOrder);keepPlace(refreshView);}
// redraw current view but keep loaded feed size and scroll position (anchored on edited or first visible row)
let LASTEDIT=null;
function keepPlace(fn){const rows=[...document.querySelectorAll('#view .hrow[data-id], .hrow[data-id]')];let a=null;
  const vis=el=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;};
  if(LASTEDIT)a=rows.find(el=>el.dataset.id===LASTEDIT&&vis(el));if(!a)a=rows.find(el=>el.getBoundingClientRect().bottom>0);
  const id=a&&a.dataset.id,top=a&&a.getBoundingClientRect().top,y=scrollY;FEED.min=$('#feed')?FEED.i:0;
  try{fn();}finally{FEED.min=0;}
  let el=id&&document.querySelector('.hrow[data-id="'+CSS.escape(id)+'"]');
  if(!el&&id){const k=FEED.list.findIndex(o=>o.id===id);if(k>=0){while(FEED.i<=k&&feedChunk());el=document.querySelector('.hrow[data-id="'+CSS.escape(id)+'"]');}}
  if(el)scrollTo(0,scrollY+el.getBoundingClientRect().top-top);else scrollTo(0,y);}
// ---- circle edit ----
function itemOf(k,id){return k==='acc'?S.accounts.find(a=>a.id===id):S.cats.find(c=>c.id===id);}
function editCirc(k,id){const it=id?{...itemOf(k,id)}:k==='acc'?{id:uid(),name:'',kind:'card',icon:'💳',color:COLORS.card,initial:0,cardMask:'',order:99}:{id:uid(),name:'',income:k==='inc',icon:k==='inc'?'💵':'🛒',color:COLORS[k],order:99};
  window._ce={k,it,isNew:!id};const t={inc:'Источник дохода',acc:'Кошелёк',exp:'Категория расходов'}[k];
  openSheet(`<b>${id?'':'Новый: '}${t}</b><input id="ce_name" placeholder="Название" value="${esc(it.name)}">
  <div class="flow"><input id="ce_icon" placeholder="Иконка (эмодзи)" value="${esc(it.icon)}" style="width:90px;flex:none;text-align:center;font-size:24px"><div class="mut">Любой эмодзи: 🛒 🍕 🚕 💊 🎁 ✈️ 🐶</div></div>
  <div class="swatch">${PALETTE.map(c=>`<button style="background:${c}" class="${c===it.color?'on':''}" onclick="_ce.it.color='${c}';this.parentNode.querySelectorAll('button').forEach(b=>b.classList.remove('on'));this.classList.add('on')"></button>`).join('')}</div>
  ${k==='acc'?`<label class="mut">Тип</label><select id="ce_kind" onchange="$('#ce_bankw').style.display=$('#ce_credw').style.display=this.value==='card'?'':'none'">${[['card','Банковский счёт / карта'],['cash','Наличные'],['savings','Накопления (не в балансе)']].map(([v,n])=>`<option value="${v}" ${it.kind===v?'selected':''}>${n}</option>`).join('')}</select>
   <div id="ce_bankw" style="${it.kind==='card'?'':'display:none'}"><label class="mut">Банк (какой формат выписки)</label><select id="ce_bank">${BANKS.map(([v,n])=>`<option value="${v}" ${bankOf(it)===v?'selected':''}>${n}</option>`).join('')}</select></div>
   <div id="ce_credw" style="${it.kind==='card'?'':'display:none'}"><label class="row"><span>Кредитная карта</span><input type="checkbox" id="ce_credit" style="width:auto" ${it.credit?'checked':''} onchange="$('#ce_limw').style.display=this.checked?'':'none'"></label>
    <div id="ce_limw" style="${it.credit?'':'display:none'}"><label class="mut">Кредитный лимит, ₽</label><input id="ce_limit" inputmode="decimal" value="${it.limit||''}" placeholder="например 150000"></div></div>
   <label class="mut">${id?'Текущее состояние (если изменить — добавится «Корректировка баланса»)':'Текущее состояние'}</label>
   <div class="flow" style="display:flex;gap:8px"><select id="ce_bmode" style="width:auto">${[['bal','Остаток, ₽'],['debt','Долг, ₽'],['avail','Доступно, ₽']].map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select>
   <input id="ce_init" inputmode="decimal" style="flex:1" value="${id?Math.round(Core.balances(S.accounts,S.ops)[id]*100)/100:''}" placeholder="0"></div>
   <div class="mut">Для кредитки можно ввести долг или «Доступно» из приложения банка — остаток посчитается сам (долг = минус).</div>
   <label class="row"><span>Входящие = доход<br><span class="mut">всё пришедшее на счёт — доход (Доход/Прочее), не перевод</span></span><input type="checkbox" id="ce_incin" style="width:auto" ${it.incomeIn?'checked':''}></label>
   <label class="mut">Последние 4 цифры карты (для импорта)</label><input id="ce_mask" inputmode="numeric" maxlength="4" value="${esc(it.cardMask||'')}" placeholder="1234">`:''}
  <button class="b" onclick="saveCirc()">Сохранить</button>
  ${id?`<div class="flow"><button class="b s" onclick="moveCirc(-1)">← Левее</button><button class="b s" onclick="moveCirc(1)">Правее →</button></div>${k==='acc'?`<button class="b s" onclick="archAcc()">${it.archived?'Вернуть из архива':'В архив (скрыть, операции останутся)'}</button>`:''}<button class="b r" onclick="delCirc()">Удалить</button>`:''}`);}
async function archAcc(){const a=_ce.it;a.archived=!a.archived;await put('accounts',a);closeSheet();refresh();toast(a.archived?'Счёт в архиве':'Счёт возвращён');}
const pnum=s=>parseFloat(String(s||'').replace(',','.').replace(/\s|\u00a0/g,''));
// what the user typed (balance / debt / available) -> wallet balance
const toBal=(a,mode,v)=>isNaN(v)?NaN:mode==='debt'?-Math.abs(v):mode==='avail'?v-(+a.limit||0):v;
// make the wallet show `want` by adding a «Корректировка баланса» operation (keeps history consistent, syncs)
async function setBalance(id,want){const cur=Core.balances(S.accounts,S.ops)[id]||0;const d=Math.round((want-cur)*100)/100;if(Math.abs(d)<0.005)return false;
  const inc=d>0,name='Корректировка баланса';
  if(!S.cats.find(c=>c.name===name&&c.income===inc)){const c={id:(inc?'inc_':'exp_')+'corr',name,income:inc,icon:'⚖️',color:inc?COLORS.inc:COLORS.exp,order:999};await put('cats',c);S.cats.push(c);}
  const o={id:uid(),type:inc?'income':'expense',amount:Math.abs(d),accountId:id,category:name,date:today(),note:name,reviewed:true};await put('ops',o);S.ops.push(o);return true;}
const credInfo=(a,bal)=>a.credit?`${bal<0?'долг '+fmt(-bal):'долга нет'}${a.limit?' · доступно '+fmt(+a.limit+bal):''}`:'';
function reconSheet(){const b=Core.balances(S.accounts,S.ops);V.innerHTML=`<div class="hdr"><h2>Сверить остатки</h2><button onclick="show('home')">‹ Назад</button></div>
  <div class="card mut">Введите реальную сумму из приложения банка или кошелька. Для кредиток можно выбрать «Долг» или «Доступно». Для каждого изменённого счёта добавится операция «Корректировка баланса» на разницу. Пустые поля не меняются.</div>
  <div class="card">${liveAccs().map(a=>`<div class="row" style="flex-wrap:wrap"><span style="flex:1">${esc(a.icon||'')} ${esc(a.name)}<div class="mut">сейчас ${fmt(b[a.id])}${a.credit?' · '+credInfo(a,b[a.id]):''}</div></span>
   ${a.credit?`<select id="rm_${a.id}" style="width:auto"><option value="debt">Долг</option><option value="avail">Доступно</option><option value="bal">Остаток</option></select>`:''}<input id="rb_${a.id}" inputmode="decimal" style="width:120px" placeholder="${a.credit&&b[a.id]<0?Math.round(-b[a.id]*100)/100:Math.round(b[a.id]*100)/100}"></div>`).join('')}</div>
  <button class="b" onclick="saveRecon()">Сохранить</button>`;}
async function saveRecon(){let n=0;for(const a of liveAccs()){const v=pnum(($('#rb_'+a.id)||{}).value);const w=toBal(a,a.credit?$('#rm_'+a.id).value:'bal',v);if(!isNaN(w)&&await setBalance(a.id,w))n++;}
  S.ops=await all('ops');S.cats=await all('cats');S.cats.sort(byOrder);toast('Исправлено счетов: '+n);show('home');}
async function saveCirc(){const{k,it}=_ce;const name=$('#ce_name').value.trim();if(!name)return toast('Введите название');
  const oldName=it.name;it.name=name;it.icon=$('#ce_icon').value.trim()||'•';
  if(k==='acc'){it.kind=$('#ce_kind').value;it.credit=it.kind==='card'&&$('#ce_credit').checked;it.limit=it.credit?(pnum($('#ce_limit').value)||0):0;
    const want=toBal(it,$('#ce_bmode').value,pnum($('#ce_init').value));if(_ce.isNew)it.initial=isNaN(want)?0:want;it.cardMask=$('#ce_mask').value.replace(/\D/g,'');it.incomeIn=$('#ce_incin').checked;if(it.kind==='card')it.bank=$('#ce_bank').value;else delete it.bank;await put('accounts',it);if(!_ce.isNew&&!isNaN(want)){S.accounts=await all('accounts');await setBalance(it.id,want);}}
  else{await put('cats',it);if(oldName&&oldName!==name)for(const o of S.ops)if(o.category===oldName&&(o.type==='income')===it.income){o.category=name;await put('ops',o);}}
  closeSheet();refresh();}
async function moveCirc(d){const{k,it}=_ce;const list=k==='acc'?S.accounts:S.cats.filter(c=>c.income===(k==='inc'));const i=list.findIndex(x=>x.id===it.id),j=i+d;if(j<0||j>=list.length)return;
  [list[i],list[j]]=[list[j],list[i]];const store=k==='acc'?'accounts':'cats';for(let n=0;n<list.length;n++){list[n].order=n;await put(store,list[n]);}refresh();}
async function delCirc(){const{k,it}=_ce;const used=k==='acc'?S.ops.some(o=>o.accountId===it.id||o.toAccountId===it.id):false;
  if(used)return toast('По кошельку есть операции — сначала удалите их');if(!confirm('Удалить «'+it.name+'»?'))return;
  await del(k==='acc'?'accounts':'cats',it.id);closeSheet();refresh();}
let LASTLIST=[];
function dayGroups(list){LASTLIST=list;const g={};[...list].sort(Core.opCmp).forEach(o=>(g[o.date.slice(0,10)]=g[o.date.slice(0,10)]||[]).push(o));
  return Object.entries(g).map(([d,ops])=>{const sum=ops.reduce((x,o)=>x+(o.type==='expense'?-o.amount:o.type==='income'?o.amount:0),0);
   return `<div class="dayh" data-d="${d}"><span>${new Date(d).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:d.slice(0,4)===today().slice(0,4)?undefined:'numeric',weekday:'short'})}</span><span>${fmt(sum)}</span></div>${ops.map(hrow).join('')}`;}).join('');}
function histFilter(){const hf=window._hf||{};const cur=hf.k?hf.k+':'+hf.id:'';
  const opt=(v,t)=>`<option value="${v}" ${v===cur?'selected':''}>${esc(t)}</option>`;
  const months=[...new Set(S.ops.map(o=>o.date.slice(0,7)))].sort().reverse();
  return `<div class="card flow" style="display:flex;gap:8px"><select style="flex:1" onchange="const[k,id]=this.value.split(':');window._hf={...(window._hf||{}),k:k||'',id};views.history()">${opt('','Все операции')}
   <optgroup label="Доходы">${S.cats.filter(c=>c.income).map(c=>opt('inc:'+c.id,c.name)).join('')}</optgroup>
   <optgroup label="Кошельки">${S.accounts.map(c=>opt('acc:'+c.id,c.name)).join('')}</optgroup>
   <optgroup label="Расходы">${S.cats.filter(c=>!c.income).map(c=>opt('exp:'+c.id,c.name)).join('')}</optgroup></select>
   <select style="flex:1" onchange="window._hf={...(window._hf||{}),m:this.value};views.history()"><option value="">Все месяцы</option>${months.map(m=>`<option value="${m}" ${m===hf.m?'selected':''}>${perLabel(m)}</option>`).join('')}</select></div>`;}
// detail of one circle: its operations, period total, per-month totals
function detail(k,id){const it=itemOf(k,id),f=opMatch(k,id);const all=S.ops.filter(f);const ops=all.filter(o=>o.date.startsWith(PER)).sort(Core.opCmp);
  const tot=ops.reduce((s,o)=>s+opVal(k,id,o),0);const bm={};all.forEach(o=>{const m=o.date.slice(0,7);bm[m]=(bm[m]||0)+opVal(k,id,o);});
  const add=k==='inc'?`opSheet({type:'income',category:'${esc(it.name)}'})`:k==='acc'?`opSheet({type:'expense',accountId:'${id}'})`:`opSheet({type:'expense',category:'${esc(it.name)}'})`;
  V.innerHTML=`<div class="hdr"><h2>${esc(it.icon||'')} ${esc(it.name)}</h2><button onclick="show('home')">‹ Назад</button></div>
  <div class="card"><div class="row"><span>${esc(perLabel(PER))}${k==='acc'?' (приход − расход)':''}</span><b class="${k==='exp'?'neg':'pos'}">${fmt(tot)}</b></div>
  <button class="b" onclick="${add.replace(/"/g,'&quot;')}">+ Добавить</button>
  ${k==='acc'?(()=>{const bal=Core.balances(S.accounts,S.ops)[id];return `<div class="row"><span>Остаток сейчас</span><b>${fmt(bal)}</b></div>${it.credit?`<div class="row"><span>Кредитка</span><span>${esc(credInfo(it,bal))}${it.limit?' · лимит '+fmt(it.limit):''}</span></div>`:''}`;})():''}
</div>
  <details class="card" id="bymonth"><summary><b>По месяцам</b> <span class="mut">(нажмите месяц — перейти к нему в ленте)</span></summary>${Object.entries(bm).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>`<div class="row" onclick="feedJump('${m}')" style="cursor:pointer"><span>${perLabel(m)}</span><b>${fmt(v)}</b></div>`).join('')||'<div class="mut">Нет операций</div>'}</details>
  <div class="card"><b>Операции (${all.length})</b>${ops.length?` <span class="mut">· за ${esc(perLabel(PER))}: ${ops.length}</span>`:''}</div><div id="feed"></div><div id="feedmore" class="mut" style="text-align:center;padding:12px"></div>`;
  feedInit([...all].sort(Core.opCmp));}
// continuous lazy feed: whole days per chunk so day totals stay correct
let FEED={list:[],i:0,obs:null};
function feedChunk(){const L=FEED.list;if(FEED.i>=L.length)return false;let j=FEED.i;const N=80;
  while(j<L.length&&(j-FEED.i<N||L[j].date.slice(0,10)===L[j-1].date.slice(0,10)))j++;
  const part=L.slice(FEED.i,j);FEED.i=j;const f=$('#feed');if(!f)return false;
  f.insertAdjacentHTML('beforeend',dayGroups(part));LASTLIST=L;
  const m=$('#feedmore');if(m)m.textContent=FEED.i<L.length?'Загрузка… ('+FEED.i+' из '+L.length+')':(L.length?'Это все операции':'Нет операций');return true;}
function feedInit(list){FEED.list=list;FEED.i=0;LASTLIST=list;if(FEED.obs)FEED.obs.disconnect();feedChunk();while(FEED.i<(FEED.min||0)&&feedChunk());
  const m=$('#feedmore');if(m&&'IntersectionObserver' in window){FEED.obs=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting))feedChunk();},{rootMargin:'800px'});FEED.obs.observe(m);}
  else if(m){m.onclick=feedChunk;}}
function feedJump(m){const L=FEED.list;const idx=L.findIndex(o=>o.date.slice(0,7)<=m);if(idx<0)return;
  while(FEED.i<=idx&&feedChunk());const d=L[idx].date.slice(0,10);const el=[...document.querySelectorAll('#feed .dayh')].find(h=>h.dataset.d===d);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});}
// ---- drag & drop between circles ----
let D=null;
function circAt(x,y){const el=document.elementFromPoint(x,y);return el&&el.closest('.c:not(.add)');}
V.addEventListener('pointerdown',e=>{const c=e.target.closest('.c');if(!c)return;
  D={c,x:e.clientX,y:e.clientY,drag:false,long:setTimeout(()=>{if(D&&!D.drag&&c.dataset.k!=='add'){D.done=true;navigator.vibrate&&navigator.vibrate(20);circMenu(c.dataset.k,c.dataset.id);}},450)};});
V.addEventListener('pointermove',e=>{if(!D||D.done)return;const dx=e.clientX-D.x,dy=e.clientY-D.y;
  if(!D.drag&&Math.hypot(dx,dy)>10){clearTimeout(D.long);if(!e.target.closest('.ic')||D.c.dataset.k==='add'||D.c.dataset.k==='exp'){D=null;return;}
    D.drag=true;const ic=D.c.querySelector('.ic'),g=document.createElement('div');g.id='ghost';g.textContent=ic.textContent;g.style.background=getComputedStyle(ic).backgroundColor;document.body.appendChild(g);D.g=g;
    document.querySelectorAll('.c:not(.add)').forEach(t=>{if(!validDrop(D.c,t))t.classList.add('dim');});}
  if(D.drag){D.g.style.left=e.clientX+'px';D.g.style.top=e.clientY+'px';document.querySelectorAll('.c.hot').forEach(t=>t.classList.remove('hot'));const t=circAt(e.clientX,e.clientY);if(t&&validDrop(D.c,t))t.classList.add('hot');}});
function endDrag(e){if(!D)return;clearTimeout(D.long);const d=D;D=null;document.querySelectorAll('.c').forEach(t=>t.classList.remove('hot','dim'));if(d.g)d.g.remove();if(d.done)return;
  if(d.drag){const t=circAt(e.clientX,e.clientY);if(t&&validDrop(d.c,t))dropOp(d.c,t);return;}
  if(e.type==='pointerup')tapCirc(d.c);}
V.addEventListener('pointerup',endDrag);
// iOS may fire pointercancel during a still long-press: keep the long-press timer alive, track the finger via touch events instead
V.addEventListener('pointercancel',e=>{if(D&&!D.drag&&!D.done){D.cancelled=true;return;}endDrag(e);});
V.addEventListener('touchmove',e=>{if(!D||!D.cancelled||D.done)return;const t=e.touches[0];if(Math.hypot(t.clientX-D.x,t.clientY-D.y)>10){clearTimeout(D.long);D=null;}},{passive:true});
V.addEventListener('touchend',()=>{if(D&&D.cancelled&&!D.done){clearTimeout(D.long);const c=D.c;D=null;tapCirc(c);}});
function validDrop(s,t){const a=s.dataset.k,b=t.dataset.k;if(s===t)return false;return (a==='inc'&&b==='acc')||(a==='acc'&&(b==='acc'||b==='exp'));}
function dropOp(s,t){const a=s.dataset.k,b=t.dataset.k;
  if(a==='inc')opSheet({type:'income',category:itemOf('inc',s.dataset.id).name,accountId:t.dataset.id});
  else if(b==='acc')opSheet({type:'transfer',accountId:s.dataset.id,toAccountId:t.dataset.id});
  else opSheet({type:'expense',accountId:s.dataset.id,category:itemOf('exp',t.dataset.id).name});}
function circMenu(k,id){const it=itemOf(k,id);if(!it)return;const bk=k==='acc'&&bankOf(it),ya=bk==='yandex';
  openSheet(`<b>${esc(it.icon||'')} ${esc(it.name)}</b>
  ${bk?`<label class="b s">📄 Загрузить выписку${ya?' (PDF)':' (CSV)'}<input type="file" accept="${ya?'.pdf,application/pdf':'.csv,text/csv'}" hidden onchange="closeSheet();accImport('${id}',this.files[0])"></label>
  <label class="b s">📷 Загрузить скриншоты<input type="file" accept="image/*" multiple hidden onchange="closeSheet();accShots('${id}',this.files)"></label>`:''}
  ${k==='acc'&&(id==='jetlend'||/jet ?lend/i.test(it.name))?`<label class="b s">📄 Загрузить «Экспорт операций» JetLend (XLSX)<input type="file" accept=".xlsx,.xls" hidden onchange="closeSheet();jlImport('${id}',this.files[0])"></label><label class="b s">📷 Снимок главного экрана JetLend<input type="file" accept="image/*" hidden onchange="closeSheet();jlShots('${id}',[...this.files])"></label>`:''}
  ${k==='acc'&&toReview(id).length?`<button class="b" onclick="closeSheet();show('inreview','${id}')">❓ Не разобрано: ${toReview(id).length}</button>`:''}
  <button class="b s" onclick="closeSheet();window._hf={k:'${k}',id:'${id}',m:PER};show('history')">Открыть в Истории</button>
  <button class="b s" onclick="closeSheet();editCirc('${k}','${id}')">✎ ${k==='acc'?'Изменить счёт / указать остаток':'Изменить'}</button>
  <button class="b s" onclick="closeSheet()">Отмена</button>`);}
function tapCirc(c){const k=c.dataset.k,id=c.dataset.id;
  if(k==='add')return editCirc(c.dataset.add);
  show('detail',{k,id});}
V.addEventListener('contextmenu',e=>{if(e.target.closest('.c'))e.preventDefault();});
// ---- import & review ----
function cardAccFor(card,bank){if(FIX)return FIX;const d=String(card).replace(/\D/g,'').slice(-4);const cards=bankAccs().filter(a=>!bank||bankOf(a)===bank||a.id===($('#csv_acc')||{}).value);
  return (d&&cards.find(a=>a.cardMask&&String(a.cardMask).replace(/\D/g,'').slice(-4)===d)||cards.find(a=>a.id===($('#csv_acc')||{}).value)||cards[0]).id;}
function guessCat(op){if(op.amount>0){const inc=S.cats.filter(c=>c.income);return (inc.find(c=>c.name==='Прочее')||inc[inc.length-1]||{name:'Прочее'}).name;}
  const ex=S.cats.filter(c=>!c.income),t=(op.bankCategory+' '+op.desc).toLowerCase();const m=ex.find(c=>t.includes(c.name.toLowerCase()));if(m)return m.name;
  const map=[[/супермаркет|продукт/,'Продукты'],[/ресторан|кафе|фастфуд/,'Еда вне дома'],[/транспорт|такси|метро|топливо|азс|азк|заправ|zapravki/,'Транспорт'],[/электрон|бытовая техника|различные товары|спорт/,'Покупки'],[/развлеч|кино/,'Развлечения'],[/одежд|маркетплейс|ozon|wildberries/,'Покупки'],[/красот|парикмах/,'парикмахерская'],[/ремонт|дом/,'Ремонт']];
  for(const[r,n]of map)if(r.test(t)&&ex.find(c=>c.name===n))return n;return (ex.find(c=>c.name==='Прочее')||ex[0]||{name:'Прочее'}).name;}
let pending=[];
async function pdfLines(file){toast('Читаю PDF…');const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const doc=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;const out=[];
  for(let p=1;p<=doc.numPages;p++){const tc=await (await doc.getPage(p)).getTextContent();const rows={};
    for(const it of tc.items){if(!it.str.trim())continue;const y=Math.round(it.transform[5]/3);(rows[y]=rows[y]||[]).push(it);}
    Object.keys(rows).map(Number).sort((a,b)=>b-a).forEach(y=>out.push(rows[y].sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>i.str).join(' ')));}
  return out;}
let FIX=null;
function fixTo(id){show('import');FIX=id;const t=$('#review');if(t)t.scrollIntoView();for(const s of ['#csv_acc','#ss_acc'])if($(s))$(s).value=id;}
function accImport(id,f){if(!f)return;fixTo(id);doImport(f);}
function accShots(id,fs){if(!fs||!fs.length)return;fixTo(id);doShots(fs);}
function afterImport(){if(FIX){const id=FIX;FIX=null;show('detail',{k:'acc',id});}else show('history');}
async function doImport(file){const sel=S.accounts.find(a=>a.id===($('#csv_acc')||{}).value)||{};const isPdf=/\.pdf$/i.test(file.name)||file.type==='application/pdf';
  let r;try{if(isPdf||bankOf(sel)==='yandex'){if(!isPdf)return alert('Для Яндекс Банка нужен PDF «Выписка по договору».');r=Core.parseYandexText(await pdfLines(file));r.bank='yandex';}
  else{r=Core.parseTBank(Core.decode(await file.arrayBuffer()));r.bank='tbank';}}catch(e){return alert('Не удалось прочитать файл: '+e.message);}
  if(r.errors.length)return alert(r.errors.join('\n')+(r.bank==='yandex'?'\n\nЯндекс — бета. Пришлите эту выписку, доработаю разбор.':''));
  if(r.bank==='yandex')r.ops.forEach(o=>o.card='');
  // group by card account
  const groups={};r.ops.forEach(o=>{const a=cardAccFor(o.card,r.bank);(groups[a]=groups[a]||[]).push(o);});
  pending=[];for(const a in groups){const st=S.ops.filter(o=>(o.accountId===a||o.toAccountId===a)&&!/корректировка/i.test(o.category||'')).map(o=>o.date.slice(0,10)).sort()[0]||'';
    pending.push(...Core.reconcile(groups[a],S.ops,a,'cash',(blackFor(a)||{}).id,pairOf(a),bankAccs().map(x=>x.id).filter(x=>x!==a),{incomeIn:!!(S.accounts.find(x=>x.id===a)||{}).incomeIn,inCat:inCatOf(a),...splitOpts()}).map(p=>({...p,card:a,old:!!st&&p.op.date.slice(0,10)<st,accept:p.action!=='duplicate'&&!(st&&p.op.date.slice(0,10)<st)})));}
  IMP={closing:r.closing,accs:Object.keys(groups)};renderReview(r.skipped);}
let IMP={};
function scrollEnd(){const e=$('#rv_end');if(e)e.scrollIntoView({behavior:'smooth',block:'end'});}
function updApply(){const b=$('#rv_apply');if(!b)return;const n=[...document.querySelectorAll('#review input[type=checkbox]')].filter(x=>x.checked).length;b.textContent=`${b.dataset.lbl} (${n} операций)`;}
document.addEventListener('change',e=>{if(e.target.closest&&e.target.closest('#review'))updApply();});
function renderReview(skipped){const dup=pending.filter(p=>p.action==='duplicate').length;const L={convert:'Перевод между своими счетами: исправить запись на другом счёте (станет переводом)',link:'Связать с ручной записью',transfer:'Перевод между счетами',add:'Новая операция'};
  $('#review').innerHTML=`<div class="card"><b>Проверка</b><div class="mut">Уже загружено ранее (пропущено): ${dup}. Отклонённых/неуспешных строк: ${skipped}.</div>${pending.some(p=>p.old)?`<div class="mut">Строки раньше начала истории счёта (${pending.filter(p=>p.old).length}) не отмечены: они уже учтены в начальном остатке.</div>`:''}</div>
  ${['convert','link','transfer','add'].map(k=>{const it=pending.map((p,i)=>[p,i]).filter(([p])=>p.action===k);if(!it.length)return'';
   return `<div class="card"><b>${L[k]} (${it.length})</b>${it.map(([p,i])=>{const t=p.target&&S.ops.find(o=>o.id===p.target);
    return `<label class="row"><input type="checkbox" style="width:auto" ${p.accept?'checked':''} onchange="pending[${i}].accept=this.checked"><div style="flex:1"><div>${esc(p.op.desc)}</div><div class="mut">${p.op.date.slice(0,10)} · ${esc(p.op.bankCategory)}${t?`<br>↔ ваша запись: ${t.date.slice(0,10)} ${fmt(t.amount)} ${esc(t.category||t.note||'')}`:''}${p.pick?`<br>${p.from?esc(accName(p.from))+' → ':''}<select style="width:auto;font-size:14px;padding:4px" onchange="pending[${i}][pending[${i}].from===pending[${i}].card?'to':'from']=this.value||null"><option value="">— выберите счёт —</option>${S.accounts.filter(a=>a.id!==p.card).map(a=>`<option value="${a.id}" ${(p.from===p.card?p.to:p.from)===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select>${p.to===p.card?' → '+esc(accName(p.to)):''}`:k==='transfer'||k==='convert'?`<br>${esc(accName(p.from))} → ${esc(accName(p.to))}`:''}</div></div><b class="${p.op.amount<0?'neg':'pos'}">${fmt(p.op.amount)}</b></label>${p.inc?`<div class="seg" style="margin:-4px 0 8px 32px">${[inCatOf(p.card),'Прочее'].map(c=>`<button class="${p.cat===c?'on':''}" onclick="pending[${i}].cat='${c}';renderReview(${skipped})">${c}</button>`).join('')}<select style="width:auto;font-size:13px;padding:4px" onchange="if(this.value){pending[${i}].cat=this.value;renderReview(${skipped})}"><option value="">другая…</option>${S.cats.filter(c=>c.income).map(c=>`<option ${p.cat===c.name?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>`:''}`;}).join('')}
    ${k==='transfer'?'<div class="mut">Снимите галочку, если это не перевод — тогда будет добавлено как обычная операция. Если второй счёт не выбран, перевод сохранится как доход/расход с пометкой — потом поменяйте на «Перевод».</div>':''}</div>`;}).join('')}
  <div class="card"><b>Остаток на счёте</b><div class="mut">${IMP.closing!=null?'В выписке указан остаток — он подставлен.':'В выписке Т‑Банка остатка нет. Введите текущий остаток из приложения банка — баланс кошелька подгоним под него (необязательно).'}</div>
   ${(IMP.accs||[]).map(id=>`<label class="mut">${esc(accName(id))}, ₽</label><input type="number" step="0.01" inputmode="decimal" id="bal_${id}" value="${IMP.closing!=null&&IMP.accs.length===1?IMP.closing:''}">`).join('')}</div>
  <div id="rv_end"></div><div class="stick"><button class="b s" onclick="scrollEnd()">↓ Вниз</button><button class="b" id="rv_apply" data-lbl="Применить" onclick="applyImport()">Применить</button></div>`;setTimeout(updApply);}
let APPLYING=false;
async function applyImport(){if(APPLYING)return;APPLYING=true;const btn=$('#rv_apply');if(btn){btn.disabled=true;btn.textContent='Сохраняю…';}
  try{await applyImport0();}finally{APPLYING=false;pending=[];}}
async function applyImport0(){let n=0;const have=new Set();S.ops.forEach(o=>(o.bankIds||[]).forEach(b=>have.add(b)));const bals={};(IMP.accs||[]).forEach(id=>{const v=parseFloat((($('#bal_'+id)||{}).value||'').replace(',','.'));if(!isNaN(v))bals[id]=v;});
  for(const p of pending){const op=p.op;if(p.action==='duplicate'||have.has(op.bankId))continue;have.add(op.bankId);
  if(p.action==='convert'){const t=S.ops.find(o=>o.id===p.target);if(p.accept){await put('ops',{...t,type:'transfer',category:'',accountId:p.from,toAccountId:p.to,bankIds:[...(t.bankIds||[]),op.bankId],sides:[t.accountId,p.card],note:t.note||op.desc});n++;continue;}}
  if(p.action==='transfer'&&p.pick&&!(p.from&&p.to))p.accept=false;
  if(p.action==='transfer'&&p.accept)for(const x of [p.from,p.to]){const c=S.accounts.find(a=>a.id===x);if(!c){const card=S.accounts.find(a=>blackFor(a.id)&&blackFor(a.id).id===x);if(card)await ensureAcc(blackFor(card.id));}}
  if(p.action==='link'&&p.accept){const t=S.ops.find(o=>o.id===p.target);t.bankIds=[...(t.bankIds||[]),op.bankId];if(p.side)t.sides=[...(t.sides||[]),p.side];await put('ops',t);n++;continue;}
  let o={id:uid(),amount:Math.abs(op.amount),date:op.date,note:op.desc,bankIds:[op.bankId],reviewed:false};
  if(p.action==='transfer'&&p.accept){const d=Core.findDupTransfer(S.ops,{amount:op.amount,accountId:p.from,toAccountId:p.to,date:op.date});
    if(d){if(!(d.bankIds||[]).includes(op.bankId)){d.bankIds=[...(d.bankIds||[]),op.bankId];await put('ops',d);}n++;continue;}
    o={...o,type:'transfer',accountId:p.from,toAccountId:p.to,category:''};}
  else if(p.action==='link'&&!p.accept||p.action==='transfer'&&!p.accept||p.action==='convert'&&!p.accept||p.action==='add'&&p.accept)o={...o,type:op.amount<0?'expense':'income',accountId:p.card,category:p.cat||guessCat(op)};
  else continue;await put('ops',o);n++;}
  S.ops=await all('ops');
  for(const id in bals){const acc=S.accounts.find(a=>a.id===id);if(!acc)continue;const b=Core.balances(S.accounts,S.ops)[id];acc.initial=Math.round(((+acc.initial||0)+bals[id]-b)*100)/100;await put('accounts',acc);}
  S.accounts=await all('accounts');S.accounts.sort(byOrder);toast('Импортировано: '+n);afterImport();}
// ---- JetLend XLSX import ----
let JLP=null;
async function jlImport(id,file){if(!file)return;let rows;try{toast('Читаю XLSX…');const X=await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  const wb=X.read(new Uint8Array(await file.arrayBuffer()),{cellDates:true});rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});}catch(e){return alert('Не удалось прочитать файл: '+e.message);}
  const p=Core.parseJetlend(rows);if(p.errors.length)return alert(p.errors[0]);
  JLP={id,items:Core.planJetlend(p,S.ops,id).filter(i=>i.kind!=='dup').map(i=>({...i,accept:i.kind!=='add'}))};
  show('import');FIX=id;renderJL();}
function renderJL(){const it=JLP.items,L={link:'Пополнения/выводы, уже записанные переводом (свяжутся)',add:'Пополнения/выводы без пары (откуда деньги — неизвестно; отметьте, чтобы записать доходом/расходом на Jetlend)',yield:'Доход по месяцам (проценты − дефолты − НПД)'};
  $('#review').innerHTML=`<div class="card"><b>JetLend: что будет сделано</b><div class="mut">Повторная загрузка не задвоит: месяцы обновятся.</div></div>`+['link','add','yield'].map(k=>{const xs=it.map((x,i)=>[x,i]).filter(([x])=>x.kind===k);if(!xs.length)return'';
   return `<div class="card"><b>${L[k]} (${xs.length})</b>${xs.map(([x,i])=>`<label class="row"><input type="checkbox" style="width:auto" ${x.accept?'checked':''} onchange="JLP.items[${i}].accept=this.checked"><div style="flex:1">${k==='yield'?perLabel(x.m)+(x.target?' (обновить)':''):esc(x.d.date.slice(0,10)+' · '+x.d.op)}</div><b class="${(k==='yield'?x.v:x.d.amount)<0?'neg':'pos'}">${fmt(k==='yield'?x.v:x.d.amount)}</b></label>`).join('')}</div>`;}).join('')+
  `<div id="rv_end"></div><div class="stick"><button class="b s" onclick="scrollEnd()">↓ Вниз</button><button class="b" id="rv_apply" data-lbl="Применить" onclick="applyJL()">Применить</button></div>`;setTimeout(updApply);}
async function applyJL(){const id=JLP.id;let cat=S.cats.find(c=>c.income&&c.name==='Jetlend доход');
  if(!cat&&JLP.items.some(i=>i.kind==='yield'&&i.accept)){cat={id:'inc_jetlend',name:'Jetlend доход',income:true,icon:'📈',color:COLORS.inc,order:90};await put('cats',cat);S.cats.push(cat);}
  let n=0;for(const i of JLP.items){if(!i.accept)continue;
   if(i.kind==='link'){const t=S.ops.find(o=>o.id===i.target);await put('ops',{...t,bankIds:[...(t.bankIds||[]),i.d.bankId]});}
   else if(i.kind==='add')await put('ops',{id:uid(),type:i.d.amount>0?'income':'expense',amount:Math.abs(i.d.amount),accountId:id,category:i.d.amount>0?'Прочее':'Прочее',date:i.d.date,note:'JetLend: '+i.d.op,bankIds:[i.d.bankId],reviewed:false});
   else{const o={type:i.v>=0?'income':'expense',amount:Math.abs(i.v),accountId:id,category:i.v>=0?'Jetlend доход':'Прочее',note:'JetLend доход за '+perLabel(i.m),jlTo:i.to||''};
     const t=i.target&&S.ops.find(x=>x.id===i.target);await put('ops',t?{...t,...o}:{id:uid(),...o,date:i.m+'-28T12:00:00',bankIds:['jl:m:'+i.m],reviewed:false});}n++;}
  JLP=null;S.ops=await all('ops');toast('Готово: '+n);afterImport();}
// ---- JetLend main-screen snapshot: portfolio value + "За все время" -> income since previous snapshot ----
let JLS=null;
async function jlEnsureCat(){let c=S.cats.find(c=>c.income&&c.name==='Jetlend доход');if(!c){c={id:'inc_jetlend',name:'Jetlend доход',income:true,icon:'📈',color:COLORS.inc,order:90};await put('cats',c);S.cats.push(c);}}
// green/blue text on dark: max channel, x2, invert (plain grayscale loses the green "За все время")
async function prepMax(file){const img=await createImageBitmap(file);const c=document.createElement('canvas');c.width=img.width*2;c.height=img.height*2;const x=c.getContext('2d');x.imageSmoothingQuality='high';x.drawImage(img,0,0,c.width,c.height);
  const d=x.getImageData(0,0,c.width,c.height),p=d.data;let s=0;for(let i=0;i<p.length;i+=4){const g=Math.max(p[i],p[i+1],p[i+2]);p[i]=p[i+1]=p[i+2]=g;s+=g;}
  if(s/(p.length/4)<128)for(let i=0;i<p.length;i+=4)p[i]=p[i+1]=p[i+2]=255-p[i];x.putImageData(d,0,0);return c;}
async function jlShots(id,files){if(!files.length)return;show('import');FIX=id;$('#review').innerHTML='<div class="card" id="jls_p">Загружаю распознавание…</div>';
  try{await loadTesseract();const w=await Tesseract.createWorker(['rus','eng'],1,{logger:m=>{if(m.status==='recognizing text')$('#jls_p').textContent=`Распознаю… ${Math.round(m.progress*100)}%`;}});
    let r=null;for(const f of files){const {data}=await w.recognize(await prepMax(f));window._lastOCR=data.text;const p=Core.parseJetlendMain(data.text);if(!r||(p.total!=null&&r.total==null))r=p;}
    await w.terminate();JLS={id,date:today().slice(0,10),...r};renderJLS();
  }catch(e){$('#jls_p').textContent='Ошибка: '+e.message;}}
function jlPlan(){const a=S.accounts.find(x=>x.id===JLS.id);return Core.planJetlendSnap({date:JLS.date,value:JLS.value,total:JLS.total},a.jlSnaps||[],S.ops);}
function renderJLS(){const ok=JLS.value!=null&&JLS.total!=null,P=ok?jlPlan():null;if(P&&JLS.acc==null)JLS.acc=P.accept;if(JLS.bal==null)JLS.bal=true;
  const bal=Core.balances(S.accounts,S.ops)[JLS.id]||0,f=(k,v)=>`<input type="number" step="0.01" inputmode="decimal" style="width:130px" value="${v??''}" onchange="JLS.${k}=this.value===''?null:+this.value;JLS.acc=null;renderJLS()">`;
  $('#review').innerHTML=`<div class="card"><b>Снимок JetLend</b><div class="mut">Проверьте распознанные числа, при ошибке исправьте.</div>
   <div class="row"><div style="flex:1">Дата снимка</div><input type="date" value="${JLS.date}" onchange="JLS.date=this.value;JLS.acc=null;renderJLS()"></div>
   <div class="row"><div style="flex:1">Портфель</div>${f('value',JLS.value)}</div><div class="row"><div style="flex:1">За все время</div>${f('total',JLS.total)}</div></div>
  ${!ok?'<div class="card neg">Не нашёл сумму портфеля или «За все время». Нужен скриншот главного экрана JetLend (блок «Портфель №1»); или впишите числа вручную.</div>':`
  <div class="card">${P.prev?`<div class="mut">Прошлый снимок ${esc(P.prev.date)}: за все время ${fmt(P.prev.total)}</div>`:''}${P.why?`<div class="mut">${esc(P.why)}</div>`:''}
   ${P.prev?`<label class="row"><input type="checkbox" style="width:auto" ${JLS.acc?'checked':''} onchange="JLS.acc=this.checked"><div style="flex:1">Записать доход за ${esc(P.from)} – ${esc(JLS.date)}</div><b class="${P.income<0?'neg':'pos'}">${fmt(P.income)}</b></label>`:''}
   <label class="row"><input type="checkbox" style="width:auto" ${JLS.bal?'checked':''} onchange="JLS.bal=this.checked"><div style="flex:1">Выставить баланс Jetlend = портфель<div class="mut">сейчас в приложении ${fmt(bal)}</div></div><b>${fmt(JLS.value)}</b></label>${P.same?'<div class="mut">Снимок за эту дату уже есть — заменю его.</div>':''}</div>`}
  <div class="card"><b>Что распознано</b>${(JLS.lines||[]).map(l=>`<div class="${l.kind==='other'?'mut':'pos'}" style="font-size:12px">${l.kind==='value'?'💼 ':l.kind==='total'?'📈 ':''}${esc(l.text)}</div>`).join('')}</div>
  <div class="stick"><button class="b" ${ok?'':'disabled'} onclick="applyJLS()">Сохранить снимок</button></div>`;}
async function applyJLS(){const id=JLS.id,P=jlPlan(),a=S.accounts.find(x=>x.id===id);let n=0;
  if(JLS.acc&&P.prev&&Math.abs(P.income)>=0.005){await jlEnsureCat();const k='jl:s:'+JLS.date,ex=S.ops.find(o=>!o.deleted&&(o.bankIds||[]).includes(k));
    const o={type:P.income>=0?'income':'expense',amount:Math.abs(P.income),accountId:id,category:P.income>=0?'Jetlend доход':'Прочее',note:`JetLend доход ${P.from} – ${JLS.date}`};
    await put('ops',ex?{...ex,...o}:{id:uid(),...o,date:JLS.date+'T23:00:00',bankIds:[k],reviewed:true});n++;}
  const snaps=(a.jlSnaps||[]).filter(x=>x.date!==JLS.date).concat([{date:JLS.date,value:JLS.value,total:JLS.total}]).sort((x,y)=>x.date<y.date?-1:1);
  await put('accounts',{...a,jlSnaps:snaps});S.accounts=await all('accounts');S.ops=await all('ops');
  if(JLS.bal&&await setBalance(id,JLS.value))n++;JLS=null;toast('Снимок сохранён'+(n?', операций: '+n:''));afterImport();}
// ---- screenshot import (client-side OCR) ----
let ssRows=[],ssAcc='tbank';
function loadTesseract(){return window.Tesseract?Promise.resolve():new Promise((ok,no)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';sc.onload=ok;sc.onerror=()=>no(new Error('Не удалось загрузить модуль распознавания (нужен интернет при первом запуске)'));document.head.appendChild(sc);});}
// v48: upscale ×2 (max 2400 px wide): small «,18» kopecks survive OCR
async function prep(file){const img=await createImageBitmap(file);const k=Math.max(1,Math.min(2,2400/img.width));const c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);const x=c.getContext('2d');x.imageSmoothingQuality='high';x.drawImage(img,0,0,c.width,c.height);
  const d=x.getImageData(0,0,c.width,c.height),p=d.data;let sum=0;for(let i=0;i<p.length;i+=4){const g=.3*p[i]+.59*p[i+1]+.11*p[i+2];p[i]=p[i+1]=p[i+2]=g;sum+=g;}
  if(sum/(p.length/4)<128)for(let i=0;i<p.length;i+=4){p[i]=p[i+1]=p[i+2]=255-p[i];} // dark theme -> invert
  x.putImageData(d,0,0);return c;}
async function doShots(files){ssAcc=$('#ss_acc').value;const pr=$('#ss_prog');ssRows=[];$('#review').innerHTML='';
  try{pr.textContent='Загружаю распознавание…';await loadTesseract();
    const w=await Tesseract.createWorker(['rus','eng'],1,{logger:m=>{if(m.status==='recognizing text')pr.textContent=`Распознаю… ${Math.round(m.progress*100)}%`;}});
    for(let i=0;i<files.length;i++){pr.textContent=`Скриншот ${i+1} из ${files.length}…`;const {data}=await w.recognize(await prep(files[i]));window._lastOCR=data.text;
      if(ssAcc==='ya_split')Core.parseSplitText(data.text).forEach(o=>ssRows.push({date:o.date.slice(0,10),amount:o.amount,desc:o.kind==='refund'?'Возврат: '+o.desc:o.desc,cat:o.bankCategory,kind:o.kind,shot:i}));
      else Core.parseScreenshotText(data.text).forEach(o=>ssRows.push({date:o.date.slice(0,10),amount:o.amount,desc:o.desc,cat:o.bankCategory,shot:i}));}
    if(ssAcc==='ya_split')ssRows=Core.mergeSplitShots(ssRows);
    await w.terminate();pr.textContent=`Найдено строк: ${ssRows.length}. Проверьте и поправьте ниже.`;renderSS();
  }catch(e){pr.textContent='Ошибка: '+e.message;}}
function renderSS(){$('#ssedit').innerHTML=`<div class="card"><b>Распознанные операции</b><div class="mut">Исправьте дату, сумму (минус — расход) или описание; ✕ удаляет строку.</div>
  ${ssRows.map((r,i)=>`<div style="display:grid;grid-template-columns:118px 1fr 32px;gap:4px;border-bottom:1px solid #eee;padding:4px 0">
   <input type="date" value="${r.date}" onchange="ssRows[${i}].date=this.value" style="font-size:14px;padding:6px">
   <input inputmode="decimal" value="${r.amount}" onchange="ssRows[${i}].amount=parseFloat(this.value.replace(/[−–—]/g,'-').replace(/\\s/g,'').replace(',','.'))||0" class="${r.amount<0?'neg':'pos'}" style="font-size:14px;padding:6px">
   <button class="b s" style="padding:6px;margin:4px 0" onclick="ssRows.splice(${i},1);renderSS()">✕</button>
   <input value="${esc(r.desc)}" onchange="ssRows[${i}].desc=this.value" style="grid-column:1/4;font-size:14px;padding:6px;margin:0"></div>`).join('')}
  <button class="b s" onclick="ssRows.push({date:today(),amount:0,desc:'',cat:'',shot:-1});renderSS()">+ Строка</button>
  <button class="b" onclick="ssToReview()">Далее: проверка дублей</button></div>`;}
function ssToReview(){const rows=ssRows.filter(r=>r.amount&&r.date).map(r=>({...r,date:r.date+'T00:00:00',amount:+r.amount}));
  const ops=Core.shotTimes(Core.screenshotIds(rows)).map(r=>({bankId:r.bankId,date:r.date,amount:r.amount,desc:r.desc,bankCategory:r.cat||'',card:'',mcc:''}));
  IMP={accs:[ssAcc]};pending=Core.reconcile(ops,S.ops,ssAcc,'cash',(blackFor(ssAcc)||{}).id,pairOf(ssAcc),undefined,{incomeIn:!!(S.accounts.find(x=>x.id===ssAcc)||{}).incomeIn,inCat:inCatOf(ssAcc),...splitOpts()}).map(p=>({...p,card:ssAcc,accept:p.action!=='duplicate'}));
  $('#ssedit').innerHTML='';renderReview(0);$("#review").scrollIntoView();}
// ---- CoinKeeper import ----
let CK=null;
const ckSkipped=()=>JSON.parse(localStorage.ckSkipped||'[]');
const APP_VER='v50';
let CKB=[];try{CKB=JSON.parse(localStorage.ckBanks||'[]');}catch(e){CKB=[];}
function ckbStatus(){const el=$('#ckb');if(!el)return;el.innerHTML=CKB.length?'✅ Выписки загружены: '+CKB.map(b=>esc((b.accountId?accName(b.accountId):b.name)+' ('+b.ops.length+' операций)')).join(', ')+' <button class="b s" onclick="CKB=[];localStorage.removeItem(\'ckBanks\');ckbStatus();if(CK){CK=Core.planCoinKeeper(CK.items.map(i=>i.row),{accounts:S.accounts,cats:S.cats,ops:S.ops,skipped:ckSkipped()});CK.items.forEach(i=>{i.accept=i.action===\'add\'||i.action===\'link\'});renderCK();}">Сбросить</button>':'<span class="neg">⚠️ Выписки не загружены — подсказок банка не будет. Сначала нажмите кнопку выше.</span>';}
async function ckBanks(files){CKB=[];for(const f of files){const r=Core.parseTBank(Core.decode(await f.arrayBuffer()));if(r.ops.length)CKB.push({name:f.name,ops:r.ops});}
  if(!CKB.length)toast('В файлах не найдено операций Т‑Банка');
  try{localStorage.ckBanks=JSON.stringify(CKB);}catch(e){}
  if(CK)ckReplan();ckbStatus();}
function ckReplan(){const rows=CK.items.map(i=>i.row);CK=Core.planCoinKeeper(rows,{accounts:S.accounts,cats:S.cats,ops:S.ops,skipped:ckSkipped()});
  CK.items.forEach(i=>{i.accept=i.action==='add'||i.action==='link';});ckSuggest();renderCK();}
function ckSuggest(){if(!CKB.length||!CK)return;CKB.forEach(b=>{const g=Core.guessBankAccount(CK,b.ops);b.accountId=g&&g.accountId;});
  CKB.forEach(b=>{const bl=b.accountId&&blackFor(b.accountId);b.ownAccountId=bl&&bl.id;if(bl&&bl._new&&!CK.newAccounts.find(x=>x.id===bl.id)){const n={...bl};delete n._new;CK.newAccounts.push(n);}});
  const banks=CKB.filter(b=>b.accountId);CK.bankStat=Core.suggestCoinKeeper(CK,banks,S.cats.filter(c=>!c.income).map(c=>c.name));
  CK.bankNote=banks.map(b=>b.name+' → '+accName(b.accountId)).join(', ');
  CK.items.forEach(i=>{if(i.action==='decide'&&i.sugChoice)i.choice=i.sugChoice;});}
async function doCK(file){ckScrolled=false;const {rows,errors}=Core.parseCoinKeeper(Core.decode(await file.arrayBuffer()));if(errors.length)return toast(errors[0]);
  CK=Core.planCoinKeeper(rows,{accounts:S.accounts,cats:S.cats,ops:S.ops,skipped:ckSkipped()});
  CK.items.forEach(i=>{i.accept=i.action==='add'||i.action==='link';});ckSuggest();renderCK();ckbStatus();}
async function delBankOps(){const xs=S.ops.filter(o=>(o.bankIds||[]).length&&(o.bankIds||[]).every(b=>!String(b).startsWith('ck:')));if(!confirm('Удалить '+xs.length+' операций, добавленных из выписок/скриншотов? Ручные и перенесённые из CoinKeeper останутся.'))return;for(const o of xs)await del('ops',o.id);S.ops=await all('ops');toast('Удалено: '+xs.length);show('import');}
// from → to of an item, in words, for the chosen decision
function ckFlow(i){const o=i.op,r=i.row,cashN=accName(CK.cashId);const acc=accName(o.accountId)||r.from||r.to;
  if(i.action==='decide'){const src=i.bankOp&&i.bank&&i.bank.sender?i.bank.sender:'?';
    switch(i.choice){case 'transfer':return i.inflow?cashN+' → '+acc:acc+' → '+cashN;
      case 'card':return i.inflow?accName(i.otherAcc)+' → '+acc:acc+' → '+accName(i.otherAcc);
      case 'income':return 'Доход «'+(i.sugCat||'Прочее')+'»'+(src!=='?'?' (от '+src+')':'')+' → '+acc;
      case 'expense':return acc+' → расход «'+(i.sugCat||'Прочее')+'»';
      default:return (i.inflow?'Поступление на ':'Списание с ')+acc+' — не будет импортировано';}}
  if(o.type==='transfer')return accName(o.accountId)+' → '+accName(o.toAccountId);
  if(o.type==='income')return 'Доход «'+o.category+'» → '+acc;
  return acc+' → '+o.category;}
function ckRow(i,n,extra){const o=i.op,b=i.bankOp;
  const bank=b?`<div class="mut">Банк: ${esc(b.desc||'')}${b.bankCategory?' · '+esc(b.bankCategory):''}</div>`:'';
  const note=[i.row.note,i.hint].filter(Boolean).join(' · ');
  return `<div class="row"><div style="flex:1;min-width:0"><div>${esc(i.row.date)} · <b>${esc(ckFlow(i))}</b></div>${bank}${note?`<div class="mut">${esc(note)}</div>`:''}</div><b class="${i.inflow||o.type==='income'?'pos':''}">${fmt(o.amount)}</b>${extra||''}</div>`;}
function renderCK(){const it=CK.items,g=a=>it.map((x,n)=>[x,n]).filter(([x])=>x.action===a);const dec=g('decide'),pd=g('pairdup'),ln=g('link'),ad=g('add'),dup=g('duplicate');
  const cashN=accName(CK.cashId);
  $('#review').innerHTML=`<div class="card"><b>CoinKeeper: что будет сделано</b>${CKB.length?'':'<div class="neg">⚠️ Выписки Т‑Банка не загружены. Нажмите «Выписки Т‑Банка для подсказок» выше и выберите оба файла — список пересчитается.</div>'}<div class="mut">Строк: ${it.length}. Уже импортировано ранее: ${dup.length}.</div>
   ${CK.newAccounts.length?`<div>Новые кошельки: ${CK.newAccounts.map(a=>esc(a.name)).join(', ')}</div>`:''}${CK.bankStat?`<div>Подсказки по выпискам: ${esc(CK.bankNote)}. Двойной учёт подтверждён банком: ${CK.bankStat.pairConfirmed}; строк без категории распознано: ${CK.items.filter(i=>i.action==='decide'&&i.bank).length}.</div>`:''}${CK.newCats.length?`<div>Новые кружки: ${CK.newCats.map(c=>esc(c.name)+(c.income?' (доход)':'')).join(', ')}</div>`:''}</div>
  ${dec.length?`<div class="card"><b>Нужно решение (${dec.length})</b><div class="mut">Это операции банка, которые CoinKeeper сам подтянул, но вы им не дали категорию. Жирным — куда пойдут деньги при выбранном решении. ${CK.bankStat?"Решение уже подставлено по выписке; проверьте и при необходимости поменяйте в списке справа.":"Выписки не загружены — все строки по умолчанию «Пропустить». Загрузите выписки кнопкой выше, решения подставятся сами."}</div>
   <div class="flow"><button class="b s" onclick="ckAll('skip')">Все: пропустить</button>${CK.bankStat?`<button class="b s" onclick="ckAll('sug')">Все: как в банке</button>`:''}<button class="b s" onclick="ckAll('transfer')">Все: перевод</button><button class="b s" onclick="ckAll('cat')">Все: доход/расход</button></div>
   ${dec.map(([x,n])=>ckRow(x,n,`<select style="width:auto;font-size:14px;padding:6px" onchange="CK.items[${n}].choice=this.value;renderCK()">${[['skip','Пропустить'],['transfer',x.inflow?'Перевод с '+cashN:'Перевод на '+cashN],[x.inflow?'income':'expense',x.inflow?'Доход ('+(x.sugCat||'Прочее')+')':'Расход ('+(x.sugCat||'Прочее')+')'],...(x.otherAcc?[['card',(x.inflow?'Перевод с ':'Перевод на ')+accName(x.otherAcc)]]:[])].map(([v,t])=>`<option value="${v}" ${x.choice===v?'selected':''}>${esc(t)}</option>`).join('')}</select>`)).join('')}</div>`:''}
  ${pd.length?`<div class="card"><b>Похоже на двойной учёт (${pd.length}, ${fmt(pd.reduce((s,[x])=>s+x.op.amount,0))})</b><div class="mut">В один день на карту записаны и перевод с наличных, и доход на ту же сумму — это одно внесение, учтённое дважды. Перевод импортируется всегда, а доход — только если поставите галочку. Обычно галочки ставить не нужно.</div>
   <button class="b s" onclick="CK.items.forEach(i=>{if(i.action==='pairdup')i.accept=!i.accept});renderCK()">Инвертировать отметки</button>
   ${pd.map(([x,n])=>ckRow(x,n,`<input type="checkbox" style="width:auto" ${x.accept?'checked':''} onchange="CK.items[${n}].accept=this.checked">`)).join('')}</div>`:''}
  ${ln.length?`<div class="card"><b>Совпадают с уже загруженными из банка (${ln.length})</b><div class="mut">Будут связаны, а не добавлены.</div>${ln.slice(0,30).map(([x,n])=>ckRow(x,n)).join('')}</div>`:''}
  ${ad.length?`<div class="card"><label class="row"><span><b>Новые операции (${ad.length})</b></span><input type="checkbox" style="width:auto" ${ad[0][0].accept?'checked':''} onchange="CK.items.forEach(i=>{if(i.action==='add')i.accept=this.checked})"></label>${ad.slice(0,20).map(([x,n])=>ckRow(x,n)).join('')}${ad.length>20?`<div class="mut">…и ещё ${ad.length-20}</div>`:''}</div>`:''}
  <div id="rv_end"></div><div class="stick"><button class="b s" onclick="scrollEnd()">↓ Вниз</button><button class="b" id="rv_apply" data-lbl="Импортировать" onclick="applyCK()">Импортировать</button></div>`;setTimeout(updApply);if(!ckScrolled){$('#review').scrollIntoView();ckScrolled=true;}}
let ckScrolled=false;
function ckAll(c){CK.items.forEach(i=>{if(i.action==='decide')i.choice=c==='sug'?(i.sugChoice||i.choice):c==='cat'?(i.inflow?'income':'expense'):c;});renderCK();}
async function applyCK(){const btn=event.target;btn.disabled=true;btn.textContent='Импорт…';
  for(const a of CK.newAccounts)if(!S.accounts.find(x=>x.id===a.id))await put('accounts',{...a});
  for(const c of CK.newCats)if(!S.cats.find(x=>x.id===c.id))await put('cats',{...c});
  const skip=new Set(ckSkipped());let n=0;
  for(const i of CK.items){if(i.action==='duplicate')continue;
    if(i.action==='link'){if(!i.accept)continue;const t=S.ops.find(o=>o.id===i.target);t.bankIds=[...(t.bankIds||[]),...i.op.bankIds];await put('ops',t);n++;continue;}
    let o=i.action==='decide'?Core.decideOp(i,i.choice,CK.cashId):(i.accept?{...i.op}:null);
    if(!o){skip.add(i.row.ckId);continue;}
    await put('ops',{...o,id:uid(),reviewed:true});n++;}
  localStorage.ckSkipped=JSON.stringify([...skip]);CK=null;S.ops=await all('ops');toast('Импортировано: '+n);await refresh();show('history');}
// ---- backup ----
function exportJSON(){const b=new Blob([JSON.stringify({v:1,...S},null,1)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='money-backup-'+today()+'.json';a.click();}
async function importJSON(f){const d=JSON.parse(await f.text());if(!confirm('Заменить все данные копией?'))return;
  for(const s of ['accounts','ops','cats']){for(const x of S[s])await del(s,x.id);for(const x of d[s]||[])await put(s,x);}await load();show('home');}
// ---- nav ----// ---- nav ----
let cur='home';
function show(v,arg){if(v!=='import')FIX=null;cur=v;if(arg!==undefined)window._arg=arg;document.querySelectorAll('#bar nav button').forEach(b=>b.classList.toggle('on',b.dataset.v===v||(v==='import'&&b.dataset.v==='history')));header();views[v](arg);window.scrollTo(0,0);}
document.querySelectorAll('#bar nav button').forEach(b=>b.onclick=()=>show(b.dataset.v));
$('#plus').onclick=()=>opSheet({type:'expense'});
openDB().then(d=>{db=d;return load();}).then(()=>{show('home');runSync();});
if('serviceWorker'in navigator){navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(r=>r.update());let rl=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(rl)return;rl=true;location.reload();});}
