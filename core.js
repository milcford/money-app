// Core logic: CSV parsing, hashing, dedup, matching. Works in browser and Node.
(function(root){
const norm=s=>String(s||'').toLowerCase().replace(/[^a-zа-яё0-9]/gi,'');
function decode(buf){ // ArrayBuffer/Uint8Array -> string, utf-8 or cp1251
  const u8=buf instanceof Uint8Array?buf:new Uint8Array(buf);
  let t=new TextDecoder('utf-8',{fatal:false}).decode(u8);
  if((t.match(/\uFFFD/g)||[]).length>2 || !/[а-яё]/i.test(t)) { try{t=new TextDecoder('windows-1251').decode(u8);}catch(e){} }
  return t.replace(/^\uFEFF/,'');
}
function splitCSV(text){
  const first=text.split(/\r?\n/)[0]; const sep=(first.match(/;/g)||[]).length>=(first.match(/,/g)||[]).length?';':',';
  const rows=[];let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){ if(c=='"'){ if(text[i+1]=='"'){f+='"';i++;} else q=false;} else f+=c; }
    else if(c=='"')q=true; else if(c==sep){row.push(f);f='';}
    else if(c=='\n'||c=='\r'){ if(c=='\r'&&text[i+1]=='\n')i++; row.push(f);f=''; if(row.some(x=>x.trim()))rows.push(row); row=[]; }
    else f+=c;}
  row.push(f); if(row.some(x=>x.trim()))rows.push(row); return rows;
}
const num=s=>{s=String(s||'').replace(/\s|\u00a0/g,'').replace(',','.');const n=parseFloat(s);return isNaN(n)?null:n;};
function parseDate(s){ s=String(s||'').trim(); let m=s.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if(m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]||'00'}:${m[5]||'00'}:${m[6]||'00'}`;
  m=s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]||'00'}:${m[5]||'00'}:${m[6]||'00'}`; return null;}
const COLS={date:['датаоперации','дата'],pdate:['датаплатежа'],card:['номеркарты','карта'],status:['статус'],
  amount:['суммаоперации','сумма'],pamount:['суммаплатежа'],currency:['валютаоперации','валюта'],category:['категория'],mcc:['mcc'],desc:['описание','назначение']};
function hash(s){let h1=0xdeadbeef,h2=0x41c6ce57;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677);}
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (h2>>>0).toString(16).padStart(8,'0')+(h1>>>0).toString(16).padStart(8,'0');}
function parseTBank(text){
  const rows=splitCSV(text); if(!rows.length) return {ops:[],skipped:0,errors:['Пустой файл']};
  const hdr=rows[0].map(norm); const idx={};
  for(const k in COLS){ for(const n of COLS[k]){ const i=hdr.findIndex(h=>h===n); if(i>=0){idx[k]=i;break;} }
    if(idx[k]==null) for(const n of COLS[k]){ const i=hdr.findIndex(h=>h.startsWith(n)); if(i>=0){idx[k]=i;break;} } }
  if(idx.date==null||(idx.amount==null&&idx.pamount==null)) return {ops:[],skipped:0,errors:['Не найдены колонки «Дата операции» / «Сумма операции»']};
  const ops=[],seen={};let skipped=0;
  for(const r of rows.slice(1)){
    const g=k=>idx[k]!=null?(r[idx[k]]||'').trim():'';
    const st=g('status').toUpperCase(); if(st&&st!=='OK'&&st!=='ОК'){skipped++;continue;}
    const date=parseDate(g('date')); let amount=num(g('amount')); if(amount==null)amount=num(g('pamount'));
    if(!date||amount==null){skipped++;continue;}
    const card=g('card'),desc=g('desc');
    const base=[date,amount.toFixed(2),norm(desc),card.replace(/\D/g,'')].join('|');
    // identical rows inside one file (genuinely two same purchases) get an occurrence suffix
    seen[base]=(seen[base]||0)+1; const id=hash(base+'#'+seen[base]);
    ops.push({bankId:id,date,amount,currency:g('currency')||'RUB',card,desc,bankCategory:g('category'),mcc:g('mcc')});
  }
  return {ops,skipped,errors:[]};
}

// ---------- Screenshot (OCR text) parser ----------
const MONTHS=['январ','феврал','март','апрел','ма','июн','июл','август','сентябр','октябр','ноябр','декабр'];
const MRE='(январ[яь]|феврал[яь]|марта?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|августа?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь])';
const pad=n=>String(n).padStart(2,'0');
const isoDay=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
// amount: optional sign (various minus chars), digits with spaces as thousands, optional decimals, currency ₽ (OCR: Р, P, р, руб, 2 after space)
const AMT=/([−\-–—‒+])?\s*(\d{1,3}(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|[РPр])\s*$/;
function parseHeader(line,today){
  const l=line.trim().toLowerCase();
  if(/^сегодня(?![а-яё])/.test(l))return isoDay(today);
  if(/^вчера(?![а-яё])/.test(l)){const d=new Date(today);d.setDate(d.getDate()-1);return isoDay(d);}
  const m=l.match(new RegExp('^(\\d{1,2})\\s+'+MRE+'(?:\\s+(\\d{4}))?'));
  if(m){const mi=MONTHS.findIndex((p,i)=>i===4?/^ма[яй]$/.test(m[2]):m[2].startsWith(p));
    let y=m[3]?+m[3]:today.getFullYear(); if(!m[3]&&(mi>today.getMonth()||(mi===today.getMonth()&&+m[1]>today.getDate())))y--;
    return `${y}-${pad(mi+1)}-${pad(+m[1])}`;}
  return null;}
function cleanLine(s){return s.replace(/[|©®@>›»]+/g,' ').replace(/\s+/g,' ').trim();}
function parseScreenshotText(text,today=new Date()){
  const ops=[];let date=null,pendingDesc='';
  for(let raw of String(text).split(/\r?\n/)){
    const line=cleanLine(raw); if(!line)continue;
    const h=parseHeader(line,today); if(h){date=h;pendingDesc='';continue;}
    if(/^(операции|все операции|расходы|доходы|поиск|недавние|главная|платежи|чат|ещё|еще)$/i.test(line))continue;
    const m=line.match(AMT);
    if(m){const desc=line.slice(0,m.index).replace(/[\s—–−‒-]+$/,'').trim()||pendingDesc;
      let v=parseFloat(m[2].replace(/[ \u00a0\u202f]/g,'').replace(',','.')); if(m[1]!=='+')v=-v; // T-Bank: income is "+", everything else is spending
      ops.push({date:(date||isoDay(today))+'T00:00:00',amount:v,desc:desc||'Без описания',bankCategory:'',card:'',src:'screenshot'});pendingDesc='';continue;}
    // text line: category under the previous op, or a merchant name whose amount is on the next line
    const last=ops[ops.length-1];
    if(last&&!last.bankCategory&&!pendingDesc&&last._fresh!==false){last.bankCategory=line;last._fresh=false;}
    else pendingDesc=line;
  }
  ops.forEach(o=>delete o._fresh);return ops;}
// assign stable ids; rows: [{date,amount,desc,shot}]. Identical rows from different screenshots (overlap) collapse; within one shot they stay separate.
function screenshotIds(rows){const cnt={},out=[],seen=new Set();
  for(const r of rows){const base=['s',r.date.slice(0,10),(+r.amount).toFixed(2),norm(r.desc)].join('|');const k=r.shot+'~'+base;cnt[k]=(cnt[k]||0)+1;
    const id='s:'+hash(base+'#'+cnt[k]);if(seen.has(id))continue;seen.add(id);out.push({...r,bankId:id});}
  return out;}
function similar(a,b){a=norm(a).replace(/ё/g,"е");b=norm(b).replace(/ё/g,"е");if(!a||!b)return false;if(a.includes(b)||b.includes(a))return true;
  const bg=s=>{const m=new Map();for(let i=0;i<s.length-1;i++){const g=s.slice(i,i+2);m.set(g,(m.get(g)||0)+1);}return m;};
  const A=bg(a),B=bg(b);let inter=0;A.forEach((v,g)=>inter+=Math.min(v,B.get(g)||0));return 2*inter/(a.length+b.length-2)>=0.5;}
const CASH_IN=/(пополнение.*налич|внесение налич|cash ?in|банкомат.*пополн|пополнение.*банкомат)/i;
const CASH_OUT=/(снятие налич|выдача налич|cash ?out|atm|снятие в банкомате|банкомат)/i;
function isCash(op){const d=(op.desc+' '+op.bankCategory).toLowerCase(); if(op.mcc==='6011'||/налич|банкомат|atm|cash/.test(d)) return op.amount>0?'in':'out'; return null;}
const days=(a,b)=>Math.abs(new Date(a)-new Date(b))/864e5;
// Classify imported ops against existing operations.
// existing: [{id,type,amount(positive),accountId,toAccountId,date,bankIds:[]}], cardAccountId, cashAccountId
function reconcile(imported, existing, cardAcc, cashAcc){
  const known=new Set(); existing.forEach(o=>(o.bankIds||[]).forEach(b=>known.add(b)));
  const used=new Set(); const out=[];
  for(const op of imported){
    if(known.has(op.bankId)){out.push({op,action:'duplicate'});continue;}
    const abs=Math.abs(op.amount), dir=op.amount<0?'out':'in';
    const isSS=String(op.bankId).startsWith('s:');
    // cross-source overlap: screenshot row vs CSV-imported op (or the reverse): same account, amount, date ±1 day, similar description
    const ov=existing.find(o=>!used.has(o.id)&&(o.bankIds||[]).length&&(o.bankIds||[]).every(b=>String(b).startsWith('s:')!==isSS)&&
      Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),op.date.slice(0,10))<=1&&
      (o.accountId===cardAcc||o.toAccountId===cardAcc)&&(similar(o.note,op.desc)||o.type==='transfer'&&isCash(op)));
    if(ov){used.add(ov.id);out.push({op,action:'link',target:ov.id,overlap:true});continue;}
    const cand=existing.filter(o=>!used.has(o.id)&&!(o.bankIds||[]).length&&Math.abs(o.amount-abs)<0.005&&days(o.date,op.date)<=2&&(
      (dir==='out'&&((o.type==='expense'&&o.accountId===cardAcc)||(o.type==='transfer'&&o.accountId===cardAcc)))||
      (dir==='in'&&((o.type==='income'&&o.accountId===cardAcc)||(o.type==='transfer'&&o.toAccountId===cardAcc)))))
      .sort((a,b)=>days(a.date,op.date)-days(b.date,op.date));
    if(cand.length){used.add(cand[0].id);out.push({op,action:'link',target:cand[0].id});continue;}
    const c=isCash(op);
    if(c==='in') out.push({op,action:'transfer',from:cashAcc,to:cardAcc});
    else if(c==='out') out.push({op,action:'transfer',from:cardAcc,to:cashAcc});
    else out.push({op,action:'add',type:dir==='out'?'expense':'income'});
  }
  return out;
}
function balances(accounts,ops){const b={};accounts.forEach(a=>b[a.id]=+a.initial||0);
  for(const o of ops){ if(o.type==='expense')b[o.accountId]-=o.amount; else if(o.type==='income')b[o.accountId]+=o.amount;
    else if(o.type==='transfer'){b[o.accountId]-=o.amount;b[o.toAccountId]+=o.amount;} }
  return b;}
root.Core={parseScreenshotText,screenshotIds,similar,decode,parseTBank,reconcile,balances,hash,isCash};
if(typeof module!=='undefined')module.exports=root.Core;
})(typeof self!=='undefined'?self:globalThis);
