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
  const bi=hdr.findIndex(h=>/^(остаток|баланс)/.test(h));let closing=null,closingDate='';
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
    if(bi>=0){const b=num((r[bi]||'').trim());if(b!=null&&date>=closingDate){closing=b;closingDate=date;}}
    ops.push({bankId:id,date,amount,currency:g('currency')||'RUB',card,desc,bankCategory:g('category'),mcc:g('mcc')});
  }
  return {ops,skipped,errors:[],closing};
}

// ---------- Screenshot (OCR text) parser ----------
const MONTHS=['январ','феврал','март','апрел','ма','июн','июл','август','сентябр','октябр','ноябр','декабр'];
const MRE='(январ[яь]|феврал[яь]|марта?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|августа?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь])';
const pad=n=>String(n).padStart(2,'0');
const isoDay=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
// amount: optional sign (various minus chars), digits with spaces as thousands, optional decimals, currency ₽ (OCR: Р, P, р, руб, 2 after space)
const AMT=/([−\-–—‒+])?\s*(\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|[РPр])\s*$/;
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
  const ops=[];let date=null,pendingDesc='',afterHdr=false,summary=false;
  for(let raw of String(text).split(/\r?\n/)){
    const line=cleanLine(raw); if(!line)continue;
    const h=parseHeader(line,today); if(h){if(!date&&summary)ops.length=0;date=h;pendingDesc='';afterHdr=true;continue;}
    // summary block before the first day header (Траты/Пополнения cards, month/card filter chips): ignore
    if(!date&&/(траты|пополнения|без перевод|^(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\S*$)/i.test(line)){summary=true;pendingDesc='';continue;}
    if(!date&&(line.match(/\d\s*(₽|руб|[РPр])(?![а-яё])/gi)||[]).length>=2){summary=true;pendingDesc='';continue;}
    // Яндекс Сплит list: installment progress lines («часть 1 из 4», «Осталось 3 платежа», «1 из 4») are not ops
    if(/^(часть\s*\d+\s*из\s*\d+|\d+\s*из\s*\d+(\s*(платеж|част)\S*)?|осталось\b.*|следующий платёж.*|следующий платеж.*)$/i.test(line))continue;
    if(/^(операции|все операции|расходы|доходы|поиск|недавние|главная|платежи|чат|ещё|еще)$/i.test(line))continue;
    const m=line.match(AMT);const was=afterHdr;afterHdr=false;
    // day total printed next to the day header (OCR often puts it on its own line): skip it
    if(m&&was&&!line.slice(0,m.index).replace(/[\s—–−‒-]+/g,'')&&!pendingDesc)continue;
    if(m){const desc=line.slice(0,m.index).replace(/[\s—–−‒-]+$/,'').trim()||pendingDesc;
      let v=parseFloat(m[2].replace(/[ \u00a0\u202f]/g,'').replace(',','.')); if(m[1]!=='+')v=-v; // T-Bank: income is "+", everything else is spending
      ops.push({date:(date||isoDay(today))+'T00:00:00',amount:v,desc:desc||'Без описания',bankCategory:'',card:'',src:'screenshot'});pendingDesc='';continue;}
    // summary cards at the top ("1 265 ₽ / Траты"): drop the amount we just took for an op
    if(/^(траты|пополнения|нет (трат|пополнени).*)$/i.test(line)){const l=ops[ops.length-1];if(l&&l.desc==='Без описания'&&l._fresh!==false)ops.pop();continue;}
    // text line: category under the previous op, or a merchant name whose amount is on the next line
    const last=ops[ops.length-1];
    if(last&&!last.bankCategory&&!pendingDesc&&last._fresh!==false){last.bankCategory=line;last._fresh=false;}
    else pendingDesc=line;
  }
  ops.forEach(o=>delete o._fresh);return ops;}

// ---------- Яндекс Пэй «Операции» (Сплит) screenshot OCR ----------
// rows: «Merchant  −274,18 ₽» then a subtitle line (category / «Возврат» / «Общий платеж»). Red «!» after the amount (OCR: © @ Q) = failed payment -> skipped.
const SPL_AMT=/([−\-–—‒+~])?\s*(\d{1,3}(?:[ \u00a0\u202f][\dОOЗ]{3})+|\d+)(?:\s*[.,/]\s*(\d{1,2}))?\s*(₽|руб\.?|[РPр#£¥€]+|¥P)?\s*([©@®Q!]|\(!\))?\s*$/;
function parseSplitText(text,today=new Date()){const ops=[];let date=null,cur=null;
  // icon junk OCR puts before the merchant: «CA», «on», «©», «=», «9.», «‘WB», «oF 4»; keeps «ИП», «АЗК»
  const junkTok=(t,n)=>t.length<=3&&(/[^0-9A-Za-zА-Яа-яЁё]/.test(t)||/^[A-Za-z]{1,2}$/.test(t)||/^[а-яё]+$/.test(t)||/^\d$/.test(t)||/^[А-Яа-яЁё]{1,2}$/.test(t)&&/^[A-Za-z]{3}/.test(n||''));
  const junkLead=s=>{const w=s.trim().split(/\s+/);while(w.length>1&&junkTok(w[0],w[1]))w.shift();return w.join(' ').replace(/[\s~—–-]+$/,'').trim();};
  for(const raw of String(text).split(/\r?\n/)){const line=raw.replace(/[|]/g,' ').replace(/\s+/g,' ').trim();if(!line)continue;
    const h=parseHeader(line,today);if(h){date=h;cur=null;continue;}
    if(!date)continue;
    const m=line.match(SPL_AMT);const head=m?line.slice(0,m.index):'';
    if(m&&m[1]&&/[A-Za-zА-Яа-яЁё]{2}/.test(head)){
      const intp=m[2].replace(/[ОO]/g,'0').replace(/З/g,'3').replace(/\D/g,'');let v=+(intp+(m[3]?'.'+m[3]:''));if(!v){cur=null;continue;}
      // Yandex prints ≥10 000 with a thousands space («18 701»): 5+ digits glued together = the decimal comma was lost («27418» = 274,18)
      let guess=false;if(!m[3]&&/^\d{5,}$/.test(m[2])){v=+(intp.slice(0,-2)+'.'+intp.slice(-2));guess=true;}
      if(m[1]!=='+')v=-v;const desc=junkLead(head);
      cur={date:date+'T00:00:00',amount:v,desc,bankCategory:'',failed:!!m[5],card:'',src:'split',guess};
      if(/карта п[эе]й.*супер|супер с[пn]л/i.test(line)){cur.kind='repay';cur.desc='Карта Пэй → Супер Сплит';}
      ops.push(cur);continue;}
    if(cur&&!cur.bankCategory){const sub=junkLead(line);cur.bankCategory=sub;
      if(/общий плат/i.test(sub))cur.kind='repay';else if(/^возврат/i.test(sub)&&cur.amount>0)cur.kind='refund';cur=null;}}
  return ops.filter(o=>!o.failed).map(o=>{const r={...o,kind:o.kind||(o.amount>0?'refund':'purchase')};delete r.failed;if(r.kind==='repay')r.amount=Math.abs(r.amount);return r;});}
// overlapping Split screenshots: the same row in two shots may lose the decimal comma in one of them (27418 vs 274,18) -> keep the version with kopecks
function mergeSplitShots(rows){const out=[];const dig=v=>Math.abs(v).toFixed(2).replace(/\.00$/,'').replace('.','');
  // one inserted digit (8540 vs 86540)
  const ins=(a,b)=>{if(a.length+1!==b.length)return false;for(let i=0;i<b.length;i++)if(b.slice(0,i)+b.slice(i+1)===a)return true;return false;};
  const same=(x,r)=>x.amount===r.amount||dig(x.amount)===dig(r.amount)||ins(dig(x.amount),dig(r.amount))||ins(dig(r.amount),dig(x.amount));
  const better=(x,r)=>{if(!!x.guess!==!!r.guess)return x.guess?r.amount:x.amount;const kx=!Number.isInteger(x.amount),kr=!Number.isInteger(r.amount);if(kx!==kr)return kr?r.amount:x.amount;return dig(x.amount).length<=dig(r.amount).length?x.amount:r.amount;};
  const byShot={};rows.forEach(r=>(byShot[r.shot]=byShot[r.shot]||[]).push(r));
  for(const sh of Object.keys(byShot)){const used=new Set();
    for(const r of byShot[sh]){const cand=out.map((x,i)=>[x,i]).filter(([x,i])=>!used.has(i)&&x._shots.indexOf(r.shot)<0&&x.date===r.date&&x.kind===r.kind&&Math.sign(x.amount)===Math.sign(r.amount)&&same(x,r)&&(x.amount===r.amount||similar(x.desc,r.desc)));
      const exact=cand.find(([x])=>x.amount===r.amount&&similar(x.desc,r.desc))||cand.find(([x])=>x.amount===r.amount)||cand[0];
      if(exact){const [x,i]=exact;used.add(i);x.amount=better(x,r);if(x.amount===r.amount)x.guess=r.guess;x._shots.push(r.shot);if(r.bankCategory&&!x.bankCategory)x.bankCategory=r.bankCategory;continue;}
      out.push({...r,_shots:[r.shot]});used.add(out.length-1);}}
  return out.map(x=>{const y={...x};delete y._shots;delete y.guess;return y;});}
// assign stable ids; rows: [{date,amount,desc,shot}]. Identical rows from different screenshots (overlap) collapse; within one shot they stay separate.
function screenshotIds(rows){const cnt={},out=[],seen=new Set();
  for(const r of rows){const base=['s',r.date.slice(0,10),(+r.amount).toFixed(2),norm(r.desc)].join('|');const k=r.shot+'~'+base;cnt[k]=(cnt[k]||0)+1;
    const id='s:'+hash(base+'#'+cnt[k]);if(seen.has(id))continue;seen.add(id);out.push({...r,bankId:id});}
  return out;}
function similar(a,b){a=norm(a).replace(/ё/g,"е");b=norm(b).replace(/ё/g,"е");if(!a||!b)return false;if(a.includes(b)||b.includes(a))return true;
  const bg=s=>{const m=new Map();for(let i=0;i<s.length-1;i++){const g=s.slice(i,i+2);m.set(g,(m.get(g)||0)+1);}return m;};
  const A=bg(a),B=bg(b);let inter=0;A.forEach((v,g)=>inter+=Math.min(v,B.get(g)||0));return 2*inter/(a.length+b.length-2)>=0.5;}

// ---------- CoinKeeper CSV export import ----------
// Header: Date,Type,From,To,Tags,Amount,Currency,Amount converted,Currency of conversion,Recurrence,Note
function parseCoinKeeper(text){
  const rows=splitCSV(text);if(!rows.length)return {rows:[],errors:['Пустой файл']};
  const h=rows[0].map(x=>x.trim().toLowerCase());const ix=n=>h.indexOf(n);
  const I={date:ix('date'),type:ix('type'),from:ix('from'),to:ix('to'),tags:ix('tags'),amount:ix('amount'),cur:ix('currency'),note:ix('note')};
  if(I.date<0||I.amount<0||I.from<0||I.to<0)return {rows:[],errors:['Это не похоже на экспорт CoinKeeper (нет колонок Date/From/To/Amount)']};
  const out=[],seen={};
  for(const r of rows.slice(1)){const g=k=>I[k]>=0?(r[I[k]]||'').trim():'';
    const date=parseDate(g('date'));const amount=num(g('amount'));if(!date||amount==null)continue;
    const row={date:date.slice(0,10),type:g('type').toLowerCase(),from:g('from'),to:g('to'),tags:g('tags').split(',').map(t=>t.trim()).filter(Boolean),amount:Math.abs(amount),currency:g('cur')||'RUB',note:g('note')};
    const base=['ck',row.date,row.type,norm(row.from),norm(row.to),row.amount.toFixed(2),norm(row.note),norm(row.tags.join())].join('|');
    seen[base]=(seen[base]||0)+1;row.ckId='ck:'+hash(base+'#'+seen[base]);out.push(row);}
  return {rows:out,errors:[]};}
const nameEq=(a,b)=>{a=norm(a).replace(/ё/g,'е');b=norm(b).replace(/ё/g,'е');return a===b||(a.length>=4&&b.length>=4&&(a.startsWith(b)||b.startsWith(a)));};
// state: {accounts,cats,ops}. Returns plan; nothing is written.
function planCoinKeeper(rows,state){
  const accounts=[...state.accounts],cats=[...state.cats],newAccounts=[],newCats=[];
  const findAcc=n=>accounts.find(a=>a.name.trim()===n)||accounts.find(a=>nameEq(a.name,n));
  const wallet=n=>{if(!n)return null;let a=findAcc(n);if(!a){const kind=/тинькофф|банк|карт|сбер|альфа|visa|мир/i.test(n)?'card':/отлож|копил|накоп/i.test(n)?'savings':'cash';
      a={id:'ck_'+hash('acc|'+norm(n)),name:n,kind,icon:kind==='card'?'💳':'👛',color:{card:'#4a3b1c',savings:'#4caf72',cash:'#c9a84c'}[kind],initial:0,cardMask:'',order:100+newAccounts.length};accounts.push(a);newAccounts.push(a);}return a.id;};
  const cat=(n,income)=>{let c=cats.find(c=>c.income===income&&c.name.trim()===n)||cats.find(c=>c.income===income&&nameEq(c.name,n));
    if(!c){c={id:'ck_'+hash((income?'inc|':'exp|')+norm(n)),name:n,income,icon:income?'💵':'🛒',color:income?'#2c4a9a':'#0d2626',order:100+newCats.length};cats.push(c);newCats.push(c);}return c.name;};
  const known=new Set(state.skipped||[]);state.ops.forEach(o=>(o.bankIds||[]).forEach(b=>known.add(b)));
  const bankOps=state.ops.filter(o=>(o.bankIds||[]).some(b=>!String(b).startsWith('ck:')));const usedLink=new Set();
  const cashId=()=>(accounts.find(a=>a.kind==='cash')||{}).id;
  const items=rows.map(r=>{const note=[r.note,...r.tags.map(t=>'#'+t)].filter(Boolean).join(' ');let op=null,action='add';
    const base={amount:r.amount,date:r.date,note,tags:r.tags,bankIds:[r.ckId]};
    if(r.type==='expense')op={...base,type:'expense',accountId:wallet(r.from),category:cat(r.to,false)};
    else if(r.type==='income'){const src=/^correction$/i.test(r.from)?'Корректировка баланса':r.from;op={...base,type:'income',accountId:wallet(r.to),category:cat(src,true)};}
    else if(r.type==='transfer')op={...base,type:'transfer',accountId:wallet(r.from),toAccountId:wallet(r.to)};
    else if(r.type==='debt'){const out=!!findAcc(r.from)&&!findAcc(r.to);op=out?{...base,type:'expense',accountId:wallet(r.from),category:cat('Долги',false),note:('Долг: '+r.to+' '+note).trim()}:
      {...base,type:'income',accountId:wallet(r.to),category:cat('Долги',true),note:('Долг: '+r.from+' '+note).trim()};}
    else{ // untyped: bank operation never categorized in CoinKeeper
      action='decide';const inflow=!!r.to;const acc=wallet(inflow?r.to:r.from);
      op={...base,type:inflow?'income':'expense',accountId:acc,category:'',note:(note||'Без категории в CoinKeeper')};
      return {row:r,action,op,inflow,choice:'skip'};}
    if(known.has(r.ckId))return {row:r,action:'duplicate',op};
    // link with ops already imported from the bank (T-Bank CSV/screenshot)
    const t=bankOps.find(o=>!usedLink.has(o.id)&&o.type===op.type&&Math.abs(o.amount-op.amount)<0.005&&days(o.date.slice(0,10),op.date)<=1&&
      (o.accountId===op.accountId||(op.type==='transfer'&&o.toAccountId===op.toAccountId)));
    if(t){usedLink.add(t.id);return {row:r,action:'link',op,target:t.id};}
    return {row:r,action,op};});
  // the classic double count: manual cash->card transfer + bank deposit booked as income on the same card, same amount, same day
  const tr=items.filter(i=>i.op&&i.op.type==='transfer'&&i.action==='add');const usedT=new Set();
  const kindOf=id=>(accounts.find(a=>a.id===id)||{}).kind;
  for(const it of items){if(it.action!=='add'||it.op.type!=='income'||kindOf(it.op.accountId)!=='card')continue; // income into cash/savings is real income, never a double count
    const t=tr.find(x=>!usedT.has(x)&&x.op.toAccountId===it.op.accountId&&kindOf(x.op.accountId)==='cash'&&x.op.amount===it.op.amount&&days(x.op.date,it.op.date)<=1);
    if(t){usedT.add(t);it.action='pairdup';it.pair=t.row;}}
  // untyped: suggest pairing with a transfer in the file
  for(const it of items){if(it.action!=='decide')continue;
    const t=tr.find(x=>(it.inflow?x.op.toAccountId:x.op.accountId)===it.op.accountId&&x.op.amount===it.op.amount&&days(x.op.date,it.op.date)<=2);
    if(t){it.pair=t.row;it.choice='skip';it.hint='есть ручной перевод на ту же сумму';}
    else if(known.has(it.row.ckId))it.action='duplicate';}
  return {items,newAccounts,newCats,cashId:cashId()};}
// turn a decided untyped item into an op (or null for skip)
function decideOp(it,choice,cashId,category){if(choice==='skip')return null;const o={...it.op};
  const sug=choice===it.sugChoice;if(sug&&it.sugNote)o.note=it.sugNote;
  if(choice==='transfer'){o.type='transfer';if(it.inflow){o.toAccountId=o.accountId;o.accountId=cashId;}else o.toAccountId=cashId;o.category='';}
  else if(choice==='card'&&it.otherAcc){o.type='transfer';if(it.inflow){o.toAccountId=o.accountId;o.accountId=it.otherAcc;}else o.toAccountId=it.otherAcc;o.category='';}
  else if(choice==='income'){o.type='income';o.category=category||(sug&&it.sugCat)||'Прочее';}else {o.type='expense';o.category=category||(sug&&it.sugCat)||'Прочее';}
  return o;}
// ---- bank statement assisted suggestions for the CoinKeeper import ----
const dayOf=s=>new Date(String(s).slice(0,10)+'T00:00:00Z').getTime()/864e5;
// what a T-Bank row is. others: ops of the other family card(s) [{accountId,ops}]
function bankKind(o,others){const c=isCash(o);const d=String(o.desc||'');
  if(c)return {kind:c==='in'?'cash_in':'cash_out',label:c==='in'?'внесение наличных':'снятие наличных'};
  if(o.bankCategory==='Переводы'&&!/^Пополнение\./.test(d)&&!/Между своими/.test(d)){
    const fam=(others||[]).find(b=>b.ops.some(p=>Math.abs(p.amount+o.amount)<0.005&&Math.abs(dayOf(p.date)-dayOf(o.date))<=1&&p.bankCategory==='Переводы'));
    if(fam)return {kind:'family',label:'перевод между картами семьи',otherAcc:fam.accountId};}
  if(/Между своими счетами/.test(d))return {kind:'own',label:'между своими счетами Т‑Банка'};
  if(o.amount>0){if(o.bankCategory==='Переводы'&&!/^Пополнение\./.test(d))return {kind:'person_in',label:'перевод от '+d,sender:d};
    return {kind:'other_in',label:(o.bankCategory?o.bankCategory+': ':'')+d};}
  if(o.bankCategory==='Переводы')return {kind:'person_out',label:'перевод: '+d};
  return {kind:'purchase',label:(o.bankCategory||'покупка')+': '+d,category:o.bankCategory};}
// which app account a bank file belongs to: the one whose CoinKeeper expenses it matches best
function guessBankAccount(plan,bankOps){const set=new Set(bankOps.filter(o=>o.amount<0).map(o=>String(o.date).slice(0,10)+'|'+(-o.amount).toFixed(2)));const sc={};
  for(const it of plan.items)if(it.op&&it.op.type==='expense'&&set.has(String(it.op.date).slice(0,10)+'|'+(+it.op.amount).toFixed(2)))sc[it.op.accountId]=(sc[it.op.accountId]||0)+1;
  const best=Object.entries(sc).sort((a,b)=>b[1]-a[1])[0];return best?{accountId:best[0],score:best[1]}:null;}
// banks: [{accountId, ops(parseTBank ops)}]; catNames: existing expense categories. Mutates plan items: choice/accept + hint.
function suggestCoinKeeper(plan,banks,catNames){const stat={pairConfirmed:0,pairAmbiguous:0,pairOther:0,decided:{},notFound:0};const used=new Set();
  const byAcc=a=>banks.find(b=>b.accountId===a);
  const match=(b,it,sign)=>{for(const tol of[0,1]){const m=b.ops.filter(o=>!used.has(o)&&Math.sign(o.amount)===sign&&Math.abs(Math.abs(o.amount)-it.op.amount)<0.005&&Math.abs(dayOf(o.date)-dayOf(it.op.date))<=tol);if(m.length)return m;}return [];};
  for(const it of plan.items){
    if(it.action==='pairdup'){const b=byAcc(it.op.accountId);if(!b)continue;const m=match(b,it,1);if(m[0])it.bankOp=m[0];const cash=m.filter(o=>isCash(o)==='in');
      if(m.length===1&&cash.length===1){it.accept=false;it.hint='Банк: одно внесение наличных — доход записан дважды';stat.pairConfirmed++;}
      else if(cash.length>=2){it.accept=false;it.hint='Банк: '+cash.length+' внесения наличных на эту сумму — проверьте';stat.pairAmbiguous++;}
      else if(m.length){const k=bankKind(m[0],banks.filter(x=>x!==b));it.accept=k.kind!=='cash_in';it.hint='Банк: '+k.label;stat.pairOther++;}
      else{it.hint='В выписке нет поступления на эту сумму';stat.pairOther++;}
      continue;}
    if(it.action!=='decide')continue;const b=byAcc(it.op.accountId);if(!b)continue;
    const m=match(b,it,it.inflow?1:-1);if(!m.length){it.hint='В выписке не найдено';stat.notFound++;continue;}
    const o=m[0];used.add(o);const k=bankKind(o,banks.filter(x=>x!==b));it.bank=k;it.bankOp=o;
    if(k.kind==='cash_in'||k.kind==='cash_out'){it.sugChoice='transfer';}
    else if(k.kind==='family'){it.sugChoice='card';it.otherAcc=k.otherAcc;}
    else if(k.kind==='own'&&b.ownAccountId){it.sugChoice='card';it.otherAcc=b.ownAccountId;}
    else if(it.inflow){it.sugChoice='income';it.sugCat='Прочее';it.sugNote=k.kind==='person_in'?'Перевод от '+k.sender:'Банк: '+k.label;}
    else{it.sugChoice='expense';it.sugCat=(catNames||[]).includes(k.category)?k.category:'Прочее';it.sugNote='Банк: '+k.label;}
    it.choice=it.sugChoice;it.hint='Банк: '+k.label;stat.decided[k.kind]=(stat.decided[k.kind]||0)+1;}
  return stat;}
const CASH_IN=/(пополнение.*налич|внесение налич|cash ?in|банкомат.*пополн|пополнение.*банкомат)/i;
const CASH_OUT=/(снятие налич|выдача налич|cash ?out|atm|снятие в банкомате|банкомат)/i;
function isCash(op){const d=String(op.desc||'').toLowerCase();
  // real cash only: ATM deposit/withdrawal by description or ATM MCC. Bank category «Наличные» alone is NOT enough (T-Bank tags e-wallet top-ups like «Операция в других кредитных организациях ozon» as «Наличные»).
  if(/операция в других кредитных/.test(d))return null;
  if(op.mcc==='6011'||op.mcc==='6010'||/(внесение|снятие|выдача|пополнение)[^,;]{0,20}налич|банкомат|(^|[^a-z])atm([^a-z]|$)|cash ?(in|out)/.test(d)) return op.amount>0?'in':'out'; return null;}
const days=(a,b)=>Math.abs(new Date(a)-new Date(b))/864e5;
// Classify imported ops against existing operations.
// existing: [{id,type,amount(positive),accountId,toAccountId,date,bankIds:[]}], cardAccountId, cashAccountId
const OWN=/между своими счетами/i;
// internal bank transfer whose other side is not named (T-Bank «Внутрибанковский перевод», «Внутренний перевод», «Перевод между счетами»); OCR may cut the tail
const INB=/внутрибанков|внутренн\S* перев|перевод между (своими )?сч/i;
// person-to-person payment description from T-Bank statements: «Эдвард О.», «Елена П.»
const PERSON=/^\s*[А-ЯЁ][а-яё]+(-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ]\.\s*$/;
// a stored mis-linked transfer: own-account transfer whose description is a person's name (not own-account wording)
function p2pMislink(o){return !!o&&!o.deleted&&o.type==='transfer'&&PERSON.test(o.note||'')&&!OWN.test(o.note||'')&&!INB.test(o.note||'')&&(o.bankIds||[]).filter(b=>!String(b).startsWith('ck:')).length>=2;}
// split it back: sender side = expense with the original bank ids, receiver side = income (last appended id) left for review
function splitP2P(o,fromAcc,toAcc){const ids=(o.bankIds||[]);const last=ids[ids.length-1];
  const out={...o,type:'expense',accountId:fromAcc,toAccountId:undefined,category:'Прочее',sides:undefined,bankIds:ids.slice(0,-1),reviewed:false,review:0};
  const inc={id:o.id+'_in',type:'income',amount:o.amount,accountId:toAcc,date:o.date,note:'Входящий перевод',category:'',bankIds:[last],reviewed:false,review:1};
  return [out,inc];}
// existing transfer between the same two accounts (either direction), same amount, date ±1 day
function findDupTransfer(ops,t,skip){const a=Math.abs(+t.amount);if(!t.accountId||!t.toAccountId)return null;
  return (ops||[]).find(o=>o&&!o.deleted&&o.type==='transfer'&&o.id!==t.id&&!(skip&&skip.has(o.id))&&Math.abs(o.amount-a)<0.005&&
    ((o.accountId===t.accountId&&o.toAccountId===t.toAccountId)||(o.accountId===t.toAccountId&&o.toAccountId===t.accountId))&&
    days(String(o.date).slice(0,10),String(t.date).slice(0,10))<=1)||null;}
const SPLIT=/(сплит|split|погашени[ея] рассрочк|рассрочк)/i,SPLIT_PAY=/(супер сплит|общий плат|погаш|платеж|платёж|оплата (части|рассрочк|сплит)|внесени)/i;
function reconcile(imported, existing, cardAcc, cashAcc, ownAcc, pairAcc, others, opts){
  const incomeIn=!!(opts&&opts.incomeIn);
  const known=new Map(); existing.forEach(o=>(o.bankIds||[]).forEach(b=>known.set(b,o)));
  const used=new Set(); const out=[];
  imported.forEach(op=>{const k=known.get(op.bankId);if(k)used.add(k.id);});
  for(const op of imported){
    if(known.has(op.bankId)){out.push({op,action:'duplicate'});continue;}
    const abs=Math.abs(op.amount), dir=op.amount<0?'out':'in';
    const isSS=String(op.bankId).startsWith('s:');
    // cross-source overlap: screenshot row vs CSV-imported op (or the reverse): same account, amount, date ±1 day, similar description
    const ov=existing.find(o=>!used.has(o.id)&&(o.bankIds||[]).some(b=>!String(b).startsWith('ck:'))&&((o.bankIds||[]).every(b=>String(b).startsWith('s:')!==isSS)||isSS&&o.type!=='transfer')&&
      Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),op.date.slice(0,10))<=1&&
      (o.accountId===cardAcc||o.toAccountId===cardAcc)&&(similar(o.note,op.desc)||o.type==='transfer'&&isCash(op)));
    if(ov){used.add(ov.id);out.push({op,action:'link',target:ov.id,overlap:true});continue;}
    const manual=o=>!(o.bankIds||[]).some(b=>!String(b).startsWith('ck:')); // no ids or only CoinKeeper ids = typed by hand
    const cand=existing.filter(o=>!used.has(o.id)&&manual(o)&&Math.abs(o.amount-abs)<0.005&&days(o.date,op.date)<=2&&(
      (dir==='out'&&((o.type==='expense'&&o.accountId===cardAcc)||(o.type==='transfer'&&o.accountId===cardAcc)))||
      (dir==='in'&&((o.type==='income'&&o.accountId===cardAcc)||(o.type==='transfer'&&o.toAccountId===cardAcc)))))
      .sort((a,b)=>days(a.date,op.date)-days(b.date,op.date));
    if(cand.length){used.add(cand[0].id);out.push({op,action:'link',target:cand[0].id});continue;}
    // account rule «Входящие = доход»: every incoming op is income (no transfer guessing), user picks Доход/Прочее
    // Яндекс Сплит: repayment from a Yandex card statement -> transfer card -> Split; on the Split statement an incoming repayment -> transfer from the Yandex card
    const spl=opts&&opts.splitAcc;
    if(spl&&cardAcc!==spl&&dir==='out'&&SPLIT.test(op.desc||'')){out.push({op,action:'transfer',from:cardAcc,to:spl});continue;}
    if(spl&&cardAcc===spl&&dir==='in'&&SPLIT_PAY.test(op.desc||'')){out.push({op,action:'transfer',from:opts.splitFrom||null,to:spl,pick:!opts.splitFrom});continue;}
    if(incomeIn&&dir==='in'){out.push({op,action:'add',type:'income',inc:true,cat:(opts&&opts.inCat)||'Доход'});continue;}
    // transfer between own T-Bank accounts: link to the other side already recorded (e.g. converted CoinKeeper row), else new transfer
    if(OWN.test(op.desc||'')){const t=existing.find(o=>!used.has(o.id)&&o.type==='transfer'&&Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),op.date.slice(0,10))<=1&&
        (dir==='out'?o.accountId===cardAcc:o.toAccountId===cardAcc)&&!(o.sides||[]).includes(cardAcc));
      if(t){used.add(t.id);out.push({op,action:'link',target:t.id,side:cardAcc});continue;}
      // Black statement: the other side was recorded on the paired card as income/expense (e.g. «Прочее») -> convert it to a transfer
      const pri=o=>OWN.test(o.note||'')?0:/^прочее$/i.test(o.category||'')?1:2;
      if(pairAcc){const want=dir==='out'?'income':'expense';const cs=existing.filter(o=>!used.has(o.id)&&o.type===want&&o.accountId===pairAcc&&Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),op.date.slice(0,10))<=1&&!(o.bankIds||[]).some(b=>!String(b).startsWith('ck:')))
          .sort((a,b)=>pri(a)-pri(b)||days(a.date,op.date)-days(b.date,op.date));
        if(cs.length){used.add(cs[0].id);out.push({op,action:'convert',target:cs[0].id,from:dir==='out'?cardAcc:pairAcc,to:dir==='out'?pairAcc:cardAcc});continue;}
        out.push({op,action:'transfer',from:dir==='out'?cardAcc:pairAcc,to:dir==='out'?pairAcc:cardAcc});continue;}
      if(ownAcc&&ownAcc!==cardAcc){out.push({op,action:'transfer',from:dir==='in'?ownAcc:cardAcc,to:dir==='in'?cardAcc:ownAcc});continue;}}
    // transfer from/to own card at another bank (e.g. Yandex <- T-Bank Card2Card): turn that card's expense/income into a transfer
    if(others&&others.length&&/(t-?bank|т-?банк|тинькофф|card2card|себе (в|из) друг)/i.test(op.desc||'')){const want=dir==='in'?'expense':'income';
      const cs=existing.filter(o=>!used.has(o.id)&&o.type===want&&others.includes(o.accountId)&&o.accountId!==cardAcc&&(want!=='income'||/(t-?bank|т-?банк|тинькофф|card2card)/i.test(o.note||''))&&Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),op.date.slice(0,10))<=1);
      if(cs.length===1){used.add(cs[0].id);out.push({op,action:'convert',target:cs[0].id,from:dir==='in'?cs[0].accountId:cardAcc,to:dir==='in'?cardAcc:cs[0].accountId});continue;}}
    if(INB.test(op.desc||'')){const want=dir==='in'?'expense':'income';
      const cs=existing.filter(o=>!used.has(o.id)&&o.type===want&&o.accountId!==cardAcc&&!PERSON.test(o.note||'')&&Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),op.date.slice(0,10))<=1)
        .sort((a,b)=>(INB.test(b.note||'')||OWN.test(b.note||''))-(INB.test(a.note||'')||OWN.test(a.note||''))||days(a.date,op.date)-days(b.date,op.date));
      if(cs.length){used.add(cs[0].id);out.push({op,action:'convert',target:cs[0].id,from:dir==='in'?cs[0].accountId:cardAcc,to:dir==='in'?cardAcc:cs[0].accountId});continue;}
      out.push({op,action:'transfer',from:dir==='in'?null:cardAcc,to:dir==='in'?cardAcc:null,pick:true});continue;}
    const c=isCash(op);
    if(c==='in') out.push({op,action:'transfer',from:cashAcc,to:cardAcc});
    else if(c==='out') out.push({op,action:'transfer',from:cardAcc,to:cashAcc});
    else out.push({op,action:'add',type:dir==='out'?'expense':'income'});
  }
  for(const it of out)if(it.action==='transfer'&&it.from&&it.to){const d=findDupTransfer(existing,{amount:it.op.amount,accountId:it.from,toAccountId:it.to,date:it.op.date},used);
    if(d){used.add(d.id);Object.assign(it,{action:'link',target:d.id,dupTransfer:true,side:cardAcc});}}
  return out;
}
// already-stored «между своими счетами» income/expense on cardAcc -> transfer with ownAcc (same id/date/amount)
function ownToTransfer(o,ownAcc){const n={...o,type:'transfer',category:'',sides:[o.accountId]};
  if(o.type==='income'){n.accountId=ownAcc;n.toAccountId=o.accountId;}else{n.accountId=o.accountId;n.toAccountId=ownAcc;}return n;}
function balances(accounts,ops){const b={};accounts.forEach(a=>b[a.id]=+a.initial||0);
  for(const o of ops){ if(o.type==='expense')b[o.accountId]-=o.amount; else if(o.type==='income')b[o.accountId]+=o.amount;
    else if(o.type==='transfer'){b[o.accountId]-=o.amount;b[o.toAccountId]+=o.amount;} }
  return b;}
// ---- Yandex Bank «Выписка по договору» (PDF) — best effort (beta) ----
// lines: text lines of the PDF in reading order. Returns {ops,skipped,errors,closing}
const YSTART=/(Погашение (основного долга|процентов)|Входящий перевод|Исходящий перевод|Оплата (товаров|СБП|услуг)|Прочие выплаты|Перевод (между|на|с)|Пополнение|Снятие|Возврат|Кешб[эе]к|Начисление)/;
function cleanYandexDesc(d,force){let t=String(d||'');
  t=t.replace(/Исх\. №[\s\S]*?«Договор»\)\.?/g,' ').replace(/операции обработки операции( ЭСП)?( МСК)*/gi,' ')
   .replace(/(по договору\s*)?№?\s*КС\d{8,}/g,' ').replace(/№\s*Э\d{8,}/g,' ').replace(/Паспорт РФ[^«]*/gi,' ')
   .replace(/[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ сообщает[^.]*\./g,' ').replace(/Дата рождения\S*/gi,' ');
  if(force){const m=t.match(YSTART);if(m&&m.index>0)t=t.slice(m.index);}
  t=t.replace(/\s+/g,' ').trim().replace(/ по договору$/,' по кредиту').replace(/^Погашение основного долга( по)?$/,'Погашение основного долга по кредиту').replace(/^Погашение процентов( за( пользование кредитом)?)?( по)?$/,'Погашение процентов по кредиту');
  return t;}
// newest first: date+time desc, then creation time desc (uid starts with Date.now() in base36), then updatedAt

const opCreated=o=>{const m=/^[0-9a-z]{8}/.exec(String(o.id||''));const t=m?parseInt(m[0],36):NaN;return t>1.5e12&&t<4e12?t:(o.createdAt||o.updatedAt||0);};
const opDT=o=>{const d=String(o.date||'');if(d.length!==10)return d;const c=opCreated(o);if(!c)return d+'T00:00:00';const t=new Date(c);const p=x=>String(x).padStart(2,'0');return d+'T'+p(t.getHours())+':'+p(t.getMinutes())+':'+p(t.getSeconds());};
function opCmp(a,b){const x=opDT(b).localeCompare(opDT(a));return x||(opCreated(b)-opCreated(a));}
// screenshot rows come newest-first: give them descending pseudo-times within a day so on-screen order survives sorting
function shotTimes(rows){const n={};return rows.map(r=>{const d=r.date.slice(0,10);const i=n[d]=(n[d]||0)+1;const s=86400-i;const p=x=>String(x).padStart(2,'0');
  return {...r,date:`${d}T${p(Math.floor(s/3600))}:${p(Math.floor(s%3600/60))}:${p(s%60)}`};});}
// move op one step up/down among ops of its day (list = visible ops). Returns changed ops (new objects) or [].
function moveOp(list,id,dir){const day=(list.find(o=>o.id===id)||{}).date;if(!day)return [];const d=String(day).slice(0,10);
  const ops=list.filter(o=>String(o.date).slice(0,10)===d).sort(opCmp);const i=ops.findIndex(o=>o.id===id),j=i+(dir<0?-1:1);if(i<0||j<0||j>=ops.length)return [];
  const a=ops[i],b=ops[j],ta=opDT(a),tb=opDT(b);
  if(ta!==tb)return [{...a,date:tb},{...b,date:ta}];
  const t=new Date(tb.slice(0,19)+'Z').getTime()+(dir<0?1000:-1000);const n=new Date(t).toISOString().slice(0,19);
  if(n.slice(0,10)!==d)return [{...a,date:ta},{...b,date:new Date(t+(dir<0?-2000:2000)).toISOString().slice(0,19)}];
  return [{...a,date:n}];}
// ---------- JetLend "Экспорт операций" (transactions.xlsx), rows = array of arrays ----------
const JL=/jet ?lend|джетленд/i;
function jlDate(v){if(v instanceof Date){const z=x=>String(x).padStart(2,'0');return `${v.getFullYear()}-${z(v.getMonth()+1)}-${z(v.getDate())}T${z(v.getHours())}:${z(v.getMinutes())}:${z(v.getSeconds())}`;}if(typeof v==='number'){return new Date(Math.round((v-25569)*864e5)).toISOString().slice(0,19);}
  const m=String(v||'').match(/(\d{2})\.(\d{2})\.(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);if(m)return `${m[3]}-${m[2]}-${m[1]}T${(m[4]||'0').padStart(2,'0')}:${m[5]||'00'}:${m[6]||'00'}`;
  const i=String(v||'').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);return i?i[1]+'T'+((i[2]||'00:00:00')+':00').slice(0,8):null;}
function parseJetlend(rows){const hi=rows.findIndex(r=>(r||[]).some(c=>String(c).trim()==='Тип операции'));if(hi<0)return {errors:['Это не похоже на «Экспорт операций» JetLend (нет колонки «Тип операции»)']};
  const h=rows[hi].map(c=>String(c||'').trim());const ix=n=>h.indexOf(n);const I={d:h.findIndex(c=>/^дата/i.test(c)),op:ix('Тип операции'),in:ix('Приход'),out:ix('Расход'),rev:ix('Доход после удержания')};if(I.rev<0)I.rev=ix('Доход');
  // two exports exist: "операции" (Приход/Расход/Доход после удержания) and "доходы" (ID/Дата/Эмитент/ИНН/Доход/Тип операции)
  if(I.d<0||(I.in<0&&I.rev<0))return {errors:['Не нашёл в файле JetLend колонки «Дата» и «Приход/Расход» или «Доход»']};
  const n=v=>typeof v==='number'?v:(num(String(v||''))||0);const deposits=[],monthly={},seen={},monthTo={};
  for(const r of rows.slice(hi+1)){if(!r)continue;const date=jlDate(r[I.d]);const op=String(r[I.op]||'').trim();if(!date||!op)continue;
    if(I.in>=0&&/^(пополнение сч[её]та|вывод (средств|со сч[её]та))$/i.test(op)){const a=Math.round((n(r[I.in])-n(r[I.out]))*100)/100;if(!a)continue;
      const base=['jl',date,a.toFixed(2)].join('|');seen[base]=(seen[base]||0)+1;deposits.push({date,amount:a,op,bankId:'jl:'+hash(base+'#'+seen[base])});continue;}
    if(/переуступк/i.test(op)||I.rev<0)continue;const m=date.slice(0,7);if(!(monthTo[m]>date.slice(0,10)))monthTo[m]=date.slice(0,10);monthly[m]=Math.round(((monthly[m]||0)+n(r[I.rev]))*100)/100;}
  return {deposits,monthly,monthTo,errors:[]};}
// plan against existing ops: deposits link to card->Jetlend transfers (±3 days, same amount), month yield = one op per month (id jl:m:YYYY-MM, updated on re-import)
function planJetlend(p,existing,jl){const known=new Set();existing.forEach(o=>(o.bankIds||[]).forEach(b=>known.add(b)));const used=new Set(),items=[];
  for(const d of p.deposits){if(known.has(d.bankId)){items.push({kind:'dup',d});continue;}const abs=Math.abs(d.amount);
    const t=existing.find(o=>!used.has(o.id)&&o.type==='transfer'&&(d.amount>0?o.toAccountId===jl:o.accountId===jl)&&Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),d.date.slice(0,10))<=3);
    if(t){used.add(t.id);items.push({kind:'link',d,target:t.id});}else items.push({kind:'add',d});}
  const dly={};existing.forEach(o=>!o.deleted&&(o.bankIds||[]).forEach(b=>{const d=b.match(/^jl:[ds]:(\d{4}-\d{2})-\d{2}$/);if(d)dly[d[1]]=(dly[d[1]]||0)+(o.type==='income'?o.amount:-o.amount);}));
  for(const m of Object.keys(p.monthly).sort()){const v=Math.round((p.monthly[m]-(dly[m]||0))*100)/100;const to=(p.monthTo||{})[m];const ex=existing.find(o=>(o.bankIds||[]).includes('jl:m:'+m));
    if(ex){if(Math.abs((ex.type==='income'?ex.amount:-ex.amount)-v)>=0.005)items.push({kind:'yield',m,v,to,target:ex.id});}else if(Math.abs(v)>=0.005)items.push({kind:'yield',m,v,to});}
  return items;}
// ---------- JetLend main screen snapshot (OCR text): portfolio value + "За все время" total gain ----------
function parseJetlendMain(text){const A=/([+\-−–]?)\s*(\d{1,3}(?:[ \u00a0]\d{3})*|\d+)[,.](\d{2})\s*[₽PРp]?/;const val=m=>(/[\-−–]/.test(m[1])?-1:1)*+(m[2].replace(/\D/g,'')+'.'+m[3]);
  const L=String(text||'').split(/\n/).map(l=>l.trim()).filter(Boolean);let value=null,total=null,pct=null,vi=-1,ti=-1;
  L.forEach((l,i)=>{if(total==null&&/вс[её]\s*время/i.test(l)){const m=l.replace(/^.*?время/i,'').match(A)||(L[i+1]||'').match(A);if(m){total=val(m);ti=i;const p=l.match(/\(\s*([+\-−–]?\d+[,.]\d+)\s*%/);if(p)pct=num(p[1].replace(/[−–]/,'-'));}}});
  // portfolio value: the big "123 456,78 ₽" line just above "За все время" (or the largest standalone amount)
  const cand=L.map((l,i)=>{const m=/^[^\d+\-−–]{0,3}(\d{1,3}(?:[ \u00a0]\d{3})+|\d{2,})[,.](\d{2})\s*[₽PРp]?\s*$/.exec(l);return m?{i,v:+(m[1].replace(/\D/g,'')+'.'+m[2])}:null;}).filter(Boolean);
  const near=cand.filter(c=>ti<0||(c.i<ti&&ti-c.i<=3));const pick=(near.length?near:cand).sort((a,b)=>b.v-a.v)[0];if(pick){value=pick.v;vi=pick.i;}
  return {value,total,pct,lines:L.map((l,i)=>({text:l,kind:i===vi?'value':i===ti?'total':'other'}))};}
// plan a snapshot vs previous ones (acc.jlSnaps) and XLSX months: income = total - previous total
function planJetlendSnap(snap,snaps,existing){const prev=(snaps||[]).filter(x=>x.date<snap.date).sort((a,b)=>a.date<b.date?1:-1)[0]||null;
  const same=(snaps||[]).find(x=>x.date===snap.date);const xlsxTo=existing.filter(o=>!o.deleted&&(o.bankIds||[]).some(b=>/^jl:m:/.test(b))).map(o=>o.jlTo||((o.bankIds.find(b=>/^jl:m:/.test(b)).slice(5))+'-31')).sort().pop()||'';
  if(!prev)return {prev:null,same,income:0,accept:false,why:'Первый снимок — запомню как точку отсчёта, доход посчитаю со следующего.',xlsxTo};
  const from=prev.date,income=Math.round((snap.total-prev.total)*100)/100;
  if(xlsxTo&&snap.date<=xlsxTo)return {prev,same,income,accept:false,from,why:`Период уже учтён выгрузкой XLSX (до ${xlsxTo}) — доход не добавляю.`,xlsxTo};
  if(xlsxTo&&from<xlsxTo)return {prev,same,income,accept:false,from,why:`Часть периода (до ${xlsxTo}) уже есть в XLSX — проверьте сумму вручную.`,xlsxTo};
  return {prev,same,income,accept:Math.abs(income)>=0.005,from,why:'',xlsxTo};}
function parseYandexText(lines){const D=/(\d{2})\.(\d{2})\.(\d{4})/,AM=/([+\-−–]?)\s?(\d{1,3}(?:[ \u00a0\u202f]\d{3})*[.,]\d{2})\s*(?:₽|RUB|руб)/g;
  const END=/^(исходящий\s+остаток|всего\s+(расход|приход)|с уважением)/i;
  const JUNK=/^(продолжение на следующей|страница \d|описание операции|операции обработки|мск( мск)?$|исх\. №|выписка по|дата \d|ао «яндекс банк»|.*лицензия банка россии|.*паспорт рф|.*дата рождения|.*сообщает, что между|.*\(далее —)/i;
  const ops=[],seen={};let cur=null,closing=null,totIn=null,totOut=null,started=false,ended=false;
  const val=m=>{const v=num(m[2]);return m[1]==='+'?v:m[1]?-v:null;};
  const flush=()=>{if(!cur)return;cur.desc=cleanYandexDesc(cur.desc);
    if(cur.amount==null)cur.amount=/(пополн|погашен|зачисл|входящ|возврат|кешб[эе]к|проценты|начислен)/i.test(cur.desc)?Math.abs(cur.abs):-Math.abs(cur.abs);
    const base=['y',cur.date,cur.amount.toFixed(2),norm(cur.desc)].join('|');seen[base]=(seen[base]||0)+1;
    ops.push({bankId:hash(base+'#'+seen[base]),date:cur.date,amount:cur.amount,currency:'RUB',card:cur.card||'',desc:cur.desc,bankCategory:'',mcc:''});cur=null;};
  for(const raw of lines){const l=String(raw).replace(/\s+/g,' ').trim();if(!l)continue;
    const am=[...l.replace(/\d{2}\.\d{2}\.\d{4}/g,' ').matchAll(AM)];
    if(/^исходящий\s+остаток/i.test(l)&&am.length){closing=num(am[am.length-1][2])*(/[−–-]/.test(am[am.length-1][1])?-1:1);flush();ended=true;continue;}
    if(/^всего\s+расход/i.test(l)&&am.length){totOut=-num(am[0][2]);continue;}
    if(/^всего\s+приход/i.test(l)&&am.length){totIn=num(am[0][2]);continue;}
    if(END.test(l)){flush();ended=true;continue;}
    if(/^входящий\s+остаток/i.test(l)){started=true;continue;}
    if(ended||JUNK.test(l))continue;
    const dm=l.match(D);
    if(dm&&am.length&&dm.index>0||dm&&am.length&&started){flush();started=true;const m=am[am.length-1];
      const card=(l.match(/\*(\d{4})/)||[])[1];
      cur={date:`${dm[3]}-${dm[2]}-${dm[1]}T00:00:00`,amount:val(m),abs:num(m[2]),desc:l.slice(0,dm.index),card};continue;}
    if(!cur)continue;
    const t=l.match(/^в (\d{2}):(\d{2})$/);if(t){cur.date=cur.date.slice(0,11)+t[1]+':'+t[2]+':00';continue;}
    cur.desc+=' '+l;}
  flush();return {ops,skipped:0,errors:ops.length?[]:['Не удалось найти операции в выписке Яндекс Банка'],closing,totIn,totOut};}
// ops on «Входящие = доход» accounts that need a Доход/Прочее decision: imported transfers into the account, or income without category
function needsInReview(o,ids){if(o.deleted||o.review===0)return false;const bank=(o.bankIds||[]).some(b=>!String(b).startsWith('ck:'));
  if(o.type==='transfer')return ids.includes(o.toAccountId)&&!ids.includes(o.accountId)&&bank;
  if(o.type==='income')return ids.includes(o.accountId)&&!o.category;return false;}
// manual amount entry: «13000», «13 000», «1 234,56», «1234.56», «13 000 ₽» -> number (NaN if none)
function parseAmount(s){let t=String(s==null?'':s).replace(/[\s\u00a0\u202f']/g,'').replace(/(₽|руб\.?|р\.?)$/i,'').replace(/[−–—]/g,'-');
  if(/,/.test(t)&&/\./.test(t))t=t.replace(/\./g,'');t=t.replace(',','.');if(!/^-?\d*\.?\d+$|^-?\d+\.$/.test(t))return NaN;return Math.abs(parseFloat(t));}
// duplicates on an account from screenshot imports: [{keep,drop:[],bankIds}] — manual ops / bank-statement ops are never touched
function splitDupPlan(ops,acc){const g=new Map();
  for(const o of ops){if(o.deleted||!(o.accountId===acc||o.toAccountId===acc))continue;const b=o.bankIds||[];if(!b.length||!b.every(x=>String(x).startsWith('s:')))continue;
    const k=[String(o.date).slice(0,10),(+o.amount).toFixed(2),o.type,o.accountId,o.toAccountId||'',norm(o.note)].join('|');(g.get(k)||g.set(k,[]).get(k)).push(o);}
  const out=[];for(const xs of g.values()){if(xs.length<2)continue;
    xs.sort((a,b)=>(b.bankIds.length-a.bankIds.length)||((b.reviewed!==false)-(a.reviewed!==false))||((a.updatedAt||0)-(b.updatedAt||0)));
    // screenshot ids are hash(row#n-th copy in its shot): distinct ids in a group = how many copies one screenshot really showed -> keep one op per id
    const cov=new Set(),keep=[],drop=[];for(const o of xs){if(o.bankIds.some(b=>!cov.has(b))){keep.push(o);o.bankIds.forEach(b=>cov.add(b));}else drop.push(o);}
    if(drop.length)out.push({keep:keep[0],keeps:keep,drop,bankIds:keep[0].bankIds});}
  return out;}
root.Core={splitDupPlan,parseAmount,parseSplitText,mergeSplitShots,SPLIT,SPLIT_PAY,findDupTransfer,PERSON,p2pMislink,splitP2P,needsInReview,parseJetlendMain,planJetlendSnap,JL,jlDate,parseJetlend,planJetlend,moveOp,opCmp,shotTimes,cleanYandexDesc,parseYandexText,ownToTransfer,OWN,INB,suggestCoinKeeper,guessBankAccount,bankKind,parseCoinKeeper,planCoinKeeper,decideOp,parseScreenshotText,screenshotIds,similar,decode,parseTBank,reconcile,balances,hash,isCash};
if(typeof module!=='undefined')module.exports=root.Core;
})(typeof self!=='undefined'?self:globalThis);

