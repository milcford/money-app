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
function reconcile(imported, existing, cardAcc, cashAcc, ownAcc){
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
    // transfer between own T-Bank accounts: link to the other side already recorded (e.g. converted CoinKeeper row), else new transfer
    if(OWN.test(op.desc||'')){const t=existing.find(o=>!used.has(o.id)&&o.type==='transfer'&&Math.abs(o.amount-abs)<0.005&&days(o.date.slice(0,10),op.date.slice(0,10))<=1&&
        (dir==='out'?o.accountId===cardAcc:o.toAccountId===cardAcc)&&!(o.sides||[]).includes(cardAcc));
      if(t){used.add(t.id);out.push({op,action:'link',target:t.id,side:cardAcc});continue;}
      if(ownAcc&&ownAcc!==cardAcc){out.push({op,action:'transfer',from:dir==='in'?ownAcc:cardAcc,to:dir==='in'?cardAcc:ownAcc});continue;}}
    const c=isCash(op);
    if(c==='in') out.push({op,action:'transfer',from:cashAcc,to:cardAcc});
    else if(c==='out') out.push({op,action:'transfer',from:cardAcc,to:cashAcc});
    else out.push({op,action:'add',type:dir==='out'?'expense':'income'});
  }
  return out;
}
// already-stored «между своими счетами» income/expense on cardAcc -> transfer with ownAcc (same id/date/amount)
function ownToTransfer(o,ownAcc){const n={...o,type:'transfer',category:'',sides:[o.accountId]};
  if(o.type==='income'){n.accountId=ownAcc;n.toAccountId=o.accountId;}else{n.accountId=o.accountId;n.toAccountId=ownAcc;}return n;}
function balances(accounts,ops){const b={};accounts.forEach(a=>b[a.id]=+a.initial||0);
  for(const o of ops){ if(o.type==='expense')b[o.accountId]-=o.amount; else if(o.type==='income')b[o.accountId]+=o.amount;
    else if(o.type==='transfer'){b[o.accountId]-=o.amount;b[o.toAccountId]+=o.amount;} }
  return b;}
root.Core={ownToTransfer,OWN,suggestCoinKeeper,guessBankAccount,bankKind,parseCoinKeeper,planCoinKeeper,decideOp,parseScreenshotText,screenshotIds,similar,decode,parseTBank,reconcile,balances,hash,isCash};
if(typeof module!=='undefined')module.exports=root.Core;
})(typeof self!=='undefined'?self:globalThis);
