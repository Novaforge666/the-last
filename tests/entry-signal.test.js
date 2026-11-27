"use strict";
/* Integration checks against the actual page using a fake Deriv socket.
   Run with: cd tests && npm ci && npm test */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}

/* ---------------- fake Deriv WebSocket ---------------- */
const frames = [];
let buyCount = 0, subSeq = 0, settleNext = false;
class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0;
    setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 0); }
  send(data) {
    const msg = JSON.parse(data); frames.push(msg);
    const reqId = msg.req_id;
    const respond = (obj) => setTimeout(() => { obj.req_id = reqId; if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }, 0);
    if (msg.ticks_history) { const p=[],t=[]; for (let i=0;i<50;i++){p.push("1000."+(i%10));t.push(1700000000+i);}
      respond({ msg_type:"history", history:{prices:p,times:t} }); }
    else if (msg.ticks) respond({ msg_type:"tick", tick:{epoch:1700000050,quote:"1000.0005",symbol:msg.ticks}, subscription:{id:"st"+(++subSeq)} });
    else if (msg.proposal) respond({ msg_type:"proposal", proposal:{id:"prop-"+Math.random().toString(36).slice(2,8),ask_price:"1.00",payout:"1.95",contract_type:msg.contract_type,spot:"1000.5",symbol:msg.underlying_symbol||msg.symbol,longcode:"q"} });
    else if (msg.buy) { buyCount++;
      respond({ msg_type:"buy", buy:{contract_id:900000+buyCount,contract_type:"DIGITOVER",buy_price:1,payout:1.95,start_time:1700000051,purchase_time:1700000050,longcode:"bought",shortcode:"DIGITOVER_R_50"} }); }
    else if (msg.ping) respond({ msg_type:"ping", ping:"pong" });
    else if (msg.balance) respond({ msg_type:"balance", balance:{balance:100,currency:"USD"}, subscription:{id:"sb"+(++subSeq)} });
    else if (msg.proposal_open_contract) { const sold = settleNext; settleNext = false;
      respond({ msg_type:"proposal_open_contract", proposal_open_contract:{contract_id:msg.contract_id,contract_type:"DIGITOVER",status:sold?"won":"open",buy_price:1,payout:1.95,current_spot:1000.5,entry_spot:1000.5,underlying_symbol:"R_50",is_sold:sold?1:0,profit:sold?0.95:0}, subscription:{id:"sp"+(++subSeq)} }); }
    else if (msg.forget) respond({ msg_type:"forget", forget:1 });
    else respond({ msg_type:"unknown" });
  }
  close() { this.readyState = 3; if (this.onclose) this.onclose({code:1000}); }
}

/* ---------------- page setup ---------------- */
const vc = new VirtualConsole();
const jsdomErrors = [];
vc.on("jsdomError", e => jsdomErrors.push(String((e && e.message) || e)));
vc.on("error", (...a) => jsdomErrors.push(a.join(" ")));

const dom = new JSDOM(html, {
  url: "http://localhost/?app=1",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.WebSocket = FakeWebSocket;
    window.fetch = () => Promise.reject(new Error("fetch disabled in test"));
  }
});
const { window } = dom;
const ev = (code) => window.eval(code);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 4000)) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}
function login() {
  ev(`state.auth = { loginid: "CR_TEST", is_virtual: true, currency: "USD", balance: 100 };
      state.token = "test-token"; state.balance = 100; state.currency = "USD";
      state.accountType = "demo";`);
}
let pushEpoch = 1700000100;
function seedDigits(sym, digits) {
  digits.forEach(d => {
    pushEpoch++;
    ev(`Markets.push(${JSON.stringify(sym)}, { epoch: ${pushEpoch}, quote: "1000.000${d}", symbol: ${JSON.stringify(sym)} });`);
  });
}

(async () => {
  await waitFor(() => ev("socket.ws && socket.ws.readyState") === 1, 8000);
  await sleep(150); // Let initial market subscriptions complete before stubbing the socket.
  login();
  ev(`window.requests = []; window.delayed = null;
    Markets.ensure = () => Promise.resolve();
    socket.request = (req) => {
      window.requests.push(req);
      if (req.proposal) return new Promise((resolve, reject) => { window.delayed = { resolve, reject }; });
      if (req.buy) return Promise.resolve({ buy: { contract_id: 123, buy_price: 2.5, payout: 4, longcode: 'test' } });
      return Promise.resolve({});
    };
    socket.stream = (key, req, handler) => { if (key === "dbotpoc") window.watchHandler = handler; return Promise.resolve(); }; socket.forget = () => {};
    openFreeBot('matchbot');
    state.market = 'R_100';
    document.getElementById('dbotsStake').value = '2.5';
    document.getElementById('dbotsStake').dispatchEvent(new Event('change'));
    document.getElementById('dbotsTP').value = '12';
    document.getElementById('dbotsTP').dispatchEvent(new Event('change'));
    document.getElementById('dbotsSL').value = '7';
    document.getElementById('dbotsSL').dispatchEvent(new Event('change'));
    window.originalId = DBots.selectedId;
    window.signal = {def: { type: 'DIGITMATCH', barrier: 8, label: 'Matches 8', id: 'M8' }, entry:true,
      trend:'flat', rate:15, delta:0, strength:'medium', why:'test'};
    state.signals = [window.signal]; renderSignalCards();`);
  check('entry is a real button', !!window.document.querySelector('button[data-act=runbot]'));
  check('wait is not a button', ev(`state.signals=[Object.assign({},signal,{entry:false})]; renderSignalCards(); !!document.querySelector('span.badge-entry.hold') && !document.querySelector('button[data-act=runbot]')`));
  ev('state.signals=[signal]; renderSignalCards()');
  window.document.querySelector('button[data-act=runbot]').click();
  check('redirects to DBots', ev('state.tab === "dbots"'));
  check('keeps configured bot identity', ev('DBots.selectedId === originalId'));
  check('preserves configured money settings', ev('DBots.stake === 2.5 && DBots.tp === 12 && DBots.sl === 7'));
  check('starts bot', ev('DBots.running'));
  check('locks before proposal', ev('DBots.busy && requests.length === 1'));
  check('uses signal type, barrier, scanned market and stake', ev(`requests[0].contract_type === 'DIGITMATCH' && requests[0].barrier === '8' && (requests[0].underlying_symbol || requests[0].symbol) === 'R_100' && requests[0].amount === '2.50'`));
  check('signal prediction is saved to bot', ev(`DBots.cfg.barrier === 8 && DBots.parse(DBots.selected().xml).barrier === 8 && DBots.purchaseContract === 'DIGITMATCH'`));
  ev(`openFreeBot('matches'); DBots.applyEdit('market','R_50'); DBots.remove(originalId)`);
  check('cannot replace, edit or remove an active bot', ev(`DBots.selectedId === originalId && DBots.selected() && DBots.cfg.market === 'R_100'`));
  ev('DBots.onTick("R_100"); runSignalBot(signal, null)');
  check('no competing tick or second click proposal', ev('requests.length === 1'));
  ev('delayed.resolve({proposal:{id:"q1",ask_price:2.5}})');
  await waitFor(() => ev('DBots.pending === 123'));
  check('one buy after quote', ev('requests.filter(x=>x.buy).length === 1 && DBots.pending === 123'));
  ev('DBots.stop("test")');
  check('stop retains signal contract tracking', ev('!DBots.running && DBots.pending === 123 && DBots.pendingSignal'));
  ev('DBots.start()');
  check('cannot restart with open signal contract', ev('!DBots.running && DBots.pending === 123'));
  ev(`watchHandler({proposal_open_contract:{contract_id:123,is_sold:1,profit:1.5,status:'won',buy_price:2.5,payout:4}})`);
  check('settlement unlocks stopped bot', ev('!DBots.running && DBots.pending == null && !DBots.pendingSignal'));
  ev('window.requests=[]');

  ev(`state.market='R_50'; runSignalBot(signal,null)`);
  check('market mismatch does not start or buy', ev('!DBots.running && requests.length===0 && DBots.selectedId===originalId'));
  ev(`state.market='R_100'; signal.def.type='DIGITDIFF'; runSignalBot(signal,null)`);
  check('wrong bot family does not start or replace bot', ev('!DBots.running && requests.length===0 && DBots.selectedId===originalId && state.tab === "freebots"'));

  ev(`signal.def.type='DIGITMATCH'; state.accountType='real'; runSignalBot(signal,null)`);
  check('real account confirmation opens before buy', ev('!DBots.running && requests.length===0 && !document.getElementById("modalBack").classList.contains("hidden")'));
  check('real confirmation names actual first signal', ev('document.getElementById("modalBody").textContent.includes("Matches 8") && document.getElementById("modalBody").textContent.includes("barrier 8")'));
  ev('closeModal(false)'); await sleep(20);
  check('cancelled confirmation never starts', ev('!DBots.running && !DBots.starting && requests.length===0'));
  ev('runSignalBot(signal,null)'); ev('closeModal(true)'); await sleep(20);
  check('confirmed real entry starts exactly one proposal', ev('DBots.running && requests.length===1 && DBots.busy'));
  ev('DBots.stop("before proposal"); delayed.resolve({proposal:{id:"q2",ask_price:2.5}})'); await sleep(20);
  check('stop before quote prevents buy', ev('requests.filter(x=>x.buy).length===0 && !DBots.busy && !DBots.running'));
  // Confirm the bot cannot be restarted while a sent buy is unresolved.
  ev(`state.accountType='demo'; window.requests=[];
    socket.request = req => { requests.push(req); if (req.proposal) return Promise.resolve({proposal:{id:'q3',ask_price:2.5}});
      if (req.buy) return new Promise(resolve => { window.delayedBuy=resolve; }); return Promise.resolve({}); };
    runSignalBot(signal,null);`);
  await waitFor(() => ev('typeof delayedBuy === "function"'));
  ev('DBots.stop("buy in flight"); DBots.start()');
  check('sent buy keeps restart locked', ev('DBots.busy && !DBots.running'));
  ev('delayedBuy({buy:{contract_id:456,buy_price:2.5,payout:4}})');
  await waitFor(() => ev('DBots.pending === 456'));
  check('late buy is tracked after stop', ev('DBots.pendingSignal && !DBots.running && DBots.pending===456'));
  ev('DBots.pending=null; DBots.pendingSignal=false; DBots.busy=false; window.requests=[]; state.accountType="real"; runSignalBot(signal,null)');
  ev(`DBots.selected().xml += ' '; closeModal(true)`); await sleep(20);
  check('changes during confirmation cancel start', ev('!DBots.running && requests.length===0'));
  ev(`state.accountType='demo'; DBots.selected().xml = DBots.selected().xml.trim(); window.requests=[];
    socket.request = req => { requests.push(req); return Promise.reject({message:'quote failed'}); };
    runSignalBot(signal,null)`);
  await sleep(20);
  check('quote failure stops bot without buying', ev('!DBots.running && !DBots.busy && requests.length===1 && !requests[0].buy'));
  ev(`window.requests=[]; openFreeBot('sample'); DBots.start()`);
  check('normal DBot run still starts without immediate buy', ev('DBots.running && requests.length===0'));
  ev(`DBots.stop("normal test"); openFreeBot('overunder'); state.market=DBots.cfg.market;
    signal.def={type:'DIGITUNDER',barrier:6,label:'Under 6'}; window.requests=[];
    socket.request=req=>{requests.push(req); if(req.proposal) return Promise.resolve({proposal:{id:'q4',ask_price:1}});
      if(req.buy) return Promise.resolve({buy:{contract_id:789,buy_price:1,payout:2}}); return Promise.resolve({});};
    socket.stream=()=>Promise.reject({message:'watch failed'}); runSignalBot(signal,null);`);
  await waitFor(() => ev('DBots.pending === 789 && !DBots.running'));
  check('Under signal uses selected Over/Under bot and signal barrier', ev(`requests[0].contract_type==='DIGITUNDER' && requests[0].barrier==='6' && DBots.purchaseContract==='DIGITUNDER'`));
  check('watch failure stops and locks the unknown contract', ev('!DBots.running && DBots.pending === 789 && DBots.pendingSignal'));
  ev('DBots.start()');
  check('watch failure blocks restart', ev('!DBots.running && DBots.pending === 789'));

  // Exercise the four signal-dependent bots through multiple settlements.
  ev(`DBots.pending=null; DBots.pendingSignal=false; DBots.busy=false;
    socket.stream=(key,req,handler)=>{if(key==='dbotpoc') window.watchHandler=handler; return Promise.resolve()};
    window.seq=1000; window.requests=[];
    socket.request=req=>{requests.push(req); if(req.proposal) return Promise.resolve({proposal:{id:'q'+seq,ask_price:Number(req.amount)}});
      if(req.buy) return Promise.resolve({buy:{contract_id:++seq,buy_price:2,payout:3}}); return Promise.resolve({});};`);
  const cases = [
    ['matchbot','DIGITMATCH',7], ['matches','DIGITDIFF',4],
    ['overunder','DIGITOVER',2], ['overunder','DIGITUNDER',6],
    ['evenodd','DIGITEVEN',null], ['evenodd','DIGITODD',null]
  ];
  let epoch=1900000000;
  for (const [kind,type,digit] of cases) {
    ev(`openFreeBot(${JSON.stringify(kind)}); DBots.applyEdit('market','R_50');
       document.getElementById('dbotsStake').value='2'; document.getElementById('dbotsStake').dispatchEvent(new Event('change'));
       document.getElementById('dbotsTP').value='20'; document.getElementById('dbotsTP').dispatchEvent(new Event('change'));
       document.getElementById('dbotsSL').value='20'; document.getElementById('dbotsSL').dispatchEvent(new Event('change'));
       DBots.applyEdit('martingale',true); DBots.applyEdit('multiplier',2); DBots.applyEdit('maxsteps',3);
       window.testId=DBots.selectedId; window.requests=[];`);
    ev('DBots.start()');
    check(`${type}: manual Run cannot start`, ev('!DBots.running && requests.length===0'));
    ev(`window.testSig={def:{type:${JSON.stringify(type)}, barrier:${JSON.stringify(digit)}, label:${JSON.stringify(type)}},entry:true,trend:'flat',rate:50,delta:0,strength:'weak',why:'test'};
       state.market='R_50'; state.signals=[testSig]; renderSignalCards(); document.querySelector('button[data-act=runbot]').click();`);
    await waitFor(()=>ev('DBots.pending != null'));
    check(`${type}: first trade uses entry and one-tick duration`, ev(`requests[0].contract_type===${JSON.stringify(type)} && requests[0].duration===1 && requests[0].duration_unit==='t' && (requests[0].underlying_symbol||requests[0].symbol)==='R_50' && requests[0].amount==='2.00' && ${digit === null ? "!('barrier' in requests[0])" : `requests[0].barrier==='${digit}' && DBots.cfg.barrier===${digit} && DBots.parse(DBots.selected().xml).barrier===${digit}`}`));
    check(`${type}: preserves money settings`, ev(`DBots.martingale && DBots.mult===2 && DBots.sl===20 && DBots.tp===20`));
    ev(`watchHandler({proposal_open_contract:{contract_id:DBots.pending,is_sold:1,profit:-1,status:'lost',buy_price:2,payout:0}})`);
    check(`${type}: losing trade advances martingale`, ev('DBots.running && DBots.nextStake===4'));
    // A tick should repeat the signal even when the legacy bot's own condition would not buy.
    ev(`DBots.fast=false; DBots.cooldownUntil=Date.now()+60000; Markets.push('R_50',{epoch:${++epoch},quote:'1000.0001',symbol:'R_50'});`);
    await waitFor(()=>ev("requests.some(x=>x.proposal && x.amount==='4.00') && DBots.pending != null"));
    check(`${type}: repeats signal without bot analysis or cooldown`, ev(`requests.filter(x=>x.proposal && x.amount==='4.00').some(x=>x.contract_type===${JSON.stringify(type)} && ${digit === null ? "!('barrier' in x)" : `x.barrier==='${digit}'`})`), ev('JSON.stringify(requests)'));
    ev(`watchHandler({proposal_open_contract:{contract_id:DBots.pending,is_sold:1,profit:21,status:'won',buy_price:4,payout:25}})`);
    check(`${type}: take profit stops continuous execution`, ev('!DBots.running && DBots.pending == null'));
    ev(`openFreeBot(${JSON.stringify(kind)})`);
    check(`${type}: reopening preserves bot and settings`, ev('DBots.selectedId===testId && Number(document.getElementById("dbotsStake").value)===2 && DBots.moneyFor(testId).martingale'));
  }
  ev(`state.market='R_50'; state.signalFamily='evenodd'; Markets.push('R_50',{epoch:${++epoch},quote:'1000.0001',symbol:'R_50'}); computeSignals()`);
  check('Even/Odd family displays two real signal cards', ev(`state.signals.length===2 && state.signals[0].def.type==='DIGITEVEN' && state.signals[1].def.type==='DIGITODD' && document.querySelectorAll('#signalCards .sig').length===2`));
  check('Even/Odd calculations use parity and 50 percent expectation', ev(`signalExpected({type:'DIGITODD'})===50 && digitWins({type:'DIGITODD'},7) && !digitWins({type:'DIGITODD'},8) && digitWins({type:'DIGITEVEN'},8)`));
  // Upgrade a saved legacy Narcissus that still contains the old analysis stacks.
  ev(`openFreeBot('matchbot'); window.legacy=DBots.selected();
    window.doc=new DOMParser().parseFromString(legacy.xml,'application/xml');
    Array.from(doc.documentElement.children).filter(x=>x.localName==='block' && ['before_purchase','during_purchase','after_purchase'].includes(x.getAttribute('type'))).forEach(x=>x.remove());
    window.oldDoc=new DOMParser().parseFromString('<xml xmlns="http://www.w3.org/1999/xhtml">'+DBots.templateLifecycle('sample')+'</xml>','application/xml');
    Array.from(oldDoc.documentElement.children).forEach(x=>doc.documentElement.appendChild(doc.importNode(x,true)));
    legacy.xml=new XMLSerializer().serializeToString(doc); delete legacy.signalVersion; delete legacy.signalBotKind;
    DBots.save(); window.oldId=legacy.id; window.oldMarket=DBots.parse(legacy.xml).market;`);
  ev(`openFreeBot('matchbot')`);
  check('legacy bot migration keeps its identity, market and risk settings', ev(`DBots.selectedId===oldId && DBots.cfg.market===oldMarket && DBots.moneyFor(oldId).martingale && DBots.selected().signalVersion===2`));
  check('legacy bot migration removes its analysis', ev(`DBots.cfg.trees.before.statements.BEFORE_PURCHASE_STACK.type==='purchase' && !DBots.cfg.trees.during`));
  ev(`state.market=oldMarket; window.requests=[]; window.stopSig={def:{type:'DIGITMATCH',barrier:7,label:'Matches 7'},entry:true,trend:'flat',rate:12,delta:0,strength:'weak',why:'test'};
      DBots.applyEdit('stoploss',1); runSignalBot(stopSig,null);`);
  await waitFor(()=>ev('DBots.pending != null'));
  ev(`watchHandler({proposal_open_contract:{contract_id:DBots.pending,is_sold:1,profit:-1,status:'lost',buy_price:2,payout:0}})`);
  check('stop loss stops the signal bot even with martingale enabled', ev('!DBots.running && DBots.pending==null'));
  ev(`DBots.save(); DBots.load(); DBots.loadMoneyStore(); openFreeBot('matchbot'); state.market='R_50';
    DBots.applyEdit('market','R_50'); window.requests=[]; state.signalFamily='matches';
    Markets.buf('R_50').ticks=[];
    for(let i=0;i<100;i++) Markets.push('R_50',{epoch:2000000000+i,quote:'1000.0007',symbol:'R_50'});
    computeSignals();`);
  check('reload keeps legacy bot and saved martingale settings', ev(`DBots.selectedId===oldId && DBots.moneyFor(oldId).martingale && DBots.selected().signalVersion===2`));
  check('live computed Matches 7 produces a clickable entry', ev(`state.signals.some(s=>s.def.id==='M7' && s.entry) && !!Array.from(document.querySelectorAll('button[data-act=runbot]')).find(b=>state.signals[Number(b.dataset.i)].def.id==='M7')`));
  ev(`window.requests=[]; Array.from(document.querySelectorAll('button[data-act=runbot]')).find(b=>state.signals[Number(b.dataset.i)].def.id==='M7').click()`);
  await waitFor(()=>ev('DBots.pending != null'));
  check('clicking computed Matches 7 actually buys and updates prediction', ev(`DBots.running && DBots.cfg.barrier===7 && requests.some(r=>r.proposal && r.contract_type==='DIGITMATCH' && r.barrier==='7' && (r.underlying_symbol||r.symbol)==='R_50')`));
  ev(`DBots.stop('test'); watchHandler({proposal_open_contract:{contract_id:DBots.pending,is_sold:1,profit:0,status:'won',buy_price:2,payout:2}})`);
  const errors=jsdomErrors.filter(m=>!/getContext|canvas|scrollTo/i.test(m));
  if(errors.length) console.log('jsdom errors:', errors.slice(0,5));
  console.log(`\n${passed} passed, ${failed} failed`); window.close(); process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(2)});
