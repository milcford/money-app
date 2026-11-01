// ---- storage (IndexedDB) ----
let db;const S={accounts:[],ops:[],cats:[]};
function openDB(){return new Promise((ok,no)=>{const r=indexedDB.open('money',1);r.onupgradeneeded=()=>{const d=r.result;['accounts','ops','cats'].forEach(s=>d.createObjectStore(s,{keyPath:'id'}));};r.onsuccess=()=>ok(r.result);r.onerror=no;});}
const tx=(s,m='readonly')=>db.transaction(s,m).objectStore(s);
// records carry updatedAt + _dirty (unsynced) ; deletes are tombstones {id,deleted:true} so they sync to other devices
const raw=s=>new Promise(ok=>{const r=tx(s).getAll();r.onsuccess=()=>ok(r.result);});
const all=async s=>(await raw(s)).filter(x=>!x.deleted);
const putRaw=(s,o)=>new Promise(ok=>{const r=tx(s,'readwrite').put(o);r.onsuccess=ok;});
const put=(s,o)=>{o.updatedAt=Math.max(Date.now(),(o.updatedAt||0)+1);o._dirty=1;scheduleSync();return putRaw(s,o);};
const del=(s,id)=>put(s,{id,deleted:true});
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const byOrder=(a,b)=>(a.order??0)-(b.order??0);
const COLORS={inc:'#2c4a9a',cash:'#c9a84c',savings:'#4caf72',card:'#4a3b1c',exp:'#0d2626'};
const PALETTE=['#2c4a9a','#c9a84c','#4caf72','#4a3b1c','#0d2626','#8e44ad','#c0392b','#16a085','#d35400','#555'];
async function ensureBlacks(){const acc=await raw('accounts');for(const x of acc)if((x.id==='mama_t'||x.id==='anya_t')&&x.credit===undefined)await put('accounts',{...x,credit:true,limit:x.limit||0});for(const[id,name,card]of[['mama_black','Мама Black','mama_t'],['anya_black','Аня Black','anya_t']])
  if(acc.some(a=>a.id===card)&&!acc.some(a=>a.id===id))await putRaw('accounts',{id,name,kind:'card',icon:'🖤',color:'#222',initial:0,cardMask:'',order:50,updatedAt:1,_dirty:1});}
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
  await ensureBlacks();
  for(const st of ['accounts','ops','cats'])S[st]=await all(st);S.accounts.sort(byOrder);S.cats.sort(byOrder);}
// ---- sync ----
let syncing=false,syncAgain=false,syncTimer=null,syncMsg='';
// served from our own server -> same origin by default; on GitHub Pages user enters the URL
const SAME_ORIGIN=!/github\.io$/.test(location.hostname)&&location.protocol==='https:';
const syncUrl=()=>(localStorage.syncUrl||(SAME_ORIGIN?location.origin:'')).replace(/\/+$/,'');
function scheduleSync(){clearTimeout(syncTimer);syncTimer=setTimeout(runSync,1500);}
function syncLabel(){if(!syncUrl())return '';if(!localStorage.syncToken)return '⚠ войдите в синхронизацию';if(syncMsg)return syncMsg;
  const t=+localStorage.syncAt;return t?'☁ '+new Date(t).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'☁';}
function setSync(m){syncMsg=m;const e=document.getElementById('sync');if(e)e.textContent=syncLabel();}
async function api(path,body,tok){const r=await fetch(syncUrl()+path,{method:'POST',headers:{'content-type':'application/json',...(tok?{authorization:'Bearer '+tok}:{})},body:JSON.stringify(body||{})});
  const j=await r.json().catch(()=>({}));if(r.status===401&&tok){localStorage.removeItem('syncToken');throw new Error('нужно войти заново');}if(!r.ok)throw new Error(j.error||('ошибка '+r.status));return j;}
async function runSync(){if(!db||!syncUrl()||!localStorage.syncToken)return setSync('');if(syncing){syncAgain=true;return;}syncing=true;setSync('⟳ синхронизация…');
  try{const r=await Sync.syncOnce({db:{raw,put:putRaw},cursor:+localStorage.syncCursor||0,request:b=>api('/api/sync',b,localStorage.syncToken)});
    localStorage.syncCursor=r.cursor;localStorage.syncAt=Date.now();setSync('');if(r.applied)await refresh();}
  catch(e){setSync(navigator.onLine===false?'офлайн':'⚠ '+e.message);}
  syncing=false;if(syncAgain){syncAgain=false;runSync();}}
setInterval(runSync,60000);addEventListener('online',runSync);document.addEventListener('visibilitychange',()=>{if(!document.hidden)runSync();});
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
function blackFor(cardId){const c=S.accounts.find(a=>a.id===cardId);if(!c||/black/i.test(c.name))return null;
  const id=cardId==='mama_t'?'mama_black':cardId==='anya_t'?'anya_black':cardId+'_black';
  return S.accounts.find(a=>a.id===id)||{id,name:c.name.split(/\s+/)[0]+' Black',kind:'card',icon:'🖤',color:'#222',initial:0,cardMask:'',order:50,_new:1};}
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
  $('#top').innerHTML=`<div class="prof" onclick="renameProfile()">${esc(localStorage.profile||'Мои финансы')} ⌄</div><div id="sync" onclick="syncSheet()" style="position:absolute;right:14px;top:calc(env(safe-area-inset-top) + 12px);font-size:12px;color:#9ab">${esc(syncLabel())}</div>
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
history(){const hf=window._hf||{};const f=hf.k?opMatch(hf.k,hf.id):()=>true;const list=[...S.ops].filter(o=>f(o)&&(!hf.m||o.date.startsWith(hf.m))).sort((a,b)=>b.date.localeCompare(a.date));const n=list.filter(o=>o.reviewed===false).length;const g={};list.forEach(o=>(g[o.date.slice(0,10)]=g[o.date.slice(0,10)]||[]).push(o));
  V.innerHTML=`<div class="hdr"><h2>История</h2><div><button onclick="show('import')">⤓ Импорт</button> <button onclick="menu()">⋯</button></div></div>${histFilter()}
  ${n?`<div class="card" style="display:flex;justify-content:space-between;align-items:center"><span>Новых из банка: <b>${n}</b></span><button class="b s" style="width:auto;margin:0;font-size:14px" onclick="markAll()">Всё верно</button></div>`:''}
  ${Object.entries(g).map(([d,ops])=>{const sum=ops.reduce((x,o)=>x+(o.type==='expense'?-o.amount:o.type==='income'?o.amount:0),0);
   return `<div class="dayh"><span>${new Date(d).toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'short'})}</span><span>${fmt(sum)}</span></div>${ops.map(hrow).join('')}`;}).join('')||'<div class="card mut">Пока пусто. Перетащите кружок на главном экране или загрузите выписку.</div>'}`;},
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
  <div class="card"><b>3. Перенос из CoinKeeper (CSV)</b><p class="mut">Экспорт CoinKeeper: Настройки → Экспорт данных → CSV. Кошельки, источники и категории сопоставляются по названию, недостающие создаются. Повторный импорт безопасен.</p>
  <p class="mut">Шаг А: нажмите «Выписки Т‑Банка для подсказок» и выберите <b>оба</b> файла сразу (Аня и Мама). Шаг Б: выберите CSV CoinKeeper. Решения подставятся по банку.</p><label class="b s">А. Выписки Т‑Банка для подсказок<input type="file" accept=".csv,text/csv" multiple hidden onchange="ckBanks(this.files)"></label> <span class="mut" id="ckb"></span>
  <label class="b">Б. Выбрать CSV CoinKeeper<input type="file" accept=".csv,text/csv" hidden onchange="doCK(this.files[0])"></label></div>
  <div id="ssedit"></div><div id="review"></div>`;setTimeout(()=>{ckbStatus();if(CK)renderCK();});}
};
function opIcon(o){if(o.type==='transfer'){const a=S.accounts.find(x=>x.id===o.toAccountId)||{};return [a.icon||'⇄',a.color||'#555'];}
  const c=S.cats.find(x=>x.name===o.category&&x.income===(o.type==='income'))||{};return [c.icon||'•',o.type==='income'?COLORS.inc:COLORS.exp];}
function hrow(o){const[ic,col]=opIcon(o);const t=o.type==='transfer'?`${accName(o.accountId)} → ${accName(o.toAccountId)}`:o.category||'Без категории';
  const sub=o.type==='transfer'?'Перевод':o.type==='income'?`→ ${accName(o.accountId)}`:accName(o.accountId);
  return `<div class="hrow ${o.reviewed===false?'new':''}" onclick="editOp('${o.id}')"><div class="mini" style="background:${col}">${esc(ic)}</div>
  <div class="t"><div>${esc(t)}</div><div class="mut">${esc(sub)}${o.note?' · '+esc(o.note):''} ${(o.bankIds||[]).some(b=>!String(b).startsWith('ck:'))?'<span class="tag">банк</span>':''}</div></div>
  <b class="${o.type==='expense'?'neg':o.type==='income'?'pos':''}">${o.type==='expense'?'−':o.type==='income'?'+':''}${fmt(o.amount)}</b></div>`;}
async function markAll(){for(const o of S.ops)if(o.reviewed===false){o.reviewed=true;await put('ops',o);}refresh();}
function menu(){openSheet(`<b>Меню</b><button class="b s" onclick="closeSheet();show('recon')">Сверить остатки</button><button class="b s" onclick="closeSheet();editCirc('acc')">+ Добавить счёт</button>${S.accounts.some(a=>a.archived)?`<div class="mut">Архив: ${S.accounts.filter(a=>a.archived).map(a=>`<a href="#" onclick="closeSheet();editCirc('acc','${a.id}');return false">${esc(a.name)}</a>`).join(', ')}</div>`:''}<button class="b s" onclick="closeSheet();show('import')">Импорт CSV / скриншоты</button>
  <button class="b s" onclick="exportJSON()">Скачать резервную копию (JSON)</button><label class="b s">Восстановить из JSON<input type="file" accept=".json" hidden onchange="importJSON(this.files[0])"></label>
  <button class="b s" onclick="syncSheet()">☁ Синхронизация</button><button class="b s" onclick="closeSheet();renameProfile()">Название профиля</button><button class="b s" onclick="closeSheet()">Закрыть</button>`);}
// ---- operation sheet with numpad ----
let E=null;
function opSheet(o){E={type:'expense',amount:'',accountId:S.accounts[0].id,toAccountId:(S.accounts[1]||S.accounts[0]).id,category:'',date:today(),note:'',...o};
  if(E.amount!==''&&typeof E.amount==='number')E.amount=String(E.amount).replace('.',',');
  if(!E.category){const c=S.cats.find(c=>c.income===(E.type==='income'));E.category=c?c.name:'';}renderOp();}
function renderOp(){const cats=S.cats.filter(c=>c.income===(E.type==='income'));
  openSheet(`<div class="seg">${[['expense','Расход'],['income','Доход'],['transfer','Перевод']].map(([k,n])=>`<button class="${E.type===k?'on':''}" onclick="E.type='${k}';E.category='';opSheet(E)">${n}</button>`).join('')}</div>
  <div class="flow" style="margin-top:8px">${E.type==='income'?`<select onchange="E.category=this.value">${cats.map(c=>`<option ${c.name===E.category?'selected':''}>${esc(c.name)}</option>`).join('')}</select> → <select onchange="E.accountId=this.value">${accOpts(E.accountId)}</select>`:
   E.type==='transfer'?`<select onchange="E.accountId=this.value">${accOpts(E.accountId)}</select> → <select onchange="E.toAccountId=this.value">${accOpts(E.toAccountId)}</select>`:
   `<select onchange="E.accountId=this.value">${accOpts(E.accountId)}</select> → <select onchange="E.category=this.value">${cats.map(c=>`<option ${c.name===E.category?'selected':''}>${esc(c.icon||'')} ${esc(c.name)}</option>`).join('')}</select>`}</div>
  <div class="disp ${E.type==='expense'?'neg':E.type==='income'?'pos':''}" id="disp">${esc(E.amount||'0')} ₽</div>
  <div class="pad">${['1','2','3','4','5','6','7','8','9',',','0','⌫'].map(k=>`<button onclick="key('${k}')">${k}</button>`).join('')}</div>
  <div class="flow"><input type="date" value="${E.date.slice(0,10)}" onchange="E.date=this.value" style="flex:1"><input placeholder="Комментарий" value="${esc(E.note)}" oninput="E.note=this.value" style="flex:1.4"></div>
  <button class="b" onclick="saveOp()">${E.id?'Сохранить':'Готово'}</button>${E.id?`<button class="b r" onclick="delOp('${E.id}')">Удалить</button>`:''}`);}
function key(k){let a=E.amount||'';if(k==='⌫')a=a.slice(0,-1);else if(k===','){if(!a.includes(','))a=(a||'0')+',';}else if(!/,\d\d$/.test(a))a=a==='0'?k:a+k;E.amount=a;$('#disp').textContent=(a||'0')+' ₽';}
async function saveOp(){const a=parseFloat(String(E.amount).replace(',','.'));if(!(a>0))return toast('Введите сумму');
  if(E.type==='transfer'&&E.accountId===E.toAccountId)return toast('Счета должны различаться');
  const old=S.ops.find(o=>o.id===E.id)||{};
  const o={...old,id:E.id||uid(),type:E.type,amount:a,accountId:E.accountId,toAccountId:E.type==='transfer'?E.toAccountId:undefined,date:E.date,category:E.type==='transfer'?'':E.category,note:E.note,bankIds:old.bankIds||[],reviewed:true};
  await put('ops',o);closeSheet();refresh();toast('Сохранено');}
async function delOp(id){if(!confirm('Удалить операцию?'))return;await del('ops',id);closeSheet();refresh();}
async function editOp(id){const o=S.ops.find(x=>x.id===id);if(o.reviewed===false){o.reviewed=true;await put('ops',o);header();}opSheet({...o});}
async function refresh(){S.ops=await all('ops');S.accounts=(await all('accounts')).sort(byOrder);S.cats=(await all('cats')).sort(byOrder);show(cur);}
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
    const want=toBal(it,$('#ce_bmode').value,pnum($('#ce_init').value));if(_ce.isNew)it.initial=isNaN(want)?0:want;it.cardMask=$('#ce_mask').value.replace(/\D/g,'');if(it.kind==='card')it.bank=$('#ce_bank').value;else delete it.bank;await put('accounts',it);if(!_ce.isNew&&!isNaN(want)){S.accounts=await all('accounts');await setBalance(it.id,want);}}
  else{await put('cats',it);if(oldName&&oldName!==name)for(const o of S.ops)if(o.category===oldName&&(o.type==='income')===it.income){o.category=name;await put('ops',o);}}
  closeSheet();refresh();}
async function moveCirc(d){const{k,it}=_ce;const list=k==='acc'?S.accounts:S.cats.filter(c=>c.income===(k==='inc'));const i=list.findIndex(x=>x.id===it.id),j=i+d;if(j<0||j>=list.length)return;
  [list[i],list[j]]=[list[j],list[i]];const store=k==='acc'?'accounts':'cats';for(let n=0;n<list.length;n++){list[n].order=n;await put(store,list[n]);}refresh();}
async function delCirc(){const{k,it}=_ce;const used=k==='acc'?S.ops.some(o=>o.accountId===it.id||o.toAccountId===it.id):false;
  if(used)return toast('По кошельку есть операции — сначала удалите их');if(!confirm('Удалить «'+it.name+'»?'))return;
  await del(k==='acc'?'accounts':'cats',it.id);closeSheet();refresh();}
function dayGroups(list){const g={};list.forEach(o=>(g[o.date.slice(0,10)]=g[o.date.slice(0,10)]||[]).push(o));
  return Object.entries(g).map(([d,ops])=>{const sum=ops.reduce((x,o)=>x+(o.type==='expense'?-o.amount:o.type==='income'?o.amount:0),0);
   return `<div class="dayh"><span>${new Date(d).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:d.slice(0,4)===today().slice(0,4)?undefined:'numeric',weekday:'short'})}</span><span>${fmt(sum)}</span></div>${ops.map(hrow).join('')}`;}).join('');}
function histFilter(){const hf=window._hf||{};const cur=hf.k?hf.k+':'+hf.id:'';
  const opt=(v,t)=>`<option value="${v}" ${v===cur?'selected':''}>${esc(t)}</option>`;
  const months=[...new Set(S.ops.map(o=>o.date.slice(0,7)))].sort().reverse();
  return `<div class="card flow" style="display:flex;gap:8px"><select style="flex:1" onchange="const[k,id]=this.value.split(':');window._hf={...(window._hf||{}),k:k||'',id};views.history()">${opt('','Все операции')}
   <optgroup label="Доходы">${S.cats.filter(c=>c.income).map(c=>opt('inc:'+c.id,c.name)).join('')}</optgroup>
   <optgroup label="Кошельки">${S.accounts.map(c=>opt('acc:'+c.id,c.name)).join('')}</optgroup>
   <optgroup label="Расходы">${S.cats.filter(c=>!c.income).map(c=>opt('exp:'+c.id,c.name)).join('')}</optgroup></select>
   <select style="flex:1" onchange="window._hf={...(window._hf||{}),m:this.value};views.history()"><option value="">Все месяцы</option>${months.map(m=>`<option value="${m}" ${m===hf.m?'selected':''}>${perLabel(m)}</option>`).join('')}</select></div>`;}
// detail of one circle: its operations, period total, per-month totals
function detail(k,id){const it=itemOf(k,id),f=opMatch(k,id);const all=S.ops.filter(f);const ops=all.filter(o=>o.date.startsWith(PER)).sort((a,b)=>b.date.localeCompare(a.date));
  const tot=ops.reduce((s,o)=>s+opVal(k,id,o),0);const bm={};all.forEach(o=>{const m=o.date.slice(0,7);bm[m]=(bm[m]||0)+opVal(k,id,o);});
  const add=k==='inc'?`opSheet({type:'income',category:'${esc(it.name)}'})`:k==='acc'?`opSheet({type:'expense',accountId:'${id}'})`:`opSheet({type:'expense',category:'${esc(it.name)}'})`;
  V.innerHTML=`<div class="hdr"><h2>${esc(it.icon||'')} ${esc(it.name)}</h2><button onclick="show('home')">‹ Назад</button></div>
  <div class="card"><div class="row"><span>${esc(perLabel(PER))}${k==='acc'?' (приход − расход)':''}</span><b class="${k==='exp'?'neg':'pos'}">${fmt(tot)}</b></div>
  <button class="b" onclick="${add.replace(/"/g,'&quot;')}">+ Добавить</button>
  ${k==='acc'?(()=>{const bal=Core.balances(S.accounts,S.ops)[id];return `<div class="row"><span>Остаток сейчас</span><b>${fmt(bal)}</b></div>${it.credit?`<div class="row"><span>Кредитка</span><span>${esc(credInfo(it,bal))}${it.limit?' · лимит '+fmt(it.limit):''}</span></div>`:''}`;})():''}
  <button class="b s" onclick="window._hf={k:'${k}',id:'${id}',m:PER};show('history')">Открыть в Истории</button>
  <button class="b s" onclick="editCirc('${k}','${id}')">✎ ${k==='acc'?'Изменить счёт / указать остаток':'Изменить'}</button></div>
  <div class="card"><b>Операции (${ops.length})</b></div>${dayGroups(ops.slice(0,300))}${ops.length>300?`<div class="mut">…ещё ${ops.length-300}, см. Историю</div>`:''}
  <div class="card"><b>По месяцам</b>${Object.entries(bm).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>`<div class="row" onclick="setPer('${m}')" style="cursor:pointer"><span>${perLabel(m)}</span><b>${fmt(v)}</b></div>`).join('')||'<div class="mut">Нет операций</div>'}</div>`;}
// ---- drag & drop between circles ----
let D=null;
function circAt(x,y){const el=document.elementFromPoint(x,y);return el&&el.closest('.c:not(.add)');}
V.addEventListener('pointerdown',e=>{const c=e.target.closest('.c');if(!c)return;
  D={c,x:e.clientX,y:e.clientY,drag:false,long:setTimeout(()=>{if(D&&!D.drag&&c.dataset.k!=='add'){D.done=true;navigator.vibrate&&navigator.vibrate(20);editCirc(c.dataset.k,c.dataset.id);}},550)};});
V.addEventListener('pointermove',e=>{if(!D||D.done)return;const dx=e.clientX-D.x,dy=e.clientY-D.y;
  if(!D.drag&&Math.hypot(dx,dy)>10){clearTimeout(D.long);if(!e.target.closest('.ic')||D.c.dataset.k==='add'||D.c.dataset.k==='exp'){D=null;return;}
    D.drag=true;const ic=D.c.querySelector('.ic'),g=document.createElement('div');g.id='ghost';g.textContent=ic.textContent;g.style.background=getComputedStyle(ic).backgroundColor;document.body.appendChild(g);D.g=g;
    document.querySelectorAll('.c:not(.add)').forEach(t=>{if(!validDrop(D.c,t))t.classList.add('dim');});}
  if(D.drag){D.g.style.left=e.clientX+'px';D.g.style.top=e.clientY+'px';document.querySelectorAll('.c.hot').forEach(t=>t.classList.remove('hot'));const t=circAt(e.clientX,e.clientY);if(t&&validDrop(D.c,t))t.classList.add('hot');}});
function endDrag(e){if(!D)return;clearTimeout(D.long);const d=D;D=null;document.querySelectorAll('.c').forEach(t=>t.classList.remove('hot','dim'));if(d.g)d.g.remove();if(d.done)return;
  if(d.drag){const t=circAt(e.clientX,e.clientY);if(t&&validDrop(d.c,t))dropOp(d.c,t);return;}
  if(e.type==='pointerup')tapCirc(d.c);}
V.addEventListener('pointerup',endDrag);V.addEventListener('pointercancel',endDrag);
function validDrop(s,t){const a=s.dataset.k,b=t.dataset.k;if(s===t)return false;return (a==='inc'&&b==='acc')||(a==='acc'&&(b==='acc'||b==='exp'));}
function dropOp(s,t){const a=s.dataset.k,b=t.dataset.k;
  if(a==='inc')opSheet({type:'income',category:itemOf('inc',s.dataset.id).name,accountId:t.dataset.id});
  else if(b==='acc')opSheet({type:'transfer',accountId:s.dataset.id,toAccountId:t.dataset.id});
  else opSheet({type:'expense',accountId:s.dataset.id,category:itemOf('exp',t.dataset.id).name});}
function tapCirc(c){const k=c.dataset.k,id=c.dataset.id;
  if(k==='add')return editCirc(c.dataset.add);
  show('detail',{k,id});}
V.addEventListener('contextmenu',e=>{if(e.target.closest('.c'))e.preventDefault();});
// ---- import & review ----
function cardAccFor(card,bank){const d=String(card).replace(/\D/g,'').slice(-4);const cards=bankAccs().filter(a=>!bank||bankOf(a)===bank||a.id===($('#csv_acc')||{}).value);
  return (d&&cards.find(a=>a.cardMask&&String(a.cardMask).replace(/\D/g,'').slice(-4)===d)||cards.find(a=>a.id===($('#csv_acc')||{}).value)||cards[0]).id;}
function guessCat(op){if(op.amount>0){const inc=S.cats.filter(c=>c.income);return (inc.find(c=>c.name==='Прочее')||inc[inc.length-1]||{name:'Прочее'}).name;}
  const ex=S.cats.filter(c=>!c.income),t=(op.bankCategory+' '+op.desc).toLowerCase();const m=ex.find(c=>t.includes(c.name.toLowerCase()));if(m)return m.name;
  const map=[[/супермаркет|продукт/,'Продукты'],[/ресторан|кафе|фастфуд/,'Еда вне дома'],[/транспорт|такси|метро|топливо|азс/,'Транспорт'],[/развлеч|кино/,'Развлечения'],[/одежд|маркетплейс|ozon|wildberries/,'Покупки'],[/красот|парикмах/,'парикмахерская'],[/ремонт|дом/,'Ремонт']];
  for(const[r,n]of map)if(r.test(t)&&ex.find(c=>c.name===n))return n;return (ex.find(c=>c.name==='Прочее')||ex[0]||{name:'Прочее'}).name;}
let pending=[];
async function pdfLines(file){toast('Читаю PDF…');const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const doc=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;const out=[];
  for(let p=1;p<=doc.numPages;p++){const tc=await (await doc.getPage(p)).getTextContent();const rows={};
    for(const it of tc.items){if(!it.str.trim())continue;const y=Math.round(it.transform[5]/3);(rows[y]=rows[y]||[]).push(it);}
    Object.keys(rows).map(Number).sort((a,b)=>b-a).forEach(y=>out.push(rows[y].sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>i.str).join(' ')));}
  return out;}
async function doImport(file){const sel=S.accounts.find(a=>a.id===($('#csv_acc')||{}).value)||{};const isPdf=/\.pdf$/i.test(file.name)||file.type==='application/pdf';
  let r;try{if(isPdf||bankOf(sel)==='yandex'){if(!isPdf)return alert('Для Яндекс Банка нужен PDF «Выписка по договору».');r=Core.parseYandexText(await pdfLines(file));r.bank='yandex';}
  else{r=Core.parseTBank(Core.decode(await file.arrayBuffer()));r.bank='tbank';}}catch(e){return alert('Не удалось прочитать файл: '+e.message);}
  if(r.errors.length)return alert(r.errors.join('\n')+(r.bank==='yandex'?'\n\nЯндекс — бета. Пришлите эту выписку, доработаю разбор.':''));
  if(r.bank==='yandex')r.ops.forEach(o=>o.card='');
  // group by card account
  const groups={};r.ops.forEach(o=>{const a=cardAccFor(o.card,r.bank);(groups[a]=groups[a]||[]).push(o);});
  pending=[];for(const a in groups){const st=S.ops.filter(o=>(o.accountId===a||o.toAccountId===a)&&!/корректировка/i.test(o.category||'')).map(o=>o.date.slice(0,10)).sort()[0]||'';
    pending.push(...Core.reconcile(groups[a],S.ops,a,'cash',(blackFor(a)||{}).id,pairOf(a),bankAccs().map(x=>x.id).filter(x=>x!==a)).map(p=>({...p,card:a,old:!!st&&p.op.date.slice(0,10)<st,accept:p.action!=='duplicate'&&!(st&&p.op.date.slice(0,10)<st)})));}
  IMP={closing:r.closing,accs:Object.keys(groups)};renderReview(r.skipped);}
let IMP={};
function renderReview(skipped){const dup=pending.filter(p=>p.action==='duplicate').length;const L={convert:'Перевод между своими счетами: исправить запись на другом счёте (станет переводом)',link:'Связать с ручной записью',transfer:'Перевод наличные ⇄ карта',add:'Новая операция'};
  $('#review').innerHTML=`<div class="card"><b>Проверка</b><div class="mut">Уже загружено ранее (пропущено): ${dup}. Отклонённых/неуспешных строк: ${skipped}.</div>${pending.some(p=>p.old)?`<div class="mut">Строки раньше начала истории счёта (${pending.filter(p=>p.old).length}) не отмечены: они уже учтены в начальном остатке.</div>`:''}</div>
  ${['convert','link','transfer','add'].map(k=>{const it=pending.map((p,i)=>[p,i]).filter(([p])=>p.action===k);if(!it.length)return'';
   return `<div class="card"><b>${L[k]} (${it.length})</b>${it.map(([p,i])=>{const t=p.target&&S.ops.find(o=>o.id===p.target);
    return `<label class="row"><input type="checkbox" style="width:auto" ${p.accept?'checked':''} onchange="pending[${i}].accept=this.checked"><div style="flex:1"><div>${esc(p.op.desc)}</div><div class="mut">${p.op.date.slice(0,10)} · ${esc(p.op.bankCategory)}${t?`<br>↔ ваша запись: ${t.date.slice(0,10)} ${fmt(t.amount)} ${esc(t.category||t.note||'')}`:''}${k==='transfer'||k==='convert'?`<br>${esc(accName(p.from))} → ${esc(accName(p.to))}`:''}</div></div><b class="${p.op.amount<0?'neg':'pos'}">${fmt(p.op.amount)}</b></label>`;}).join('')}
    ${k==='transfer'?'<div class="mut">Снимите галочку, если это не наличные — тогда будет добавлено как обычная операция.</div>':''}</div>`;}).join('')}
  <div class="card"><b>Остаток на счёте</b><div class="mut">${IMP.closing!=null?'В выписке указан остаток — он подставлен.':'В выписке Т‑Банка остатка нет. Введите текущий остаток из приложения банка — баланс кошелька подгоним под него (необязательно).'}</div>
   ${(IMP.accs||[]).map(id=>`<label class="mut">${esc(accName(id))}, ₽</label><input type="number" step="0.01" inputmode="decimal" id="bal_${id}" value="${IMP.closing!=null&&IMP.accs.length===1?IMP.closing:''}">`).join('')}</div>
  <button class="b" onclick="applyImport()">Применить</button>`;}
async function applyImport(){let n=0;const bals={};(IMP.accs||[]).forEach(id=>{const v=parseFloat((($('#bal_'+id)||{}).value||'').replace(',','.'));if(!isNaN(v))bals[id]=v;});
  for(const p of pending){const op=p.op;if(p.action==='duplicate')continue;
  if(p.action==='convert'){const t=S.ops.find(o=>o.id===p.target);if(p.accept){await put('ops',{...t,type:'transfer',category:'',accountId:p.from,toAccountId:p.to,bankIds:[...(t.bankIds||[]),op.bankId],sides:[t.accountId,p.card],note:t.note||op.desc});n++;continue;}}
  if(p.action==='transfer'&&p.accept)for(const x of [p.from,p.to]){const c=S.accounts.find(a=>a.id===x);if(!c){const card=S.accounts.find(a=>blackFor(a.id)&&blackFor(a.id).id===x);if(card)await ensureAcc(blackFor(card.id));}}
  if(p.action==='link'&&p.accept){const t=S.ops.find(o=>o.id===p.target);t.bankIds=[...(t.bankIds||[]),op.bankId];if(p.side)t.sides=[...(t.sides||[]),p.side];await put('ops',t);n++;continue;}
  let o={id:uid(),amount:Math.abs(op.amount),date:op.date,note:op.desc,bankIds:[op.bankId],reviewed:false};
  if(p.action==='transfer'&&p.accept)o={...o,type:'transfer',accountId:p.from,toAccountId:p.to,category:''};
  else if(p.action==='link'&&!p.accept||p.action==='transfer'&&!p.accept||p.action==='convert'&&!p.accept||p.action==='add'&&p.accept)o={...o,type:op.amount<0?'expense':'income',accountId:p.card,category:guessCat(op)};
  else continue;await put('ops',o);n++;}
  S.ops=await all('ops');
  for(const id in bals){const acc=S.accounts.find(a=>a.id===id);if(!acc)continue;const b=Core.balances(S.accounts,S.ops)[id];acc.initial=Math.round(((+acc.initial||0)+bals[id]-b)*100)/100;await put('accounts',acc);}
  S.accounts=await all('accounts');S.accounts.sort(byOrder);toast('Импортировано: '+n);show('history');}
// ---- screenshot import (client-side OCR) ----
let ssRows=[],ssAcc='tbank';
function loadTesseract(){return window.Tesseract?Promise.resolve():new Promise((ok,no)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';sc.onload=ok;sc.onerror=()=>no(new Error('Не удалось загрузить модуль распознавания (нужен интернет при первом запуске)'));document.head.appendChild(sc);});}
async function prep(file){const img=await createImageBitmap(file);const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);
  const d=x.getImageData(0,0,c.width,c.height),p=d.data;let sum=0;for(let i=0;i<p.length;i+=4){const g=.3*p[i]+.59*p[i+1]+.11*p[i+2];p[i]=p[i+1]=p[i+2]=g;sum+=g;}
  if(sum/(p.length/4)<128)for(let i=0;i<p.length;i+=4){p[i]=p[i+1]=p[i+2]=255-p[i];} // dark theme -> invert
  x.putImageData(d,0,0);return c;}
async function doShots(files){ssAcc=$('#ss_acc').value;const pr=$('#ss_prog');ssRows=[];$('#review').innerHTML='';
  try{pr.textContent='Загружаю распознавание…';await loadTesseract();
    const w=await Tesseract.createWorker(['rus','eng'],1,{logger:m=>{if(m.status==='recognizing text')pr.textContent=`Распознаю… ${Math.round(m.progress*100)}%`;}});
    for(let i=0;i<files.length;i++){pr.textContent=`Скриншот ${i+1} из ${files.length}…`;const {data}=await w.recognize(await prep(files[i]));window._lastOCR=data.text;
      Core.parseScreenshotText(data.text).forEach(o=>ssRows.push({date:o.date.slice(0,10),amount:o.amount,desc:o.desc,cat:o.bankCategory,shot:i}));}
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
  const ops=Core.screenshotIds(rows).map(r=>({bankId:r.bankId,date:r.date,amount:r.amount,desc:r.desc,bankCategory:r.cat||'',card:'',mcc:''}));
  IMP={accs:[ssAcc]};pending=Core.reconcile(ops,S.ops,ssAcc,'cash',(blackFor(ssAcc)||{}).id,pairOf(ssAcc)).map(p=>({...p,card:ssAcc,accept:p.action!=='duplicate'}));
  $('#ssedit').innerHTML='';renderReview(0);$("#review").scrollIntoView();}
// ---- CoinKeeper import ----
let CK=null;
const ckSkipped=()=>JSON.parse(localStorage.ckSkipped||'[]');
const APP_VER='v22';
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
  <button class="b" onclick="applyCK()">Импортировать</button>`;if(!ckScrolled){$('#review').scrollIntoView();ckScrolled=true;}}
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
function show(v,arg){cur=v;if(arg!==undefined)window._arg=arg;document.querySelectorAll('#bar nav button').forEach(b=>b.classList.toggle('on',b.dataset.v===v||(v==='import'&&b.dataset.v==='history')));header();views[v](arg);window.scrollTo(0,0);}
document.querySelectorAll('#bar nav button').forEach(b=>b.onclick=()=>show(b.dataset.v));
$('#plus').onclick=()=>opSheet({type:'expense'});
openDB().then(d=>{db=d;return load();}).then(()=>{show('home');runSync();});
if('serviceWorker'in navigator){navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(r=>r.update());let rl=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(rl)return;rl=true;location.reload();});}
